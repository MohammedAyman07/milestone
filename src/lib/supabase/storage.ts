import { createServerSupabaseClient } from "./server";
import { createAdminClient } from "./admin";
import { ALLOWED_EXTENSIONS, DISALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "../evidence-validator";

export const EVIDENCE_BUCKET = "milestone-evidence";

export interface StoredEvidenceFile {
  path: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  signedUrl?: string;
  description?: string;
}

// Map of allowed extensions to valid MIME type prefixes/patterns
const ALLOWED_MIME_PATTERNS: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".json": ["application/json", "text/json", "text/plain"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain", "text/x-markdown"],
  ".csv": ["text/csv", "application/csv", "text/plain"],
  ".html": ["text/html"],
  ".xml": ["application/xml", "text/xml"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".svg": ["image/svg+xml"],
};

export async function uploadEvidenceFile(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  projectId: string,
  milestoneId: string,
  description?: string
): Promise<{ success: boolean; data?: StoredEvidenceFile; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { success: false, error: "Supabase client is not configured." };
  }

  // 1. File size validation (Strict 10 MB per file limit)
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    return {
      success: false,
      error: `File size limit exceeded: ${(fileBuffer.length / (1024 * 1024)).toFixed(
        2
      )} MB exceeds maximum allowed limit of 10 MB.`,
    };
  }

  if (fileBuffer.length === 0) {
    return {
      success: false,
      error: "Empty file cannot be uploaded as evidence deliverable.",
    };
  }

  // 2. Extension validation
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (DISALLOWED_EXTENSIONS.includes(ext)) {
    return {
      success: false,
      error: `Executable and script files ("${ext}") are strictly forbidden for security reasons.`,
    };
  }

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      success: false,
      error: `Unsupported evidence file format "${ext}". Supported formats: ${ALLOWED_EXTENSIONS.join(
        ", "
      )}`,
    };
  }

  // 3. MIME type validation against extension
  const expectedMimes = ALLOWED_MIME_PATTERNS[ext];
  const normalizedMime = mimeType.toLowerCase().split(";")[0].trim();
  if (expectedMimes && !expectedMimes.includes(normalizedMime) && normalizedMime !== "application/octet-stream") {
    return {
      success: false,
      error: `MIME type mismatch: declared type "${mimeType}" is not valid for extension "${ext}".`,
    };
  }

  // 4. Generate unpredictable unique storage path (incorporates random UUID)
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const randomSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const storagePath = `${projectId}/${milestoneId}/${Date.now()}_${randomSuffix}_${sanitizedName}`;

  // 5. Upload to private bucket
  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: normalizedMime,
      upsert: false,
    });

  if (error || !data) {
    return { success: false, error: error?.message || "Storage upload failed." };
  }

  // 6. Generate signed URL for authenticated verification/display (15 minutes expiry)
  const { data: signedData } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(data.path, 900);

  return {
    success: true,
    data: {
      path: data.path,
      name: fileName,
      sizeBytes: fileBuffer.length,
      mimeType: normalizedMime,
      signedUrl: signedData?.signedUrl,
      description,
    },
  };
}

// Generate short-lived authenticated signed download URL (default 15 minutes expiry)
export async function getEvidenceSignedUrl(
  storagePath: string,
  expiresInSeconds: number = 900
): Promise<{ signedUrl?: string; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { error: "Supabase client is not configured." };
  }

  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data) {
    return { error: error?.message || "Failed to generate signed download URL." };
  }

  return { signedUrl: data.signedUrl };
}

// Download raw file buffer directly from private Supabase Storage
export async function downloadEvidenceFile(
  storagePath: string
): Promise<{ data?: Buffer; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { error: "Supabase client is not configured." };
  }

  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    return { error: error?.message || "Failed to download evidence file from storage." };
  }

  const arrayBuffer = await data.arrayBuffer();
  return { data: Buffer.from(arrayBuffer) };
}

// Clean up uploaded files (e.g. for partial failure rollback or test cleanup)
export async function deleteEvidenceFiles(
  storagePaths: string[]
): Promise<{ success: boolean; error?: string }> {
  if (!storagePaths || storagePaths.length === 0) {
    return { success: true };
  }

  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { success: false, error: "Supabase client is not configured." };
  }

  const { error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .remove(storagePaths);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}
