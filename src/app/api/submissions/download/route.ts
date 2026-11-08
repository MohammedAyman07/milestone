import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEvidenceSignedUrl, downloadEvidenceFile } from "@/lib/supabase/storage";

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

export async function GET(req: NextRequest) {
  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to download evidence files." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get("fileId");
    const storagePath = searchParams.get("path");
    const directDownload = searchParams.get("download") === "true";

    if (!fileId && !storagePath) {
      return NextResponse.json(
        { error: "Query parameter 'fileId' or 'path' is required." },
        { status: 400 }
      );
    }

    if (storagePath && (storagePath.includes("..") || storagePath.startsWith("/") || storagePath.includes("\\"))) {
      return NextResponse.json(
        { error: "Invalid storage path: Path traversal characters are strictly forbidden." },
        { status: 400 }
      );
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ error: "Database configuration error." }, { status: 500 });
    }

    let resolvedPath = storagePath;
    let fileName = "evidence_file";
    let mimeType = "application/octet-stream";

    // If fileId is provided, look up the record in submission_files
    if (fileId) {
      const { data: fileRow, error: fErr } = await admin
        .from("submission_files")
        .select(`
          id,
          file_name,
          storage_path,
          mime_type,
          submission:submissions!submission_files_submission_id_fkey(
            project_id,
            project:projects!submissions_project_id_fkey(client_id, freelancer_id)
          )
        `)
        .eq("id", fileId.trim())
        .single();

      if (fErr || !fileRow) {
        return NextResponse.json({ error: "Evidence file record not found." }, { status: 404 });
      }

      const proj = (fileRow.submission as any)?.project;
      if (!proj || (proj.client_id !== user.id && proj.freelancer_id !== user.id)) {
        return NextResponse.json(
          { error: "Forbidden: You are not an authorized participant in this project." },
          { status: 403 }
        );
      }

      resolvedPath = fileRow.storage_path;
      fileName = fileRow.file_name;
      mimeType = fileRow.mime_type;
    } else if (storagePath) {
      // Validate path format: <project_id>/<milestone_id>/<filename>
      const parts = storagePath.trim().split("/");
      if (parts.length < 3) {
        return NextResponse.json({ error: "Invalid storage path format." }, { status: 400 });
      }

      const targetProjectId = parts[0];
      const { data: project, error: pErr } = await admin
        .from("projects")
        .select("id, client_id, freelancer_id")
        .eq("id", targetProjectId)
        .single();

      if (pErr || !project) {
        return NextResponse.json({ error: "Associated project not found." }, { status: 404 });
      }

      if (project.client_id !== user.id && project.freelancer_id !== user.id) {
        return NextResponse.json(
          { error: "Forbidden: You are not an authorized participant in this project." },
          { status: 403 }
        );
      }

      resolvedPath = storagePath.trim();
      fileName = parts[parts.length - 1];
    }

    if (!resolvedPath) {
      return NextResponse.json({ error: "Unable to resolve storage path." }, { status: 400 });
    }

    // Direct binary download stream
    if (directDownload) {
      const { data: buffer, error: downErr } = await downloadEvidenceFile(resolvedPath);
      if (downErr || !buffer) {
        return NextResponse.json({ error: downErr || "Failed to download file from storage." }, { status: 502 });
      }

      return new NextResponse(buffer as any, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
        },
      });
    }

    // Generate short-lived signed URL (15 minutes expiry)
    const { signedUrl, error: signErr } = await getEvidenceSignedUrl(resolvedPath, 900);
    if (signErr || !signedUrl) {
      return NextResponse.json({ error: signErr || "Failed to generate signed download URL." }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      fileName,
      storagePath: resolvedPath,
      signedUrl,
      expiresInSeconds: 900,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
