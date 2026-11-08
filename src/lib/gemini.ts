import { GoogleGenAI } from "@google/genai";

export interface GeminiCallResult {
  text: string;
  modelUsed: string;
  attempts: number;
}

export type GeminiErrorType =
  | "RATE_LIMIT"
  | "UPSTREAM_UNAVAILABLE"
  | "TRANSIENT_NETWORK"
  | "AUTHENTICATION_FAILED"
  | "INVALID_REQUEST"
  | "SAFETY_BLOCKED"
  | "UNKNOWN";

export interface GeminiErrorClassification {
  isRetryable: boolean;
  errorType: GeminiErrorType;
  statusCode: number; // 429, 503, 500, 401, 400, etc.
  retryDelayMs?: number;
  cleanMessage: string;
}

export class GeminiExecutionError extends Error {
  public classification: GeminiErrorClassification;
  public attempts: number;
  public modelUsed: string;

  constructor(
    message: string,
    classification: GeminiErrorClassification,
    attempts: number,
    modelUsed: string
  ) {
    super(message);
    this.name = "GeminiExecutionError";
    this.classification = classification;
    this.attempts = attempts;
    this.modelUsed = modelUsed;
  }
}

export const MAX_RETRY_ATTEMPTS = 3;
export const BASE_BACKOFF_DELAY_MS = 1000;
export const MAX_BACKOFF_DELAY_MS = 8000;

export function getGeminiClient(): {
  client: GoogleGenAI;
  primaryModel: string;
  fallbackModel: string;
} {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    throw new GeminiExecutionError(
      "GEMINI_API_KEY is not configured on the server. Please check your environment variables.",
      {
        isRetryable: false,
        errorType: "AUTHENTICATION_FAILED",
        statusCode: 401,
        cleanMessage: "GEMINI_API_KEY is not configured on the server.",
      },
      0,
      "none"
    );
  }

  // Primary model is gemini-2.5-flash
  const primaryModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";

  const client = new GoogleGenAI({ apiKey });
  return { client, primaryModel, fallbackModel };
}

// Sleep helper
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Sanitize error messages to ensure API keys are never leaked
export function sanitizeGeminiError(err: unknown): string {
  if (!err) return "Unknown AI verification error";
  let msg = err instanceof Error ? err.message : String(err);
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey && apiKey.length > 5) {
    msg = msg.replaceAll(apiKey, "[REDACTED_API_KEY]");
  }
  // Strip internal SDK stack traces
  const lines = msg.split("\n");
  return lines[0].slice(0, 255);
}

// Extract retry-delay from error metadata or headers
export function extractRetryDelayMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;

  const anyErr = err as any;

  // 1. Check statusDetails or errorDetails for RetryInfo
  const details = anyErr.statusDetails || anyErr.errorDetails || anyErr.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d?.retryDelay) {
        if (typeof d.retryDelay === "number") return Math.round(d.retryDelay * 1000);
        if (typeof d.retryDelay === "string") {
          const match = d.retryDelay.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
          if (match) return Math.round(parseFloat(match[1]) * 1000);
        }
      }
    }
  }

  // 2. Check HTTP headers (Retry-After)
  const headers = anyErr.response?.headers || anyErr.headers;
  if (headers) {
    const retryHeader =
      typeof headers.get === "function"
        ? headers.get("retry-after")
        : headers["retry-after"] || headers["Retry-After"];
    if (retryHeader) {
      const parsedSec = parseFloat(String(retryHeader));
      if (!isNaN(parsedSec) && parsedSec > 0) {
        return Math.round(parsedSec * 1000);
      }
    }
  }

  // 3. Check regex in error message string: e.g. "retry after 5.2s" or "try again in 5 seconds"
  const rawMsg = anyErr.message || String(err);
  const match = rawMsg.match(/(?:retry after|retry-after|try again in|please wait)\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)?/i);
  if (match) {
    const val = parseFloat(match[1]);
    const unit = (match[2] || "s").toLowerCase();
    if (!isNaN(val) && val > 0) {
      return unit.startsWith("ms") ? Math.round(val) : Math.round(val * 1000);
    }
  }

  return undefined;
}

// Error Classification
export function classifyGeminiError(err: unknown): GeminiErrorClassification {
  const cleanMessage = sanitizeGeminiError(err);
  const rawMsg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const retryDelayMs = extractRetryDelayMs(err);

  // 1. Non-retryable: Authentication / API Key / Permissions
  if (
    rawMsg.includes("api key") ||
    rawMsg.includes("api_key_invalid") ||
    rawMsg.includes("unauthenticated") ||
    rawMsg.includes("not configured")
  ) {
    return {
      isRetryable: false,
      errorType: "AUTHENTICATION_FAILED",
      statusCode: 401,
      cleanMessage,
    };
  }

  if (rawMsg.includes("permission_denied") || rawMsg.includes("permission denied")) {
    return {
      isRetryable: false,
      errorType: "AUTHENTICATION_FAILED",
      statusCode: 403,
      cleanMessage,
    };
  }

  // 2. Non-retryable: Malformed request / Invalid argument / Not found
  if (
    rawMsg.includes("invalid_argument") ||
    rawMsg.includes("bad request") ||
    rawMsg.includes("malformed")
  ) {
    return {
      isRetryable: false,
      errorType: "INVALID_REQUEST",
      statusCode: 400,
      cleanMessage,
    };
  }

  if (rawMsg.includes("safety") || rawMsg.includes("blocked") || rawMsg.includes("harmful")) {
    return {
      isRetryable: false,
      errorType: "SAFETY_BLOCKED",
      statusCode: 422,
      cleanMessage,
    };
  }

  // 3. Retryable: Rate limit / Quota (HTTP 429)
  if (
    rawMsg.includes("429") ||
    rawMsg.includes("resource_exhausted") ||
    rawMsg.includes("resourceexhausted") ||
    rawMsg.includes("quota") ||
    rawMsg.includes("rate limit") ||
    rawMsg.includes("rate_limit_exceeded")
  ) {
    return {
      isRetryable: true,
      errorType: "RATE_LIMIT",
      statusCode: 429,
      retryDelayMs,
      cleanMessage,
    };
  }

  // 4. Retryable: Upstream unavailable / 503 / 502 / 504 / 500
  if (
    rawMsg.includes("503") ||
    rawMsg.includes("unavailable") ||
    rawMsg.includes("high demand") ||
    rawMsg.includes("overloaded") ||
    rawMsg.includes("502") ||
    rawMsg.includes("bad gateway") ||
    rawMsg.includes("504") ||
    rawMsg.includes("deadline_exceeded") ||
    rawMsg.includes("internal") ||
    rawMsg.includes("500")
  ) {
    return {
      isRetryable: true,
      errorType: "UPSTREAM_UNAVAILABLE",
      statusCode: 503,
      retryDelayMs,
      cleanMessage,
    };
  }

  // 5. Retryable: Transient network / socket errors
  if (
    rawMsg.includes("econnreset") ||
    rawMsg.includes("etimedout") ||
    rawMsg.includes("fetch failed") ||
    rawMsg.includes("socket hang up") ||
    rawMsg.includes("und_err_connect_timeout") ||
    rawMsg.includes("network error")
  ) {
    return {
      isRetryable: true,
      errorType: "TRANSIENT_NETWORK",
      statusCode: 503,
      retryDelayMs,
      cleanMessage,
    };
  }

  // Default to unknown non-retryable 500
  return {
    isRetryable: false,
    errorType: "UNKNOWN",
    statusCode: 500,
    cleanMessage,
  };
}

// Calculate backoff delay with exponential scaling and full randomized jitter
export function calculateBackoffDelay(
  attempt: number,
  upstreamRetryDelayMs?: number,
  baseDelayMs: number = BASE_BACKOFF_DELAY_MS,
  maxDelayMs: number = MAX_BACKOFF_DELAY_MS
): number {
  if (upstreamRetryDelayMs !== undefined && upstreamRetryDelayMs > 0) {
    return Math.min(maxDelayMs, Math.max(500, upstreamRetryDelayMs));
  }

  // Exponential: baseDelay * 2^(attempt - 1)
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  // Full jitter: Add random jitter up to 35% of the exponential value
  const jitter = Math.floor(Math.random() * (exponential * 0.35));
  return Math.min(maxDelayMs, exponential + jitter);
}

// Options for testing and resilience control
export interface ResilienceOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, classification: GeminiErrorClassification) => void;
  mockGenerator?: (contents: string | any[], model: string, attempt: number) => Promise<{ text: string }>;
}

// Active in-memory test override for mocking
let activeMockGenerator: ((contents: string | any[], model: string, attempt: number) => Promise<{ text: string }>) | null = null;

export function setTestMockGenerator(
  mockGen: ((contents: string | any[], model: string, attempt: number) => Promise<{ text: string }>) | null
): void {
  activeMockGenerator = mockGen;
}

// Execute Gemini call with exponential backoff, jitter, and classification
export async function generateContentWithResilience(
  contents: string | any[],
  preferredModel?: string,
  options: ResilienceOptions = {}
): Promise<GeminiCallResult> {
  const maxAttempts = options.maxAttempts || MAX_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs || BASE_BACKOFF_DELAY_MS;
  const maxDelayMs = options.maxDelayMs || MAX_BACKOFF_DELAY_MS;
  const mockGen = options.mockGenerator || activeMockGenerator;

  let client: GoogleGenAI | null = null;
  let primaryModel = "gemini-2.5-flash";
  let fallbackModel = "gemini-2.5-flash";

  if (!mockGen) {
    const config = getGeminiClient();
    client = config.client;
    primaryModel = config.primaryModel;
    fallbackModel = config.fallbackModel;
  }

  const targetModel = preferredModel || primaryModel;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      if (mockGen) {
        const mockRes = await mockGen(contents, targetModel, attempt);
        return {
          text: mockRes.text || "",
          modelUsed: targetModel,
          attempts: attempt,
        };
      }

      if (!client) {
        throw new Error("Client initialization failed");
      }

      const response = await client.models.generateContent({
        model: targetModel,
        contents: contents as any,
      });

      const text = response.text || "";
      return {
        text,
        modelUsed: targetModel,
        attempts: attempt,
      };
    } catch (err: unknown) {
      const classification = classifyGeminiError(err);

      // Non-retryable errors abort immediately
      if (!classification.isRetryable) {
        console.error(`Gemini non-retryable error on attempt ${attempt}:`, classification.cleanMessage);
        throw new GeminiExecutionError(
          classification.cleanMessage,
          classification,
          attempt,
          targetModel
        );
      }

      // Check if attempts exhausted
      if (attempt >= maxAttempts) {
        console.error(
          `Gemini retry exhaustion after ${attempt} attempts (${classification.errorType}):`,
          classification.cleanMessage
        );
        throw new GeminiExecutionError(
          classification.cleanMessage,
          classification,
          attempt,
          targetModel
        );
      }

      // Calculate backoff delay with jitter
      const delayMs = calculateBackoffDelay(
        attempt,
        classification.retryDelayMs,
        baseDelayMs,
        maxDelayMs
      );

      console.warn(
        `Gemini call failed with ${classification.errorType}. Retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})...`
      );

      if (options.onRetry) {
        options.onRetry(attempt, delayMs, classification);
      }

      await sleep(delayMs);
    }
  }
}

// Clean and extract valid JSON string from potential markdown fenced code blocks
export function extractJsonFromResponse(rawText: string): string {
  const trimmed = rawText.trim();
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = trimmed.match(jsonBlockRegex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return trimmed;
}
