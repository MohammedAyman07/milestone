import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchMilestoneReviewDetails,
  executeMilestoneDecision,
} from "@/lib/supabase/db";

// In-flight concurrency locks to prevent race conditions on the same milestone (TTL: 30s)
const activeDecisionLocks = new Map<string, number>();

function acquireDecisionLock(milestoneId: string): boolean {
  const now = Date.now();
  const existingTimestamp = activeDecisionLocks.get(milestoneId);
  if (existingTimestamp && now - existingTimestamp < 30000) {
    return false; // Lock active
  }
  activeDecisionLocks.set(milestoneId, now);
  return true;
}

function releaseDecisionLock(milestoneId: string): void {
  activeDecisionLocks.delete(milestoneId);
}

// Request validation schemas
const DecisionRequestSchema = z.object({
  milestoneId: z.string().min(1, "milestoneId is required"),
  submissionId: z.string().optional(),
  decision: z.enum(["approve", "request_revision", "reject"]),
  feedbackNotes: z.string().optional(),
  confirmed: z.boolean().optional(),
});

// Helper: Authenticate user from Supabase session or Bearer token
async function getAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    const admin = createAdminClient();
    if (admin) {
      const { data, error } = await admin.auth.getUser(token);
      if (!error && data?.user) {
        return data.user;
      }
    }
  }

  const supabase = await createServerSupabaseClient();
  if (supabase) {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user) {
      return data.user;
    }
  }

  return null;
}

// GET: Fetch authoritative review details for a milestone
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to review milestone deliverables." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const milestoneId = searchParams.get("milestoneId");

    if (!milestoneId) {
      return NextResponse.json(
        { error: "Query parameter 'milestoneId' is required." },
        { status: 400 }
      );
    }

    const details = await fetchMilestoneReviewDetails(milestoneId, user.id);
    return NextResponse.json(details, { status: details.statusCode });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error in GET /api/milestones/decision:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST: Execute authoritative client milestone decision
export async function POST(req: NextRequest) {
  let milestoneIdForLock: string | null = null;

  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to make milestone review decisions." },
        { status: 401 }
      );
    }

    // 2. Parse and validate request body
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    const parsed = DecisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request parameters.",
          details: parsed.error.format(),
        },
        { status: 400 }
      );
    }

    const { milestoneId, submissionId, decision, feedbackNotes, confirmed } = parsed.data;
    milestoneIdForLock = milestoneId;

    // 3. Acquire in-flight decision lock
    if (!acquireDecisionLock(milestoneId)) {
      return NextResponse.json(
        {
          error: "Concurrent Request: A decision is currently in progress for this milestone. Please wait.",
          retryable: true,
        },
        { status: 409 }
      );
    }

    // 4. Execute authoritative decision
    const result = await executeMilestoneDecision({
      milestoneId,
      submissionId,
      userId: user.id,
      decision,
      feedbackNotes,
      confirmed,
    });

    return NextResponse.json(result, { status: result.statusCode });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error in POST /api/milestones/decision:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (milestoneIdForLock) {
      releaseDecisionLock(milestoneIdForLock);
    }
  }
}
