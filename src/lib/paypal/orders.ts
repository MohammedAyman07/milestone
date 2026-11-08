import { paypalRequest } from "./client";
import { PayPalOrderResponse, PayPalAuthorizationDetails } from "./types";

// =============================================================================
// Trusted Origin & Callback URL Resolution (Phase 9.1.1 Security Hardening)
// Enforces trusted server-configured application origins.
// Prevents Host Header Injection and Open Redirect attacks.
// =============================================================================

export function getTrustedApplicationOrigin(req?: { headers: { get: (name: string) => string | null } }): string {
  // 1. Strict server-side configured environment variables
  const configuredAppUrl = (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ""
  ).trim().replace(/\/$/, "");

  if (configuredAppUrl) {
    try {
      const parsed = new URL(configuredAppUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      console.warn(`[Security Warning] Configured APP_URL "${configuredAppUrl}" is invalid. Using safe fallback.`);
    }
  }

  // 2. Local development fallback: strictly allow localhost or 127.0.0.1
  const isDevelopment = process.env.NODE_ENV !== "production";
  if (isDevelopment && req) {
    const rawHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    const cleanHost = rawHost.split(",")[0].trim().toLowerCase();
    const isLocal =
      cleanHost === "localhost" ||
      cleanHost.startsWith("localhost:") ||
      cleanHost === "127.0.0.1" ||
      cleanHost.startsWith("127.0.0.1:");

    if (isLocal) {
      const proto = req.headers.get("x-forwarded-proto") || "http";
      return `${proto}://${cleanHost}`;
    }
  }

  // 3. Fallback safe default
  return "http://localhost:3000";
}

export function resolveSafeCallbackUrls(
  req?: { headers: { get: (name: string) => string | null } },
  requestedUrls?: { returnUrl?: string; cancelUrl?: string }
): { returnUrl: string; cancelUrl: string } {
  const trustedOrigin = getTrustedApplicationOrigin(req);
  const defaultReturn = `${trustedOrigin}/payments/paypal/success`;
  const defaultCancel = `${trustedOrigin}/payments/paypal/cancel`;

  const isOriginAllowed = (urlStr?: string): boolean => {
    if (!urlStr || typeof urlStr !== "string") return false;
    try {
      const parsed = new URL(urlStr);
      return parsed.origin === trustedOrigin;
    } catch {
      return false;
    }
  };

  const returnUrl = isOriginAllowed(requestedUrls?.returnUrl)
    ? requestedUrls!.returnUrl!
    : defaultReturn;

  const cancelUrl = isOriginAllowed(requestedUrls?.cancelUrl)
    ? requestedUrls!.cancelUrl!
    : defaultCancel;

  return { returnUrl, cancelUrl };
}

// =============================================================================
// PayPal Idempotency Retention Configuration (Orders v2)
// Default: 6 hours (per PayPal API spec).
// Extended: up to 72 hours ONLY with confirmed Account Manager agreement.
// =============================================================================
export const DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 6;
export const MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 72;

export interface PayPalRetentionConfig {
  retentionHours: number;
  retentionMs: number;
  isExtendedConfirmed: boolean;
  source: "default" | "configured_standard" | "configured_extended" | "fallback_unconfirmed";
}

/**
 * Resolves the active PayPal idempotency retention configuration.
 *
 * Per PayPal Orders v2 documentation:
 * - Default idempotency retention window is 6 hours (21,600 seconds).
 * - Retention may be extended up to 72 hours ONLY via explicit agreement/enablement
 *   through a dedicated PayPal Account Manager or Partner Engineering.
 *
 * Safety rules:
 * 1. Default to 6 hours if PAYPAL_IDEMPOTENCY_RETENTION_HOURS is not configured.
 * 2. If PAYPAL_IDEMPOTENCY_RETENTION_HOURS > 6 is requested, it is REJECTED and falls back
 *    to 6 hours UNLESS PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED is explicitly set to "true".
 * 3. Even when confirmed, retention is capped at MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS (72 hours).
 * 4. Values <= 0 or NaN safely fallback to 6 hours.
 */
export function getPayPalIdempotencyRetentionConfig(): PayPalRetentionConfig {
  const confirmedRaw = (process.env.PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED || "").trim().toLowerCase();
  const isExtendedConfirmed = confirmedRaw === "true" || confirmedRaw === "1" || confirmedRaw === "yes";

  const envHoursRaw = process.env.PAYPAL_IDEMPOTENCY_RETENTION_HOURS?.trim();

  // If not explicitly set:
  if (!envHoursRaw) {
    if (isExtendedConfirmed) {
      return {
        retentionHours: MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
        retentionMs: MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
        isExtendedConfirmed: true,
        source: "configured_extended",
      };
    }
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed: false,
      source: "default",
    };
  }

  const parsedHours = parseFloat(envHoursRaw);
  if (isNaN(parsedHours) || parsedHours <= 0) {
    console.warn(
      `[PayPal Config Warning] Invalid PAYPAL_IDEMPOTENCY_RETENTION_HOURS "${envHoursRaw}". Defaulting safely to ${DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS}h.`
    );
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed,
      source: "default",
    };
  }

  // If configured > 6 hours but account extension is not confirmed:
  if (parsedHours > DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS && !isExtendedConfirmed) {
    console.warn(
      `[PayPal Config Warning] PAYPAL_IDEMPOTENCY_RETENTION_HOURS is set to ${parsedHours}h (> 6h), ` +
      `but PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED is not 'true'. ` +
      `PayPal default retention is 6 hours; accounts require explicit Account Manager approval for extensions up to 72 hours. ` +
      `Clamping safely to ${DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS}h to prevent duplicate charges upon replay.`
    );
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed: false,
      source: "fallback_unconfirmed",
    };
  }

  // Clamped to 72 hours max
  const finalHours = Math.min(parsedHours, MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS);
  return {
    retentionHours: finalHours,
    retentionMs: finalHours * 60 * 60 * 1000,
    isExtendedConfirmed,
    source: finalHours > DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS ? "configured_extended" : "configured_standard",
  };
}

export interface CreateOrderParams {
  milestoneId: string;
  projectId: string;
  milestoneTitle: string;
  amount: number;
  currency?: string;
  returnUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  paymentAttemptId: string;
  merchantId?: string;
}

export interface CreateOrderResult {
  orderId: string;
  status: string;
  approvalUrl: string;
  raw: PayPalOrderResponse;
}

export async function createPayPalOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const currency = params.currency || "USD";
  if (currency !== "USD") {
    throw new Error("MILESTONE AI MVP supports USD payments only.");
  }

  if (params.amount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const purchaseUnit: Record<string, unknown> = {
    reference_id: params.milestoneId,
    custom_id: params.paymentAttemptId,
    description: `MILESTONE AI - ${params.milestoneTitle.slice(0, 100)}`,
    amount: {
      currency_code: "USD",
      value: params.amount.toFixed(2),
    },
  };

  if (params.merchantId) {
    purchaseUnit.payee = {
      merchant_id: params.merchantId,
    };
  }

  const payload = {
    intent: "AUTHORIZE",
    purchase_units: [purchaseUnit],
    application_context: {
      brand_name: "MILESTONE AI",
      user_action: "CONTINUE",
      shipping_preference: "NO_SHIPPING",
      return_url: params.returnUrl,
      cancel_url: params.cancelUrl,
    },
  };

  const response = await paypalRequest<PayPalOrderResponse>("/v2/checkout/orders", {
    method: "POST",
    body: payload,
    idempotencyKey: params.idempotencyKey,
  });

  if (!response.data || !response.data.id) {
    throw new Error("PayPal response did not contain a valid order ID.");
  }

  const approvalLink = response.data.links?.find((l) => l.rel === "approve")?.href || "";
  if (!approvalLink) {
    throw new Error("PayPal did not return a buyer approval redirect URL.");
  }

  return {
    orderId: response.data.id,
    status: response.data.status,
    approvalUrl: approvalLink,
    raw: response.data,
  };
}

export async function getPayPalOrder(orderId: string): Promise<PayPalOrderResponse> {
  const response = await paypalRequest<PayPalOrderResponse>(`/v2/checkout/orders/${orderId}`);
  return response.data;
}


export interface AuthorizeOrderResult {
  authorizationId: string;
  status: string;
  amount: number;
  currency: string;
  expirationTime?: string;
  payerId?: string;
  payerEmail?: string;
  raw: unknown;
}

export async function authorizePayPalOrder(
  orderId: string,
  idempotencyKey: string
): Promise<AuthorizeOrderResult> {
  const response = await paypalRequest<any>(`/v2/checkout/orders/${orderId}/authorize`, {
    method: "POST",
    body: {},
    idempotencyKey,
  });

  const data = response.data;
  const purchaseUnit = data.purchase_units?.[0];
  const authorization = purchaseUnit?.payments?.authorizations?.[0];

  if (!authorization || !authorization.id) {
    throw new Error(
      `PayPal authorization failed. No authorization resource returned: ${JSON.stringify(data)}`
    );
  }

  const payerId = data.payer?.payer_id;
  const payerEmail = data.payer?.email_address;
  const authAmount = parseFloat(authorization.amount?.value || "0");
  const authCurrency = authorization.amount?.currency_code || "USD";

  return {
    authorizationId: authorization.id,
    status: authorization.status,
    amount: authAmount,
    currency: authCurrency,
    expirationTime: authorization.expiration_time,
    payerId,
    payerEmail,
    raw: data,
  };
}
