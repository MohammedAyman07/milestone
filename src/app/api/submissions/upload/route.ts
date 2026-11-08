import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadEvidenceFile } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

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

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to upload deliverable evidence." },
        { status: 401 }
      );
    }

    // 2. Verify user role (Must be 'freelancer')
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
      return NextResponse.json({ error: "Authenticated user profile not found." }, { status: 403 });
    }

    if (profile.role !== "freelancer") {
      return NextResponse.json(
        { error: "Security Violation: Only assigned freelancers can upload deliverable evidence. Client accounts are restricted from file submission." },
        { status: 403 }
      );
    }

    // 3. Pre-flight content-length check (Max 10MB)
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Payload too large. Deliverable evidence files cannot exceed the 10 MB maximum limit." },
        { status: 422 }
      );
    }

    // 4. Parse Multipart Form Data
    const formData = await req.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ error: "Invalid form data. Expected multipart/form-data upload." }, { status: 400 });
    }

    const file = formData.get("file") as File | null;
    const projectId = formData.get("projectId") as string | null;
    const milestoneId = formData.get("milestoneId") as string | null;
    const description = (formData.get("description") as string | null) || undefined;

    if (!file || !projectId || !milestoneId) {
      return NextResponse.json(
        { error: "Missing required fields: 'file', 'projectId', and 'milestoneId' are mandatory." },
        { status: 400 }
      );
    }

    // 4. Verify Project Ownership and Freelancer Assignment
    const { data: project, error: projErr } = await admin
      .from("projects")
      .select("id, client_id, freelancer_id")
      .eq("id", projectId.trim())
      .single();

    if (projErr || !project) {
      return NextResponse.json({ error: "Associated project not found." }, { status: 404 });
    }

    if (project.freelancer_id !== user.id) {
      return NextResponse.json(
        { error: "Forbidden: You are not the assigned freelancer for this project." },
        { status: 403 }
      );
    }

    // 5. Verify Milestone Linkage
    const { data: milestone, error: mErr } = await admin
      .from("milestones")
      .select("id, project_id, status")
      .eq("id", milestoneId.trim())
      .single();

    if (mErr || !milestone) {
      return NextResponse.json({ error: "Referenced milestone not found." }, { status: 404 });
    }

    if (milestone.project_id !== project.id) {
      return NextResponse.json(
        { error: "Validation Error: Milestone does not belong to the specified project." },
        { status: 400 }
      );
    }

    // 6. Read file buffer
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    // 7. Execute validated secure upload to private bucket
    const uploadResult = await uploadEvidenceFile(
      fileBuffer,
      file.name,
      file.type || "application/octet-stream",
      project.id,
      milestone.id,
      description
    );

    if (!uploadResult.success || !uploadResult.data) {
      return NextResponse.json(
        { error: uploadResult.error || "File upload to private storage failed." },
        { status: 422 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        file: {
          name: uploadResult.data.name,
          sizeBytes: uploadResult.data.sizeBytes,
          mimeType: uploadResult.data.mimeType,
          storagePath: uploadResult.data.path,
          signedUrl: uploadResult.data.signedUrl,
          description: uploadResult.data.description,
        },
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("Error in POST /api/submissions/upload:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
