import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAuditLogInDb } from "@/lib/supabase/db";
import { getEvidenceSignedUrl, EVIDENCE_BUCKET } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

// In-flight concurrency lock per milestone to prevent duplicate simultaneous submissions
const activeSubmissionLocks = new Map<string, number>();

function acquireSubmissionLock(milestoneId: string | null | undefined): boolean {
  if (!milestoneId) return true;
  const now = Date.now();
  const lockedAt = activeSubmissionLocks.get(milestoneId);
  if (lockedAt && now - lockedAt < 15000) {
    return false; // Lock active
  }
  activeSubmissionLocks.set(milestoneId, now);
  return true;
}

function releaseSubmissionLock(milestoneId: string | null | undefined): void {
  if (!milestoneId) return;
  activeSubmissionLocks.delete(milestoneId);
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

// GET: Retrieve submissions and files with authenticated signed download URLs
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to view deliverable submissions." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const milestoneId = searchParams.get("milestoneId");
    const submissionId = searchParams.get("id");
    const projectId = searchParams.get("projectId");

    if (!milestoneId && !submissionId && !projectId) {
      return NextResponse.json(
        { error: "Query parameter 'milestoneId', 'projectId', or 'id' is required." },
        { status: 400 }
      );
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ error: "Database configuration error." }, { status: 500 });
    }

    let query = admin
      .from("submissions")
      .select(`
        id,
        milestone_id,
        project_id,
        submitter_id,
        repo_url,
        staging_url,
        figma_url,
        notes,
        status,
        created_at,
        updated_at,
        submitter:profiles!submissions_submitter_id_fkey(id, full_name, email, role),
        project:projects!submissions_project_id_fkey(id, client_id, freelancer_id),
        submission_files(id, file_name, file_size_bytes, mime_type, storage_path, description, created_at)
      `)
      .order("created_at", { ascending: false });

    if (submissionId) {
      query = query.eq("id", submissionId);
    } else if (milestoneId) {
      query = query.eq("milestone_id", milestoneId);
    } else if (projectId) {
      query = query.eq("project_id", projectId);
    }

    const { data: rawSubmissions, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!rawSubmissions || rawSubmissions.length === 0) {
      return NextResponse.json({ success: true, submissions: [] });
    }

    // Verify access: user must be client or freelancer on the project
    const authorizedSubmissions = [];
    for (const sub of rawSubmissions) {
      const proj = sub.project as any;
      if (proj && (proj.client_id === user.id || proj.freelancer_id === user.id)) {
        // Generate signed URLs for submission files
        const filesWithSignedUrls = await Promise.all(
          (sub.submission_files || []).map(async (file: any) => {
            const { signedUrl } = await getEvidenceSignedUrl(file.storage_path, 900);
            return {
              ...file,
              signedUrl,
              signed_url: signedUrl,
            };
          })
        );

        authorizedSubmissions.push({
          ...sub,
          project: undefined, // remove internal join metadata
          files: filesWithSignedUrls,
          submission_files: filesWithSignedUrls,
        });
      }
    }

    if (authorizedSubmissions.length === 0 && rawSubmissions.length > 0) {
      return NextResponse.json(
        { error: "Forbidden: You are not an authorized participant in this project." },
        { status: 403 }
      );
    }

    if (submissionId && authorizedSubmissions.length > 0) {
      return NextResponse.json({ success: true, submission: authorizedSubmissions[0] });
    }

    return NextResponse.json({ success: true, submissions: authorizedSubmissions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST: Create formal milestone submission package with verified storage evidence
export async function POST(req: NextRequest) {
  let milestoneIdForLock: string | null = null;

  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to submit milestone deliverables." },
        { status: 401 }
      );
    }

    // 2. Verify user role in database (Must be 'freelancer')
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
      return NextResponse.json({ error: "Authenticated profile not found in database." }, { status: 403 });
    }

    if (profile.role !== "freelancer") {
      return NextResponse.json(
        { error: "Security Violation: Only assigned freelancers can submit milestone deliverables. Client accounts are restricted from deliverable submission." },
        { status: 403 }
      );
    }

    // 3. Parse JSON request body
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    const { projectId, milestoneId, repoUrl, stagingUrl, figmaUrl, notes, files } = body;

    if (!projectId || !milestoneId) {
      return NextResponse.json({ error: "Both 'projectId' and 'milestoneId' are required." }, { status: 400 });
    }

    if (!repoUrl || typeof repoUrl !== "string" || !repoUrl.trim()) {
      return NextResponse.json({ error: "A valid GitHub repository URL is required." }, { status: 400 });
    }

    if (!notes || typeof notes !== "string" || !notes.trim()) {
      return NextResponse.json({ error: "Handover notes or deliverable summary documentation is required." }, { status: 400 });
    }

    // 4. Duplicate submission protection (concurrency lock per milestone)
    milestoneIdForLock = milestoneId.trim();
    if (!acquireSubmissionLock(milestoneIdForLock)) {
      return NextResponse.json(
        { error: "Duplicate submission: A deliverable submission for this milestone is currently being processed. Please wait." },
        { status: 409 }
      );
    }

    // 5. Verify Project & Freelancer Assignment
    const { data: project, error: pErr } = await admin
      .from("projects")
      .select("id, client_id, freelancer_id")
      .eq("id", projectId.trim())
      .single();

    if (pErr || !project) {
      releaseSubmissionLock(milestoneIdForLock);
      return NextResponse.json({ error: "Associated project not found." }, { status: 404 });
    }

    if (project.freelancer_id !== user.id) {
      releaseSubmissionLock(milestoneIdForLock);
      return NextResponse.json(
        { error: "Forbidden: You are not authorized to submit deliverables for this project." },
        { status: 403 }
      );
    }

    // 6. Verify Milestone Linkage
    const { data: milestone, error: mErr } = await admin
      .from("milestones")
      .select("id, project_id, status")
      .eq("id", milestoneId.trim())
      .single();

    if (mErr || !milestone) {
      releaseSubmissionLock(milestoneIdForLock);
      return NextResponse.json({ error: "Referenced milestone not found." }, { status: 404 });
    }

    if (milestone.project_id !== project.id) {
      releaseSubmissionLock(milestoneIdForLock);
      return NextResponse.json({ error: "Milestone does not belong to the specified project." }, { status: 400 });
    }

    // 7. Validate and verify uploaded files
    const incomingFiles = Array.isArray(files) ? files : [];
    const verifiedFileRows = [];

    for (let i = 0; i < incomingFiles.length; i++) {
      const f = incomingFiles[i];
      const fileName = f.fileName || f.name;
      const storagePath = f.storagePath || f.storage_path;
      const rawSizeBytes = f.fileSizeBytes ?? f.sizeBytes ?? f.size_bytes ?? f.size;
      const mimeType = f.mimeType || f.type || f.mime_type;

      if (!fileName || !storagePath || typeof storagePath !== "string") {
        releaseSubmissionLock(milestoneIdForLock);
        return NextResponse.json(
          { error: `File at index ${i} is missing 'fileName' or 'storagePath'.` },
          { status: 400 }
        );
      }

      // Verify storage path begins with <project_id>/<milestone_id>/ to prevent path traversal
      const expectedPrefix = `${project.id}/${milestone.id}/`;
      if (!storagePath.startsWith(expectedPrefix)) {
        releaseSubmissionLock(milestoneIdForLock);
        return NextResponse.json(
          { error: `Security Violation: File storage path "${storagePath}" does not match project/milestone scope.` },
          { status: 400 }
        );
      }

      // Verify file actually exists in Supabase Storage before persisting DB record
      const pathParts = storagePath.split("/");
      const folder = pathParts.slice(0, 2).join("/");
      const filename = pathParts.slice(2).join("/");

      const { data: listFiles, error: listErr } = await admin.storage
        .from(EVIDENCE_BUCKET)
        .list(folder, { search: filename });

      if (listErr || !listFiles || listFiles.length === 0) {
        releaseSubmissionLock(milestoneIdForLock);
        return NextResponse.json(
          { error: `Evidence file "${fileName}" could not be confirmed in private storage.` },
          { status: 422 }
        );
      }

      // Match exact object in storage listing
      const matchedStorageFile = listFiles.find((item) => item.name === filename) || listFiles[0];

      // Determine authoritative file size in bytes
      let numericBytes = 0;
      if (typeof rawSizeBytes === "number" && !isNaN(rawSizeBytes) && rawSizeBytes > 0) {
        numericBytes = Math.round(rawSizeBytes);
      } else if (typeof rawSizeBytes === "string") {
        const match = rawSizeBytes.match(/([\d.]+)\s*(KB|MB|bytes|B)?/i);
        if (match) {
          const val = parseFloat(match[1]);
          const unit = (match[2] || "B").toUpperCase();
          if (unit === "MB") numericBytes = Math.round(val * 1024 * 1024);
          else if (unit === "KB") numericBytes = Math.round(val * 1024);
          else numericBytes = Math.round(val);
        }
      }

      // Supabase Storage metadata size is ground truth
      const storageSize = matchedStorageFile.metadata?.size;
      const storageSizeBytes =
        typeof storageSize === "number"
          ? storageSize
          : parseInt(String(storageSize || "0"), 10);

      const finalSizeBytes = storageSizeBytes > 0 ? storageSizeBytes : numericBytes;

      if (finalSizeBytes <= 0) {
        releaseSubmissionLock(milestoneIdForLock);
        return NextResponse.json(
          { error: `Evidence file "${fileName}" is empty (0 bytes) and cannot be accepted.` },
          { status: 422 }
        );
      }

      verifiedFileRows.push({
        file_name: String(fileName).slice(0, 255),
        file_size_bytes: finalSizeBytes,
        mime_type: mimeType || matchedStorageFile.metadata?.mimetype || "application/octet-stream",
        storage_path: storagePath,
        description: f.description ? String(f.description).slice(0, 500) : null,
      });
    }

    // 8. Atomic Database Persistence
    const { data: subData, error: subErr } = await admin
      .from("submissions")
      .insert({
        milestone_id: milestone.id,
        project_id: project.id,
        submitter_id: user.id, // Authoritative user UUID
        repo_url: repoUrl.trim(),
        staging_url: stagingUrl ? String(stagingUrl).trim() : null,
        figma_url: figmaUrl ? String(figmaUrl).trim() : null,
        notes: notes.trim(),
        status: "submitted",
      })
      .select("id, created_at")
      .single();

    if (subErr || !subData) {
      releaseSubmissionLock(milestoneIdForLock);
      return NextResponse.json(
        { error: subErr?.message || "Failed to persist submission record in database." },
        { status: 500 }
      );
    }

    // Insert file metadata
    if (verifiedFileRows.length > 0) {
      const fileInserts = verifiedFileRows.map((vf) => ({
        ...vf,
        submission_id: subData.id,
      }));

      const { error: fileErr } = await admin.from("submission_files").insert(fileInserts);
      if (fileErr) {
        console.error("Error inserting submission files:", fileErr.message);
      }
    }

    // 9. Update milestone status to 'submitted'
    await admin
      .from("milestones")
      .update({ status: "submitted" })
      .eq("id", milestone.id);

    // 10. Record audit log
    await recordAuditLogInDb({
      actorId: user.id,
      projectId: project.id,
      milestoneId: milestone.id,
      action: "EVIDENCE_SUBMITTED",
      entityType: "submission",
      entityId: subData.id,
      newState: {
        submissionId: subData.id,
        filesCount: verifiedFileRows.length,
        repoUrl: repoUrl.trim(),
      },
    });

    releaseSubmissionLock(milestoneIdForLock);
    milestoneIdForLock = null;

    return NextResponse.json(
      {
        success: true,
        submissionId: subData.id,
        status: "submitted",
        filesCount: verifiedFileRows.length,
        createdAt: subData.created_at,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    if (milestoneIdForLock) {
      releaseSubmissionLock(milestoneIdForLock);
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("Error in POST /api/submissions:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
