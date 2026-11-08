import { NextRequest, NextResponse } from "next/server";
import { fetchProjectsFromDb, createProjectInDb, createMilestoneInDb } from "@/lib/supabase/db";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// In-flight concurrency locks to prevent duplicate submissions per client (TTL: 10s)
const activeCreationLocks = new Map<string, number>();

function acquireCreationLock(key: string): boolean {
  const now = Date.now();
  const lockedAt = activeCreationLocks.get(key);
  if (lockedAt && now - lockedAt < 10000) {
    return false; // Still locked
  }
  activeCreationLocks.set(key, now);
  return true;
}

function releaseCreationLock(key: string): void {
  activeCreationLocks.delete(key);
}

// Helper: Authenticate user from Supabase session cookies or Bearer Authorization header
async function getAuthenticatedUser(req: NextRequest): Promise<{ id: string; email?: string } | null> {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const admin = createAdminClient();
    if (admin) {
      const { data, error } = await admin.auth.getUser(token);
      if (!error && data?.user) {
        return { id: data.user.id, email: data.user.email };
      }
    }
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseAnonKey) {
      const { createClient } = await import("@supabase/supabase-js");
      const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } });
      const { data, error } = await anon.auth.getUser(token);
      if (!error && data?.user) {
        return { id: data.user.id, email: data.user.email };
      }
    }
  }

  const supabase = await createServerSupabaseClient();
  if (supabase) {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user) {
      return { id: data.user.id, email: data.user.email };
    }
  }

  return null;
}

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("id");

    const result = await fetchProjectsFromDb(user?.id, projectId || undefined);
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error, isFallback: true },
        { status: 200 }
      );
    }

    if (projectId) {
      const project = result.projects.find((p) => p.id === projectId);
      if (!project) {
        return NextResponse.json({ success: false, error: "Project not found." }, { status: 404 });
      }
      return NextResponse.json({ success: true, project });
    }

    return NextResponse.json({ success: true, projects: result.projects });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let lockKey: string | null = null;

  try {
    // 1. Authenticate user from session or Bearer token
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to perform project mutations." },
        { status: 401 }
      );
    }

    // 2. Verify user role in database (Must be 'client' to create projects)
    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ error: "Database configuration error." }, { status: 500 });
    }

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .single();

    if (profileErr || !profile) {
      return NextResponse.json(
        { error: "Authenticated profile not found in database." },
        { status: 403 }
      );
    }

    if (profile.role !== "client") {
      return NextResponse.json(
        { error: "Security Violation: Only clients can create projects. Freelancer accounts are restricted from project creation." },
        { status: 403 }
      );
    }

    // 3. Parse request payload
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    const { action, projectData, milestoneData } = body;

    // -------------------------------------------------------------------------
    // ACTION: create_project
    // -------------------------------------------------------------------------
    if (action === "create_project") {
      if (!projectData || typeof projectData !== "object") {
        return NextResponse.json({ error: "Missing 'projectData' in request payload." }, { status: 400 });
      }

      const title = typeof projectData.title === "string" ? projectData.title.trim() : "";
      const description = typeof projectData.description === "string" ? projectData.description.trim() : "";
      const budget = parseFloat(projectData.budget);
      const currency = projectData.currency ? String(projectData.currency).trim().toUpperCase() : "USD";
      const startDate = projectData.startDate ? String(projectData.startDate).trim() : new Date().toISOString();
      const deadline = projectData.deadline ? String(projectData.deadline).trim() : "";

      // Validation: Title & Description
      if (!title) {
        return NextResponse.json({ error: "Project title is required." }, { status: 400 });
      }
      if (!description) {
        return NextResponse.json({ error: "Project description is required." }, { status: 400 });
      }

      // Validation: Financial budget & currency
      if (isNaN(budget) || budget <= 0) {
        return NextResponse.json({ error: "Total project budget must be a positive number greater than 0." }, { status: 400 });
      }
      if (currency !== "USD") {
        return NextResponse.json({ error: "Currency Violation: Only 'USD' is supported." }, { status: 400 });
      }

      // Validation: Deadlines
      if (!deadline || isNaN(Date.parse(deadline))) {
        return NextResponse.json({ error: "A valid target deadline is required." }, { status: 400 });
      }
      if (startDate && Date.parse(deadline) < Date.parse(startDate)) {
        return NextResponse.json({ error: "Deadline cannot be earlier than project start date." }, { status: 400 });
      }

      // Duplicate submission protection (in-flight lock)
      lockKey = `${user.id}:${title.toLowerCase()}`;
      if (!acquireCreationLock(lockKey)) {
        return NextResponse.json(
          { error: "Duplicate submission: A project creation request with this title is already in progress. Please wait." },
          { status: 409 }
        );
      }

      // Resolve Freelancer Counterparty
      let freelancerId: string | null = null;
      if (projectData.freelancerId && typeof projectData.freelancerId === "string") {
        const { data: fProfile } = await admin
          .from("profiles")
          .select("id, role")
          .eq("id", projectData.freelancerId.trim())
          .maybeSingle();

        if (fProfile) {
          freelancerId = fProfile.id;
        } else {
          releaseCreationLock(lockKey);
          return NextResponse.json({ error: "Specified freelancer ID does not exist in the database." }, { status: 400 });
        }
      } else if (projectData.freelancerEmail && typeof projectData.freelancerEmail === "string") {
        const emailTrim = projectData.freelancerEmail.trim().toLowerCase();
        const { data: fProfile } = await admin
          .from("profiles")
          .select("id, role")
          .eq("email", emailTrim)
          .maybeSingle();

        if (fProfile) {
          freelancerId = fProfile.id;
        } else {
          // Check for any registered freelancer profile in the system to assign
          const { data: defaultFree } = await admin
            .from("profiles")
            .select("id")
            .eq("role", "freelancer")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

          if (defaultFree) {
            freelancerId = defaultFree.id;
          }
        }
      }

      if (!freelancerId) {
        releaseCreationLock(lockKey);
        return NextResponse.json(
          { error: "Freelancer Assignment Required: A valid freelancer profile must be assigned to the project." },
          { status: 400 }
        );
      }

      // Counterparty role check: Client cannot be their own freelancer
      if (freelancerId === user.id) {
        releaseCreationLock(lockKey);
        return NextResponse.json(
          { error: "Security Violation: A client cannot assign their own account as the freelancer counterparty." },
          { status: 400 }
        );
      }

      // Validate initial milestones if provided
      const rawMilestones = Array.isArray(projectData.initialMilestones) ? projectData.initialMilestones : [];
      let totalMilestoneAllocated = 0;
      const validatedMilestones = [];

      for (let i = 0; i < rawMilestones.length; i++) {
        const m = rawMilestones[i];
        const mTitle = typeof m.title === "string" ? m.title.trim() : "";
        const mAmount = parseFloat(m.amount);
        const mDueDate = m.dueDate ? String(m.dueDate).trim() : "";

        if (!mTitle) {
          releaseCreationLock(lockKey);
          return NextResponse.json({ error: `Milestone ${i + 1} title is required.` }, { status: 400 });
        }

        if (isNaN(mAmount) || mAmount <= 0) {
          releaseCreationLock(lockKey);
          return NextResponse.json({ error: `Milestone ${i + 1} amount must be a positive number greater than 0.` }, { status: 400 });
        }

        if (!mDueDate || isNaN(Date.parse(mDueDate))) {
          releaseCreationLock(lockKey);
          return NextResponse.json({ error: `Milestone ${i + 1} target due date is required.` }, { status: 400 });
        }

        totalMilestoneAllocated += mAmount;

        // Process criteria
        let rawCriteria = m.criteria || m.acceptanceCriteria || [];
        if (typeof rawCriteria === "string") {
          rawCriteria = rawCriteria.split("\n").map((c: string) => c.trim()).filter(Boolean);
        }

        const criteriaList = (Array.isArray(rawCriteria) ? rawCriteria : []).map((c: any, cIdx: number) => {
          if (typeof c === "string") {
            return { code: `AC-${cIdx + 1}`, label: c, description: c };
          }
          return {
            code: c.code || `AC-${cIdx + 1}`,
            label: c.label || c.description || `Criterion ${cIdx + 1}`,
            description: c.description || c.label || null,
          };
        });

        if (criteriaList.length === 0) {
          releaseCreationLock(lockKey);
          return NextResponse.json(
            { error: `Milestone ${i + 1} must include at least one measurable acceptance criterion.` },
            { status: 400 }
          );
        }

        validatedMilestones.push({
          phase: i + 1,
          title: mTitle,
          description: m.description ? String(m.description).trim() : "Initial deliverable contract scope.",
          amount: mAmount,
          currency: "USD",
          dueDate: mDueDate,
          criteria: criteriaList,
        });
      }

      // Financial Ceiling Check: Milestones cannot exceed total project budget
      if (totalMilestoneAllocated > budget) {
        releaseCreationLock(lockKey);
        return NextResponse.json(
          {
            error: `Financial Limit Exceeded: Total milestone allocations ($${totalMilestoneAllocated.toFixed(
              2
            )}) exceed project budget ($${budget.toFixed(2)}).`,
          },
          { status: 400 }
        );
      }

      // Persist project and milestones to Supabase
      const result = await createProjectInDb({
        title,
        description,
        budget,
        currency: "USD",
        startDate,
        deadline,
        clientId: user.id, // Strictly server-authoritative
        freelancerId,
        initialMilestones: validatedMilestones,
      });

      releaseCreationLock(lockKey);
      lockKey = null;

      if (!result.success) {
        return NextResponse.json({ error: result.error || "Failed to create project in database." }, { status: 400 });
      }

      return NextResponse.json(
        {
          success: true,
          projectId: result.projectId,
          project: result.project,
        },
        { status: 201 }
      );
    }

    // -------------------------------------------------------------------------
    // ACTION: create_milestone
    // -------------------------------------------------------------------------
    if (action === "create_milestone") {
      if (!milestoneData || typeof milestoneData !== "object") {
        return NextResponse.json({ error: "Missing 'milestoneData' in request payload." }, { status: 400 });
      }

      const { projectId, amount, title, dueDate, criteria } = milestoneData;
      if (!projectId) {
        return NextResponse.json({ error: "projectId is required." }, { status: 400 });
      }

      // Verify project ownership
      const { data: proj, error: projErr } = await admin
        .from("projects")
        .select("id, client_id, budget")
        .eq("id", projectId)
        .single();

      if (projErr || !proj) {
        return NextResponse.json({ error: "Project not found." }, { status: 404 });
      }

      if (proj.client_id !== user.id) {
        return NextResponse.json(
          { error: "Forbidden: Only the project client can create milestones for this project." },
          { status: 403 }
        );
      }

      const mAmount = parseFloat(amount);
      if (isNaN(mAmount) || mAmount <= 0) {
        return NextResponse.json({ error: "Milestone amount must be a positive number greater than 0." }, { status: 400 });
      }

      const result = await createMilestoneInDb(milestoneData);
      if (!result.success) {
        return NextResponse.json({ error: result.error || "Failed to create milestone." }, { status: 400 });
      }

      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid action. Supported actions: 'create_project', 'create_milestone'." }, { status: 400 });
  } catch (err: unknown) {
    if (lockKey) {
      releaseCreationLock(lockKey);
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("Error in POST /api/projects:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
