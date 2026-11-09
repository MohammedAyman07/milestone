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

export interface GitHubSourceInspection {
  inspected: boolean;
  repoOwner?: string;
  repoName?: string;
  defaultBranch?: string;
  packageJsonFound: boolean;
  packageName?: string;
  framework?: string;
  topDependencies?: string[];
  scriptsAvailable?: string[];
  readmeFound: boolean;
  readmeByteLength?: number;
  readmeSummarySnippet?: string;
  hasSetupInstructions?: boolean;
  siteTitleComparison?: {
    siteTitle?: string;
    repoNameMatch: boolean;
    notes: string;
  };
  details: string;
}

export interface DeterministicEvidenceAudit {
  files: FileValidationResult;
  github: ProbeResult;
  githubSource?: GitHubSourceInspection;
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
    if (typeof (f as any).sizeBytes === "number" && (f as any).sizeBytes > 0) {
      fileBytes = (f as any).sizeBytes;
    } else if (f.size) {
      const match = f.size.match(/([\d.]+)\s*(KB|MB|bytes|B)?/i);
      if (match) {
        const val = parseFloat(match[1]);
        const unit = (match[2] || "B").toUpperCase();
        if (unit === "MB") fileBytes = Math.round(val * 1024 * 1024);
        else if (unit === "KB") fileBytes = Math.round(val * 1024);
        else fileBytes = Math.round(val);
      }
    }

    if (fileBytes === 0) {
      errors.push(`File "${f.name}" is empty (0 bytes). Deliverables must not be empty.`);
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

// Deterministic inspection of GitHub repository contents and correlation with deployed site
export async function inspectGitHubRepository(
  repoUrl?: string,
  stagingUrl?: string
): Promise<GitHubSourceInspection> {
  if (!repoUrl || !repoUrl.trim()) {
    return {
      inspected: false,
      packageJsonFound: false,
      readmeFound: false,
      details: "No GitHub repository URL provided for source inspection.",
    };
  }

  const match = repoUrl.trim().match(/github\.com\/([a-zA-Z0-9_\-\.]+)\/([a-zA-Z0-9_\-\.]+)/i);
  if (!match) {
    return {
      inspected: false,
      packageJsonFound: false,
      readmeFound: false,
      details: "Invalid GitHub repository URL format.",
    };
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  const branches = ["main", "master"];

  let defaultBranch = "main";
  let packageJsonFound = false;
  let packageName: string | undefined;
  let framework: string | undefined;
  let topDependencies: string[] = [];
  let scriptsAvailable: string[] = [];
  let readmeFound = false;
  let readmeByteLength: number | undefined;
  let readmeSummarySnippet: string | undefined;
  let hasSetupInstructions = false;

  // 1. Inspect package.json across main/master branches
  for (const branch of branches) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const pkgUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/package.json`;
      const res = await fetch(pkgUrl, {
        headers: { "User-Agent": "MilestoneAI-SourceInspector/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const pkgData = await res.json();
        packageJsonFound = true;
        defaultBranch = branch;
        packageName = pkgData.name;
        const allDeps = {
          ...(pkgData.dependencies || {}),
          ...(pkgData.devDependencies || {}),
        };
        topDependencies = Object.keys(allDeps).slice(0, 15);
        scriptsAvailable = Object.keys(pkgData.scripts || {}).slice(0, 10);

        if (allDeps["next"]) framework = "Next.js";
        else if (allDeps["vite"] || allDeps["@vitejs/plugin-react"]) framework = "Vite + React";
        else if (allDeps["react"]) framework = "React";
        else if (allDeps["vue"]) framework = "Vue.js";
        else if (allDeps["express"]) framework = "Express.js";
        else framework = "Node.js";
        break;
      }
    } catch {
      // Continue to next branch
    }
  }

  // 2. Inspect README.md across main/master branches
  for (const branch of [defaultBranch, ...branches.filter((b) => b !== defaultBranch)]) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`;
      const res = await fetch(readmeUrl, {
        headers: { "User-Agent": "MilestoneAI-SourceInspector/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const readmeText = await res.text();
        readmeFound = true;
        readmeByteLength = Buffer.byteLength(readmeText, "utf-8");
        readmeSummarySnippet = readmeText.slice(0, 500).replace(/\r?\n/g, " ").trim();
        const lowerReadme = readmeText.toLowerCase();
        hasSetupInstructions =
          lowerReadme.includes("npm install") ||
          lowerReadme.includes("npm run") ||
          lowerReadme.includes("yarn") ||
          lowerReadme.includes("pnpm") ||
          lowerReadme.includes("getting started") ||
          lowerReadme.includes("setup") ||
          lowerReadme.includes("installation");
        break;
      }
    } catch {
      // Continue
    }
  }

  // 3. Compare with live staging deployment if available
  let siteTitleComparison: GitHubSourceInspection["siteTitleComparison"];
  if (stagingUrl && stagingUrl.trim()) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const siteRes = await fetch(stagingUrl.trim(), {
        headers: { "User-Agent": "MilestoneAI-SourceInspector/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (siteRes.ok) {
        const html = await siteRes.text();
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        const siteTitle = titleMatch ? titleMatch[1].trim() : undefined;

        const cleanSiteTitle = (siteTitle || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const cleanRepoName = repo.toLowerCase().replace(/[^a-z0-9]/g, "");
        const cleanPkgName = (packageName || "").toLowerCase().replace(/[^a-z0-9]/g, "");

        const isMatch =
          cleanSiteTitle.length > 0 &&
          (cleanSiteTitle.includes(cleanRepoName) ||
            cleanRepoName.includes(cleanSiteTitle) ||
            cleanSiteTitle.includes(cleanPkgName) ||
            cleanPkgName.includes(cleanSiteTitle));

        siteTitleComparison = {
          siteTitle,
          repoNameMatch: isMatch,
          notes: isMatch
            ? `Deployed application title ("${siteTitle}") matches repository name "${repo}" and package "${packageName}" (branding/naming correspondence; does not independently prove exact commit code correspondence without deployment commit SHA or build hash).`
            : `Deployed site title is "${siteTitle || "Unknown"}" (checked against repo "${repo}").`,
        };
      }
    } catch {
      // Staging comparison error
    }
  }

  const inspected = packageJsonFound || readmeFound;
  const details = inspected
    ? `Inspected public GitHub repository ${owner}/${repo} on branch '${defaultBranch}'. Found ${
        packageJsonFound ? `package.json ("${packageName}", framework: ${framework})` : "no package.json"
      } and ${readmeFound ? `README.md (${readmeByteLength} bytes)` : "no README.md"}.${
        siteTitleComparison ? " " + siteTitleComparison.notes : ""
      } Note: Repository naming and manifest inspection confirms project identity, but exact deployed code correspondence remains unproven without git commit hash or build artifact proof.`
    : `Repository ${owner}/${repo} reachable, but package.json / README.md could not be retrieved from standard branches.`;

  return {
    inspected,
    repoOwner: owner,
    repoName: repo,
    defaultBranch,
    packageJsonFound,
    packageName,
    framework,
    topDependencies,
    scriptsAvailable,
    readmeFound,
    readmeByteLength,
    readmeSummarySnippet,
    hasSetupInstructions,
    siteTitleComparison,
    details,
  };
}

// Run all deterministic evidence validations in parallel
export async function performDeterministicEvidenceAudit(
  files: StagedFile[] = [],
  repoUrl?: string,
  stagingUrl?: string
): Promise<DeterministicEvidenceAudit> {
  const fileResult = validateEvidenceFiles(files);
  const [githubResult, githubSource, stagingResult] = await Promise.all([
    probeGitHubUrl(repoUrl),
    inspectGitHubRepository(repoUrl, stagingUrl),
    probeWebsiteUrl(stagingUrl),
  ]);

  return {
    files: fileResult,
    github: githubResult,
    githubSource,
    staging: stagingResult,
    timestamp: new Date().toISOString(),
  };
}
