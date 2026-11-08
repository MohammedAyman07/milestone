import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getPaymentByAttemptId,
  recordAuthorizationInitiatedInDb,
  recordAuthorizationSuccessInDb,
  recordAuthorizationUncertainInDb,
  recordAuthorizationDefinitiveFailureInDb,
} from "@/lib/supabase/payments-db";
import {
  getPayPalOrder,
  authorizePayPalOrder,
  getPayPalIdempotencyRetentionConfig,
} from "@/lib/paypal/orders";
import {
  PayPalApiError,
  PayPalTimeoutError,
  PayPalNetworkError,
} from "@/lib/paypal/client";

export const dynamic = "force-dynamic";

// In-flight concurrency lock per payment attempt (TTL: 30s) to prevent race conditions
const inFlightAuthorizationLocks = new Map<string, number>();

function acquireAuthLock(paymentAttemptId: string): boolean {
  const now = Date.now();
  const lockedAt = inFlightAuthorizationLocks.get(paymentAttemptId);
  if (lockedAt && now - lockedAt < 30000) {
    return false; // Still locked
  }
  inFlightAuthorizationLocks.set(paymentAttemptId, now);
  return true;
}

function releaseAuthLock(paymentAttemptId: string): void {
  inFlightAuthorizationLocks.delete(paymentAttemptId);
}

export async function POST(req: NextRequest) {
  let lockedPaymentAttemptId: string | null = null;

  try {
    // 1. Authenticate current user via Supabase session or Bearer token
    const authHeader = req.headers.get("authorization");
    let user: { id: string } | null = null;
    const supabase = await createServerSupabaseClient();

    if (!supabase) {
      return NextResponse.json(
        { error: "Authentication service unavailable. Please try again." },
        { status: 503 }
      );
    }

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (!userError && userData?.user) {
        user = userData.user;
      }
    }

    if (!user) {
      const { data: cookieUserData } = await supabase.auth.getUser();
      if (cookieUserData?.user) {
        user = cookieUserData.user;
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to authorize payment." },
        { status: 401 }
      );
    }

    // 2. Parse request body (accept only paymentAttemptId as authoritative input)
    const body = await req.json().catch(() => ({}));
    const paymentAttemptId =
      typeof body.paymentAttemptId === "string" ? body.paymentAttemptId.trim() : "";

    if (!paymentAttemptId) {
      return NextResponse.json(
        { error: "Missing required parameter: paymentAttemptId" },
        { status: 400 }
      );
    }

    // Concurrency Lock: Prevent simultaneous concurrent authorization requests on the same attempt
    if (!acquireAuthLock(paymentAttemptId)) {
      return NextResponse.json(
        {
          error: "A payment authorization request for this attempt is already in progress. Please wait a moment.",
          code: "CONCURRENT_REQUEST_IN_PROGRESS",
        },
        { status: 409 }
      );
    }
    lockedPaymentAttemptId = paymentAttemptId;

    // 3. Load payment attempt, milestone, and project strictly from Supabase
    const { success: fetchSuccess, payment, error: fetchErr } =
      await getPaymentByAttemptId(paymentAttemptId);

    if (!fetchSuccess || !payment) {
      return NextResponse.json(
        { error: fetchErr || "Payment attempt not found." },
        { status: 404 }
      );
    }

    // 4. Verify user ownership & client role
    // Payer must be the authenticated user and must own the project as client
    if (payment.payer_id !== user.id || payment.project?.client_id !== user.id) {
      return NextResponse.json(
        { error: "Forbidden: You are not authorized to authorize this payment attempt." },
        { status: 403 }
      );
    }

    // Reject if client attempts to pass a mismatched orderId
    if (body.orderId && typeof body.orderId === "string" && body.orderId.trim() !== payment.order_id) {
      return NextResponse.json(
        { error: "Security Violation: Provided order ID does not match the payment attempt's stored PayPal order ID." },
        { status: 400 }
      );
    }

    // 5. Idempotent check: If already AUTHORIZED, return existing authorization details safely
    if (payment.status === "AUTHORIZED") {
      // If client supplied authorizationId, verify it matches
      if (body.authorizationId && typeof body.authorizationId === "string" && body.authorizationId.trim() !== payment.authorization_id) {
        return NextResponse.json(
          { error: `Security Violation: Provided authorization ID '${body.authorizationId}' does not match stored authorization ID '${payment.authorization_id}'.` },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        alreadyAuthorized: true,
        paymentAttemptId: payment.payment_attempt_id,
        authorizationId: payment.authorization_id,
        status: "AUTHORIZED",
        amount: Number(payment.amount),
        currency: payment.currency,
        authorizedAt: payment.authorized_at,
        message: "Payment attempt is already authorized.",
      });
    }

    // 6. State Machine Validation: Payment must be in APPROVED state
    if (payment.status !== "APPROVED") {
      return NextResponse.json(
        {
          error: `Payment attempt cannot be authorized. Current status: ${payment.status}; only APPROVED payments can be authorized.`,
        },
        { status: 400 }
      );
    }

    // 7. Stored PayPal order ID presence validation
    if (!payment.order_id) {
      return NextResponse.json(
        { error: "Payment attempt does not have an associated PayPal order ID." },
        { status: 400 }
      );
    }

    // 8. Idempotency Retention Check for uncertain authorization replays
    const retentionConfig = getPayPalIdempotencyRetentionConfig();
    const attemptTimeStr =
      payment.error_details?.timestamp ||
      payment.created_at ||
      payment.updated_at;
    const attemptAgeMs = Date.now() - new Date(attemptTimeStr).getTime();
    if (payment.manual_reconciliation_required && attemptAgeMs > retentionConfig.retentionMs) {
      const elapsedHours = (attemptAgeMs / (1000 * 60 * 60)).toFixed(1);
      return NextResponse.json(
        {
          success: false,
          error: `The PayPal idempotency retention window (${retentionConfig.retentionHours} hours) for this uncertain authorization has expired (${elapsedHours}h elapsed). Automated replay is blocked to prevent duplicate charges. Manual merchant reconciliation is required.`,
          code: "RECONCILIATION_EXPIRED",
          retentionLimitHours: retentionConfig.retentionHours,
        },
        { status: 409 }
      );
    }

    // 9. Fetch current PayPal order details directly from PayPal server-side
    let paypalOrder;
    try {
      paypalOrder = await getPayPalOrder(payment.order_id);
    } catch (err: unknown) {
      if (err instanceof PayPalTimeoutError || (err instanceof PayPalApiError && !err.isDefinitiveRejection)) {
        return NextResponse.json(
          {
            success: false,
            error: "Upstream PayPal service unavailable during order verification. Please retry shortly.",
            retryable: true,
          },
          { status: 504 }
        );
      }
      const isNotFound = err instanceof PayPalApiError && err.status === 404;
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { success: false, error: isNotFound ? "PayPal order not found." : `Failed to fetch PayPal order: ${msg}` },
        { status: isNotFound ? 404 : 400 }
      );
    }

    // 10. Check if PayPal has ALREADY authorized this order (Reconciliation Check)
    const purchaseUnit = paypalOrder.purchase_units?.[0];
    const existingAuth = purchaseUnit?.payments?.authorizations?.[0];

    // If order is completed but authorizations array is empty:
    if (paypalOrder.status === "COMPLETED" && (!purchaseUnit?.payments?.authorizations || purchaseUnit.payments.authorizations.length === 0)) {
      return NextResponse.json(
        { error: "Security Violation: PayPal order is COMPLETED but contains no authorization resource." },
        { status: 400 }
      );
    }

    if (existingAuth && existingAuth.id) {
      // 10a. Validate existing authorization ID if client provided one
      if (body.authorizationId && typeof body.authorizationId === "string" && body.authorizationId.trim() !== existingAuth.id) {
        return NextResponse.json(
          { error: `Security Violation: Provided authorization ID '${body.authorizationId}' does not match PayPal authorization ID '${existingAuth.id}'.` },
          { status: 400 }
        );
      }

      // 10b. Validate status of existing authorization
      const normalizedStatus = (existingAuth.status || "").toUpperCase();
      if (normalizedStatus === "EXPIRED") {
        return NextResponse.json(
          { error: "The PayPal authorization has expired (Status: EXPIRED). Manual merchant reconciliation is required.", code: "AUTHORIZATION_EXPIRED" },
          { status: 409 }
        );
      }
      if (normalizedStatus === "VOIDED") {
        return NextResponse.json(
          { error: "The PayPal authorization has been voided (Status: VOIDED).", code: "AUTHORIZATION_VOIDED" },
          { status: 409 }
        );
      }
      if (normalizedStatus === "DENIED") {
        return NextResponse.json(
          { error: "The PayPal authorization was denied by PayPal (Status: DENIED).", code: "AUTHORIZATION_DENIED" },
          { status: 409 }
        );
      }

      // 10c. Validate amount & currency on existing authorization
      const authVal = parseFloat(existingAuth.amount?.value || "0");
      const expectedAmount = Number(payment.amount);
      if (Math.abs(authVal - expectedAmount) > 0.001) {
        return NextResponse.json(
          { error: `Financial Integrity Violation: PayPal authorization amount ($${authVal.toFixed(2)}) does not match milestone amount ($${expectedAmount.toFixed(2)}).` },
          { status: 400 }
        );
      }
      const authCurrency = existingAuth.amount?.currency_code || "";
      if (authCurrency !== "USD" || payment.currency !== "USD") {
        return NextResponse.json(
          { error: `Currency Violation: PayPal authorization currency '${authCurrency}' does not match required currency 'USD'.` },
          { status: 400 }
        );
      }

      // 10d. Check expiration timestamp
      if (existingAuth.expiration_time && new Date(existingAuth.expiration_time).getTime() < Date.now()) {
        return NextResponse.json(
          { error: "The PayPal authorization has expired. Manual merchant reconciliation is required.", code: "AUTHORIZATION_EXPIRED" },
          { status: 409 }
        );
      }

      // Reconcile and transition DB record to AUTHORIZED
      const reconcileResult = await recordAuthorizationSuccessInDb({
        paymentAttemptId: payment.payment_attempt_id,
        authorizationId: existingAuth.id,
        payerId: paypalOrder.payer?.payer_id,
        payerEmail: paypalOrder.payer?.email_address,
        expirationTime: existingAuth.expiration_time,
        rawPayload: paypalOrder,
      });

      if (!reconcileResult.success) {
        return NextResponse.json(
          { success: false, error: reconcileResult.error || "Failed to reconcile existing authorization." },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        reconciled: true,
        alreadyAuthorized: true,
        paymentAttemptId: payment.payment_attempt_id,
        authorizationId: existingAuth.id,
        status: "AUTHORIZED",
        amount: authVal,
        currency: authCurrency,
        authorizedAt: existingAuth.create_time ? new Date(existingAuth.create_time).toISOString() : new Date().toISOString(),
        expirationTime: existingAuth.expiration_time ? new Date(existingAuth.expiration_time).toISOString() : undefined,
        message: "Payment authorization already completed on PayPal; local record reconciled.",
      });
    }

    // 11. Validate PayPal order parameters before authorization
    if (paypalOrder.intent !== "AUTHORIZE") {
      return NextResponse.json(
        {
          error: `Security Violation: PayPal order intent is '${paypalOrder.intent}', expected 'AUTHORIZE'.`,
        },
        { status: 400 }
      );
    }

    if (paypalOrder.status !== "APPROVED") {
      return NextResponse.json(
        {
          error: `PayPal order has not been approved by buyer (Current PayPal status: ${paypalOrder.status}).`,
        },
        { status: 400 }
      );
    }

    if (!purchaseUnit) {
      return NextResponse.json(
        { error: "Security Violation: PayPal order contains no purchase units." },
        { status: 400 }
      );
    }

    if (purchaseUnit.reference_id !== payment.milestone_id) {
      return NextResponse.json(
        {
          error: `Security Violation: Order reference ID '${purchaseUnit.reference_id}' does not match milestone '${payment.milestone_id}'.`,
        },
        { status: 400 }
      );
    }

    if (purchaseUnit.custom_id !== payment.payment_attempt_id) {
      return NextResponse.json(
        {
          error: `Security Violation: Order custom ID '${purchaseUnit.custom_id}' does not match payment attempt '${payment.payment_attempt_id}'.`,
        },
        { status: 400 }
      );
    }

    // Validate Amount exact match
    const orderAmount = parseFloat(purchaseUnit.amount?.value || "0");
    const expectedAmount = Number(payment.amount);
    if (Math.abs(orderAmount - expectedAmount) > 0.001) {
      return NextResponse.json(
        {
          error: `Financial Integrity Violation: PayPal order amount ($${orderAmount.toFixed(2)}) does not match milestone amount ($${expectedAmount.toFixed(2)}).`,
        },
        { status: 400 }
      );
    }

    // Validate Currency USD
    const orderCurrency = purchaseUnit.amount?.currency_code || "";
    if (orderCurrency !== "USD" || payment.currency !== "USD") {
      return NextResponse.json(
        {
          error: `Currency Violation: PayPal order currency '${orderCurrency}' does not match required currency 'USD'.`,
        },
        { status: 400 }
      );
    }

    // Validate Merchant Payee if configured on payment or env
    const expectedMerchantId =
      payment.paypal_merchant_id ||
      payment.raw_paypal_response?.purchase_units?.[0]?.payee?.merchant_id ||
      process.env.PAYPAL_MERCHANT_ID?.trim();

    if (
      expectedMerchantId &&
      purchaseUnit.payee?.merchant_id &&
      purchaseUnit.payee.merchant_id !== expectedMerchantId
    ) {
      return NextResponse.json(
        {
          error: `Payee Mismatch Violation: Order merchant payee '${purchaseUnit.payee.merchant_id}' does not match expected payee '${expectedMerchantId}'.`,
        },
        { status: 400 }
      );
    }

    // 12. Pre-Authorization Persist: Record authorization dispatch initiated
    await recordAuthorizationInitiatedInDb(payment.payment_attempt_id);

    // 13. Outbound PayPal Authorization Execution
    // Use the stored stable idempotency key idempotency_order_auth
    const authIdempotencyKey = payment.idempotency_order_auth || `ord_auth_${payment.payment_attempt_id}`;

    try {
      const authResult = await authorizePayPalOrder(payment.order_id, authIdempotencyKey);

      // Validate returned authorization resource
      if (!authResult || !authResult.authorizationId || typeof authResult.authorizationId !== "string") {
        throw new PayPalApiError(500, "Invalid authorization response: missing authorization ID");
      }

      // Validate status of newly created authorization
      const newAuthStatus = (authResult.status || "").toUpperCase();
      if (newAuthStatus === "EXPIRED") {
        throw new PayPalApiError(409, "PayPal authorization returned as EXPIRED.");
      }
      if (newAuthStatus === "DENIED") {
        throw new PayPalApiError(409, "PayPal authorization returned as DENIED.");
      }

      // Validate returned amount & currency
      if (Math.abs(authResult.amount - expectedAmount) > 0.001) {
        throw new PayPalApiError(400, `Returned authorization amount ($${authResult.amount.toFixed(2)}) does not match expected amount ($${expectedAmount.toFixed(2)})`);
      }
      if (authResult.currency !== "USD") {
        throw new PayPalApiError(400, `Returned authorization currency '${authResult.currency}' does not match USD`);
      }

      // Validate client-supplied authorizationId if provided
      if (body.authorizationId && typeof body.authorizationId === "string" && body.authorizationId.trim() !== authResult.authorizationId) {
        return NextResponse.json(
          { error: `Security Violation: Provided authorization ID '${body.authorizationId}' does not match PayPal authorization ID '${authResult.authorizationId}'.` },
          { status: 400 }
        );
      }

      // 14. Persist AUTHORIZED state transition in PostgreSQL (UTC timestamps)
      const updateResult = await recordAuthorizationSuccessInDb({
        paymentAttemptId: payment.payment_attempt_id,
        authorizationId: authResult.authorizationId,
        payerId: authResult.payerId,
        payerEmail: authResult.payerEmail,
        expirationTime: authResult.expirationTime ? new Date(authResult.expirationTime).toISOString() : undefined,
        rawPayload: authResult.raw,
      });

      if (!updateResult.success) {
        return NextResponse.json(
          {
            success: false,
            error: updateResult.error || "Failed to persist authorized status to database.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        paymentAttemptId: payment.payment_attempt_id,
        authorizationId: authResult.authorizationId,
        status: "AUTHORIZED",
        amount: authResult.amount,
        currency: authResult.currency,
        authorizedAt: updateResult.payment?.authorized_at || new Date().toISOString(),
        expirationTime: authResult.expirationTime ? new Date(authResult.expirationTime).toISOString() : undefined,
        message: "Payment successfully authorized via PayPal authorization hold.",
      });
    } catch (err: unknown) {
      // 15. Operation-Specific Failure and Recovery Handling
      const isTimeout =
        err instanceof PayPalTimeoutError ||
        (err instanceof PayPalApiError && (err.status === 504 || err.status === 408)) ||
        (err instanceof DOMException && err.name === "AbortError");
      const is5xx =
        err instanceof PayPalApiError &&
        (err.status >= 500 || err.status === 429);
      const isNetwork = err instanceof PayPalNetworkError;

      // Ambiguous / Uncertain Failure: Timeout, 5xx, or network failure
      // CRITICAL: NEVER mark as FAILED! Preserve in reconciliation state!
      if (isTimeout || is5xx || isNetwork) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await recordAuthorizationUncertainInDb({
          paymentAttemptId: payment.payment_attempt_id,
          errorDetails: {
            error: errorMsg,
            isTimeout,
            status: err instanceof PayPalApiError ? err.status : undefined,
            debugId: err instanceof PayPalApiError ? err.debugId : undefined,
            timestamp: new Date().toISOString(),
          },
          notes: isTimeout
            ? "PayPal authorization timed out waiting for response. Outcome uncertain."
            : `PayPal authorization encountered upstream service error (${err instanceof PayPalApiError ? err.status : "network"}). Outcome uncertain.`,
        });

        return NextResponse.json(
          {
            success: false,
            uncertain: true,
            retryable: true,
            error: `PayPal authorization request timed out or returned upstream service error (${err instanceof PayPalApiError ? err.status : "network"}). The attempt is preserved in reconciliation state. Please retry to reconcile.`,
          },
          { status: isTimeout ? 504 : 502 }
        );
      }

      // Definitive PayPal Rejection: Client/Order error (4xx) confirmed rejected before authorization
      if (err instanceof PayPalApiError && err.isDefinitiveRejection) {
        await recordAuthorizationDefinitiveFailureInDb({
          paymentAttemptId: payment.payment_attempt_id,
          errorDetails: {
            error: err.message,
            status: err.status,
            debugId: err.debugId,
            details: err.details,
            timestamp: new Date().toISOString(),
          },
          notes: `Definitive rejection by PayPal: ${err.message}`,
        });

        return NextResponse.json(
          {
            success: false,
            error: `PayPal authorization definitively rejected: ${err.message}`,
            debugId: err.debugId,
          },
          { status: 422 }
        );
      }

      // Invalid response structure (e.g. missing authorization ID)
      const rawMsg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          success: false,
          error: `Invalid PayPal authorization response: ${rawMsg}`,
        },
        { status: 502 }
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PayPal Authorize Route Error]:", msg);
    return NextResponse.json(
      { success: false, error: `Internal server error: ${msg}` },
      { status: 500 }
    );
  } finally {
    if (lockedPaymentAttemptId) {
      releaseAuthLock(lockedPaymentAttemptId);
    }
  }
}
