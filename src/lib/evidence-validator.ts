import { StagedFile } from "./types";

export const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".json",
  ".txt",
  ".md",
  ".csv",
  ".html",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
];

export const DISALLOWED_EXTENSIONS = [
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".sh",
  ".ps1",
  ".vbs",
  ".msi",
  ".jar",
  ".com",
  ".scr",
];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_TOTAL_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB total

export interface FileValidationResult {
  valid: boolean;
  errors: string[];
  totalSizeBytes: number;
  filesInspected: number;
}

export interface ProbeResult {
  attempted: boolean;
  providedUrl?: string;
  reachable: boolean;
  statusCode?: number;
  details: string;
  responseSnippet?: string;
}

export interface DeterministicEvidenceAudit {
  files: FileValidationResult;
  github: ProbeResult;
  staging: ProbeResult;
  timestamp: string;
}

// Deterministic file evidence validation
export function validateEvidenceFiles(files: StagedFile[] = []): FileValidationResult {
  const errors: string[] = [];
  let totalSizeBytes = 0;

  for (const f of files) {
    const nameLower = (f.name || "").toLowerCase();

    // Check disallowed executable extensions
    const hasDisallowedExt = DISALLOWED_EXTENSIONS.some((ext) => nameLower.endsWith(ext));
    if (hasDisallowedExt) {
      errors.push(`File "${f.name}" has an executable or disallowed extension.`);
    }

    // Check allowed extension
    const hasAllowedExt = ALLOWED_EXTENSIONS.some((ext) => nameLower.endsWith(ext));
    if (!hasAllowedExt && !hasDisallowedExt) {
      errors.push(
        `File "${f.name}" has an unsupported format. Supported formats: ${ALLOWED_EXTENSIONS.join(", ")}`
      );
    }

    // Estimate size in bytes
    let fileBytes = 0;
    if (f.size) {
      const match = f.size.match(/([\d.]+)\s*(KB|MB|bytes|B)/i);
      if (match) {
        const val = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        if (unit === "MB") fileBytes = val * 1024 * 1024;
        else if (unit === "KB") fileBytes = val * 1024;
        else fileBytes = val;
      }
    }

    totalSizeBytes += fileBytes;

    if (fileBytes > MAX_FILE_SIZE_BYTES) {
      errors.push(
        `File "${f.name}" exceeds maximum allowed file size of 10 MB (${(fileBytes / (1024 * 1024)).toFixed(1)} MB).`
      );
    }
  }

  if (totalSizeBytes > MAX_TOTAL_SIZE_BYTES) {
    errors.push(
      `Total submission files size exceeds 25 MB limit (${(totalSizeBytes / (1024 * 1024)).toFixed(1)} MB).`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    totalSizeBytes,
    filesInspected: files.length,
  };
}

// Deterministic probe for GitHub repository / commit reachability
export async function probeGitHubUrl(url?: string): Promise<ProbeResult> {
  if (!url || url.trim() === "") {
    return {
      attempted: false,
      reachable: false,
      details: "No GitHub repository URL provided.",
    };
  }

  const trimmed = url.trim();
  const githubRegex = /^https:\/\/github\.com\/([a-zA-Z0-9_\-\.]+)\/([a-zA-Z0-9_\-\.]+)(\/.*)?$/;

  if (!githubRegex.test(trimmed)) {
    return {
      attempted: true,
      providedUrl: trimmed,
      reachable: false,
      details: "Invalid GitHub URL format. Must be a valid public GitHub repository or commit URL.",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(trimmed, {
      method: "HEAD",
      headers: {
        "User-Agent": "MilestoneAI-VerificationProbe/1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 200 || res.status === 301 || res.status === 302) {
      return {
        attempted: true,
        providedUrl: trimmed,
        reachable: true,
        statusCode: res.status,
        details: `GitHub repository/commit successfully reached (HTTP ${res.status}).`,
      };
    } else if (res.status === 404) {
      return {
        attempted: true,
        providedUrl: trimmed,
        reachable: false,
        statusCode: 404,
        details: "GitHub URL returned 404 Not Found. The repository or commit does not exist or is private.",
      };
    } else {
      return {
        attempted: true,
        providedUrl: trimmed,
        reachable: false,
        statusCode: res.status,
        details: `GitHub returned unexpected status HTTP ${res.status}.`,
      };
    }
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      attempted: true,
      providedUrl: trimmed,
      reachable: false,
      details: isTimeout
        ? "GitHub verification probe timed out after 3.5s."
        : "Failed to establish connection to GitHub repository endpoint.",
    };
  }
}

// Deterministic probe for live staging/website reachability
export async function probeWebsiteUrl(url?: string): Promise<ProbeResult> {
  if (!url || url.trim() === "") {
    return {
      attempted: false,
      reachable: false,
      details: "No live staging URL provided.",
    };
  }

  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return {
      attempted: true,
      providedUrl: trimmed,
      reachable: false,
      details: "Invalid website URL. Must begin with http:// or https://.",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(trimmed, {
      method: "GET",
      headers: {
        "User-Agent": "MilestoneAI-VerificationProbe/1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      let previewText = "";
      try {
        const text = await res.text();
        previewText = text.slice(0, 300).replace(/\s+/g, " ");
      } catch {
        previewText = "(Binary or unreadable content)";
      }

      return {
        attempted: true,
        providedUrl: trimmed,
        reachable: true,
        statusCode: res.status,
        details: `Live staging endpoint reached successfully (HTTP ${res.status}).`,
        responseSnippet: previewText,
      };
    } else {
      return {
        attempted: true,
        providedUrl: trimmed,
        reachable: false,
        statusCode: res.status,
        details: `Staging server returned HTTP error status ${res.status}.`,
      };
    }
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      attempted: true,
      providedUrl: trimmed,
      reachable: false,
      details: isTimeout
        ? "Staging verification probe timed out after 3.5s."
        : "Live staging URL is unreachable or connection was refused.",
    };
  }
}

// Run all deterministic evidence validations in parallel
export async function performDeterministicEvidenceAudit(
  files: StagedFile[] = [],
  repoUrl?: string,
  stagingUrl?: string
): Promise<DeterministicEvidenceAudit> {
  const fileResult = validateEvidenceFiles(files);
  const [githubResult, stagingResult] = await Promise.all([
    probeGitHubUrl(repoUrl),
    probeWebsiteUrl(stagingUrl),
  ]);

  return {
    files: fileResult,
    github: githubResult,
    staging: stagingResult,
    timestamp: new Date().toISOString(),
  };
}
