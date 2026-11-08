export interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in ms
}

let inMemoryTokenCache: CachedToken | null = null;

export interface PayPalConfig {
  environment: "sandbox" | "live";
  clientId: string;
  clientSecret: string;
  webhookId: string;
  baseUrl: string;
}

export class PayPalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalError";
  }
}

export class PayPalApiError extends PayPalError {
  public status: number;
  public debugId?: string;
  public details?: unknown;
  public isDefinitiveRejection: boolean;

  constructor(status: number, message: string, debugId?: string, details?: unknown) {
    super(`PayPal API Error [HTTP ${status}] (Debug ID: ${debugId || "none"}): ${message}`);
    this.name = "PayPalApiError";
    this.status = status;
    this.debugId = debugId;
    this.details = details;
    // 4xx errors (except 408 Request Timeout and 429 Rate Limit) are definitive rejections
    // because PayPal rejected the request before committing an order.
    // 5xx errors, 408, and 429 are ambiguous/uncertain because the order might have been processed by PayPal.
    this.isDefinitiveRejection = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

export class PayPalTimeoutError extends PayPalError {
  public isTimeout = true;
  constructor(message = "PayPal request timed out waiting for response.") {
    super(message);
    this.name = "PayPalTimeoutError";
  }
}

export class PayPalNetworkError extends PayPalError {
  public isNetwork = true;
  constructor(message: string) {
    super(message);
    this.name = "PayPalNetworkError";
  }
}

export function getPayPalConfig(): PayPalConfig {
  if (typeof window !== "undefined") {
    throw new Error("Security Violation: PayPal server client must not be accessed from the browser.");
  }

  const rawEnv = (process.env.PAYPAL_ENVIRONMENT || "sandbox").trim().toLowerCase();
  const environment: "sandbox" | "live" =
    rawEnv === "live" || rawEnv === "production" ? "live" : "sandbox";

  const clientId = process.env.PAYPAL_CLIENT_ID || "";
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || "";
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || "";

  const defaultBaseUrl =
    environment === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const baseUrl = (process.env.PAYPAL_BASE_URL || defaultBaseUrl).replace(/\/$/, "");

  return { environment, clientId, clientSecret, webhookId, baseUrl };
}

// Reset token cache (useful for testing or credentials change)
export function resetTokenCache() {
  inMemoryTokenCache = null;
}

// Fetch OAuth2 access token with in-memory caching and 60-second safety margin
export async function getPayPalAccessToken(): Promise<string> {
  const { clientId, clientSecret, baseUrl, environment } = getPayPalConfig();

  if (!clientId || !clientSecret) {
    throw new PayPalApiError(
      401,
      `PayPal ${environment.toUpperCase()} credentials are not configured. Please define PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local.`
    );
  }

  const now = Date.now();
  if (inMemoryTokenCache && inMemoryTokenCache.expiresAt > now + 60000) {
    return inMemoryTokenCache.accessToken;
  }

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      const sanitizedErr = errText
        .replace(new RegExp(clientSecret, "g"), "[REDACTED_SECRET]")
        .replace(new RegExp(clientId, "g"), "[REDACTED_CLIENT_ID]");
      throw new PayPalApiError(res.status, `PayPal OAuth2 authentication failed: ${sanitizedErr}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = now + data.expires_in * 1000;

    inMemoryTokenCache = {
      accessToken: data.access_token,
      expiresAt,
    };

    return data.access_token;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof PayPalApiError) {
      throw err;
    }
    const isTimeout =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError");

    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = rawMsg
      .replace(new RegExp(clientSecret || "NONEXISTENT", "g"), "[REDACTED_SECRET]")
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED_AUTH]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");

    if (isTimeout) {
      throw new PayPalTimeoutError("PayPal OAuth2 request timed out waiting for response.");
    }
    throw new PayPalNetworkError(`PayPal OAuth2 network error: ${sanitizedMsg}`);
  }
}

export interface PayPalRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export async function paypalRequest<T>(
  endpoint: string,
  options: PayPalRequestOptions = {}
): Promise<{ status: number; data: T; debugId?: string }> {
  const { baseUrl, clientSecret } = getPayPalConfig();
  const token = await getPayPalAccessToken();

  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs || 15000;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (options.idempotencyKey) {
    headers["PayPal-Request-Id"] = options.idempotencyKey;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const debugId = res.headers.get("paypal-debug-id") || undefined;

    let responseData: unknown = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseData = await res.json();
    } else {
      responseData = await res.text();
    }

    if (!res.ok) {
      const errDetail =
        typeof responseData === "object" ? JSON.stringify(responseData) : String(responseData);
      const sanitizedErr = errDetail
        .replace(new RegExp(clientSecret || "NONEXISTENT", "g"), "[REDACTED_SECRET]");
      throw new PayPalApiError(res.status, sanitizedErr, debugId, responseData);
    }

    return {
      status: res.status,
      data: responseData as T,
      debugId,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof PayPalApiError) {
      throw err;
    }
    const isTimeout =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError");

    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = rawMsg
      .replace(new RegExp(clientSecret || "NONEXISTENT", "g"), "[REDACTED_SECRET]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");

    if (isTimeout) {
      throw new PayPalTimeoutError(`PayPal API request to ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw new PayPalNetworkError(`PayPal network failure for ${endpoint}: ${sanitizedMsg}`);
  }
}
