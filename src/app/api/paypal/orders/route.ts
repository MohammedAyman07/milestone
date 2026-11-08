import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  validateMilestonePaymentEligibility,
  createPaymentAttemptRecord,
  updatePaymentWithOrderId,
  markPaymentAttemptFailed,
  markPaymentAttemptUncertain,
  reconcilePaymentAttemptOrder,
} from "@/lib/supabase/payments-db";
import {
  createPayPalOrder,
  getPayPalOrder,
  getPayPalIdempotencyRetentionConfig,
  DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
  MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
  resolveSafeCallbackUrls,
} from "@/lib/paypal/orders";
import {
  PayPalApiError,
  PayPalTimeoutError,
  PayPalNetworkError,
} from "@/lib/paypal/client";
import { recordAuditLogInDb } from "@/lib/supabase/db";

export const dynamic = "force-dynamic";

// Configurable PayPal Orders v2 idempotency retention window
// Default: 6 hours (standard PayPal policy). Extended: up to 72 hours (with Account Manager agreement).
export const PAYPAL_IDEMPOTENCY_RETENTION_MS = DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000;

// In-flight concurrency lock per milestone (TTL: 30s) to prevent race conditions
const inFlightMilestoneLocks = new Map<string, number>();

function acquireMilestoneLock(milestoneId: string): boolean {
  const now = Date.now();
  const lockedAt = inFlightMilestoneLocks.get(milestoneId);
  if (lockedAt && now - lockedAt < 30000) {
    return false; // Still locked
  }
  inFlightMilestoneLocks.set(milestoneId, now);
  return true;
}

function releaseMilestoneLock(milestoneId: string): void {
  inFlightMilestoneLocks.delete(milestoneId);
}

export async function POST(req: NextRequest) {
  // 1. Rate Limiting Check (per client IP)
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1";

  const rateCheck = checkRateLimit(`paypal-orders:${clientIp}`, 20, 60000);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded. Please wait before creating another payment order.",
        retryAfterMs: rateCheck.resetMs,
      },
      {
        status: 429,
        headers: {
          "Retry-After": Math.ceil(rateCheck.resetMs / 1000).toString(),
        },
      }
    );
  }

  // 2. Parse request payload early to extract milestoneId for concurrency lock
  const body = await req.json().catch(() => null);
  if (!body || !body.milestoneId || typeof body.milestoneId !== "string") {
    return NextResponse.json(
      { error: "Invalid request: milestoneId is required." },
      { status: 400 }
    );
  }

  const milestoneId = body.milestoneId.trim();
  const providedProjectId = body.projectId ? String(body.projectId).trim() : undefined;

  // 3. Acquire in-flight lock for this milestone
  if (!acquireMilestoneLock(milestoneId)) {
    return NextResponse.json(
      {
        error: "A payment order creation request for this milestone is currently in progress. Please wait.",
        inFlight: true,
      },
      { status: 409 }
    );
  }

  try {
    // 4. Authenticate the current user through Supabase (cookies or Authorization header)
    const supabase = await createServerSupabaseClient();
    let user: { id: string; email?: string } | null = null;

    // Check Bearer token first if supplied in headers
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey =
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (supabaseUrl && supabaseAnonKey && token) {
        const { createClient } = await import("@supabase/supabase-js");
        const tokenClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: tokenUserData } = await tokenClient.auth.getUser(token);
        if (tokenUserData?.user) {
          user = tokenUserData.user;
        }
      }
    }

    // Fall back to server cookie session
    if (!user && supabase) {
      const {
        data: { user: cookieUser },
      } = await supabase.auth.getUser();
      if (cookieUser) {
        user = cookieUser;
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to authorize payments." },
        { status: 401 }
      );
    }

    // 5. Validate milestone payment eligibility & client ownership on the server
    const eligibility = await validateMilestonePaymentEligibility(
      milestoneId,
      user.id,
      providedProjectId
    );

    // Resolve trusted return and cancel URLs (Phase 9.1.1 Security Hardening)
    // Prevents Host Header Injection and Open Redirect attacks
    const { returnUrl, cancelUrl } = resolveSafeCallbackUrls(req, {
      returnUrl: body.returnUrl,
      cancelUrl: body.cancelUrl,
    });

    // -----------------------------------------------------------------------
    // Case A: Existing Unapproved Order Detected (Idempotent replay)
    // -----------------------------------------------------------------------
    if (eligibility.existingOrder) {
      const existing = eligibility.existingOrder;
      let approvalUrl = existing.approvalUrl;

      // Validate approval URL before returning; if missing or invalid, retrieve fresh from PayPal
      if (!approvalUrl || !approvalUrl.startsWith("http")) {
        try {
          const freshOrder = await getPayPalOrder(existing.orderId);
          approvalUrl = freshOrder.links?.find((l) => l.rel === "approve")?.href;
          if (approvalUrl) {
            await updatePaymentWithOrderId(existing.paymentAttemptId, existing.orderId, freshOrder);
          }
        } catch (fetchErr) {
          console.warn("Failed to retrieve fresh PayPal order details during duplicate check:", fetchErr);
        }
      }

      if (!approvalUrl) {
        return NextResponse.json(
          {
            error: "An active order exists, but buyer approval link could not be verified. Please retry reconciliation shortly.",
            paymentAttemptId: existing.paymentAttemptId,
            orderId: existing.orderId,
            reconciliationPending: true,
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        {
          success: true,
          orderId: existing.orderId,
          approvalUrl,
          paymentAttemptId: existing.paymentAttemptId,
          isExisting: true,
        },
        { status: 200 }
      );
    }

    // -----------------------------------------------------------------------
    // Case B: Uncertain In-Flight/Prior Attempt Detected -> Reconcile
    // -----------------------------------------------------------------------
    if (eligibility.uncertainAttempt) {
      const uncertain = eligibility.uncertainAttempt;
      const milestone = eligibility.milestone;

      if (!milestone) {
        return NextResponse.json(
          { error: "Internal Error: Milestone details missing for reconciliation." },
          { status: 500 }
        );
      }

      // Check PayPal Idempotency Retention Window (Default: 6h; Extended: up to 72h with confirmed account)
      const retentionConfig = getPayPalIdempotencyRetentionConfig();
      const attemptCreatedAt = uncertain.createdAt ? new Date(uncertain.createdAt).getTime() : 0;
      const attemptAgeMs = Date.now() - attemptCreatedAt;

      if (attemptCreatedAt > 0 && attemptAgeMs > retentionConfig.retentionMs) {
        // RETENTION EXPIRED: Do NOT blindly replay!
        // PayPal purges idempotency keys after the retention window; replaying risks creating duplicate charges.
        await recordAuditLogInDb({
          actorId: user.id,
          projectId: milestone.projectId,
          milestoneId: milestone.id,
          action: "PAYPAL_ORDER_RECONCILIATION_EXPIRED",
          entityType: "payment",
          entityId: uncertain.id,
          newState: {
            paymentAttemptId: uncertain.paymentAttemptId,
            attemptAgeHours: (attemptAgeMs / (3600 * 1000)).toFixed(1),
            retentionLimitHours: retentionConfig.retentionHours,
            extendedConfirmed: retentionConfig.isExtendedConfirmed,
            configSource: retentionConfig.source,
            reason: "PayPal idempotency retention window expired; automated replay blocked to prevent duplicate orders.",
          },
        });

        return NextResponse.json(
          {
            success: false,
            outcome: "RECONCILIATION_EXPIRED",
            reconciliationPending: true,
            error: `The PayPal idempotency retention window (${retentionConfig.retentionHours} hours) for this uncertain attempt has expired (${(attemptAgeMs / (3600 * 1000)).toFixed(1)}h elapsed). Automated replay is disabled to prevent duplicate charges. Manual merchant reconciliation is required.`,
            paymentAttemptId: uncertain.paymentAttemptId,
            retentionLimitHours: retentionConfig.retentionHours,
            isExtendedConfirmed: retentionConfig.isExtendedConfirmed,
          },
          { status: 409 }
        );
      }

      // Record audit log for reconciliation start
      await recordAuditLogInDb({
        actorId: user.id,
        projectId: milestone.projectId,
        milestoneId: milestone.id,
        action: "PAYPAL_ORDER_RECONCILIATION_STARTED",
        entityType: "payment",
        entityId: uncertain.id,
        newState: {
          paymentAttemptId: uncertain.paymentAttemptId,
          idempotencyKey: uncertain.idempotencyOrderCreate,
        },
      });

      // Attempt reconciliation by calling PayPal with the ORIGINAL idempotency key and attempt ID
      try {
        const reconciledOrder = await createPayPalOrder({
          milestoneId: milestone.id,
          projectId: milestone.projectId,
          milestoneTitle: milestone.title,
          amount: milestone.amount,
          currency: "USD",
          returnUrl,
          cancelUrl,
          idempotencyKey: uncertain.idempotencyOrderCreate, // REUSE original key
          paymentAttemptId: uncertain.paymentAttemptId,     // REUSE original attempt ID
        });

        // Reconciled successfully! Persist order ID and raw response
        await reconcilePaymentAttemptOrder(
          uncertain.paymentAttemptId,
          reconciledOrder.orderId,
          reconciledOrder.raw,
          "Reconciliation confirmed order creation via idempotent replay"
        );

        // Record audit log
        await recordAuditLogInDb({
          actorId: user.id,
          projectId: milestone.projectId,
          milestoneId: milestone.id,
          action: "PAYPAL_ORDER_RECONCILIATION_SUCCEEDED",
          entityType: "payment",
          entityId: uncertain.id,
          newState: {
            orderId: reconciledOrder.orderId,
            paymentAttemptId: uncertain.paymentAttemptId,
          },
        });

        return NextResponse.json(
          {
            success: true,
            orderId: reconciledOrder.orderId,
            approvalUrl: reconciledOrder.approvalUrl,
            paymentAttemptId: uncertain.paymentAttemptId,
            reconciled: true,
          },
          { status: 200 }
        );
      } catch (recErr: unknown) {
        const isDefinitive =
          recErr instanceof PayPalApiError && recErr.isDefinitiveRejection;

        if (isDefinitive) {
          // PayPal explicitly rejected the request: Order definitely does not exist
          await markPaymentAttemptFailed(uncertain.paymentAttemptId, {
            error: recErr.message,
            definitive: true,
            status: (recErr as PayPalApiError).status,
            reconciledAt: new Date().toISOString(),
          });

          await recordAuditLogInDb({
            actorId: user.id,
            projectId: milestone.projectId,
            milestoneId: milestone.id,
            action: "PAYPAL_ORDER_CREATION_FAILED",
            entityType: "payment",
            entityId: uncertain.id,
            newState: {
              error: recErr.message,
              definitive: true,
            },
          });

          return NextResponse.json(
            {
              error: `PayPal rejected order creation during reconciliation: ${recErr.message}`,
              paymentAttemptId: uncertain.paymentAttemptId,
              definitive: true,
            },
            { status: 400 }
          );
        }

        // Still uncertain / timeout / 5xx
        await recordAuditLogInDb({
          actorId: user.id,
          projectId: milestone.projectId,
          milestoneId: milestone.id,
          action: "PAYPAL_ORDER_RECONCILIATION_PENDING",
          entityType: "payment",
          entityId: uncertain.id,
          newState: {
            error: recErr instanceof Error ? recErr.message : String(recErr),
            outcome: "UNCERTAIN",
          },
        });

        return NextResponse.json(
          {
            success: false,
            outcome: "UNCERTAIN",
            reconciliationPending: true,
            error:
              "PayPal order creation outcome remains uncertain. Transaction is protected in reconciliation. Do not initiate a second payment attempt.",
            paymentAttemptId: uncertain.paymentAttemptId,
          },
          { status: 202 }
        );
      }
    }

    // -----------------------------------------------------------------------
    // Case C: Standard Eligibility Failure
    // -----------------------------------------------------------------------
    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: eligibility.error || "Milestone is not eligible for payment." },
        { status: eligibility.httpStatus }
      );
    }

    const milestone = eligibility.milestone!;
    const project = eligibility.project!;

    // -----------------------------------------------------------------------
    // Case D: Fresh Payment Attempt Creation
    // -----------------------------------------------------------------------
    // 1. Persist a CREATED payment attempt before calling PayPal
    const attemptResult = await createPaymentAttemptRecord({
      milestoneId: milestone.id,
      projectId: milestone.projectId,
      clientId: user.id,
      freelancerId: project.freelancerId,
      amount: milestone.amount,
      currency: "USD",
    });

    if (!attemptResult.success || !attemptResult.payment) {
      const isConflict = (attemptResult as any).isConflict;
      return NextResponse.json(
        {
          error: attemptResult.error || "Failed to initialize payment record.",
          conflict: isConflict || false,
        },
        { status: 409 }
      );
    }

    const paymentAttempt = attemptResult.payment;

    // Record audit event: creation initiated
    await recordAuditLogInDb({
      actorId: user.id,
      projectId: milestone.projectId,
      milestoneId: milestone.id,
      action: "PAYPAL_ORDER_CREATION_INITIATED",
      entityType: "payment",
      entityId: paymentAttempt.id,
      newState: {
        paymentAttemptId: paymentAttempt.paymentAttemptId,
        idempotencyKey: paymentAttempt.idempotencyOrderCreate,
        amount: milestone.amount,
        currency: "USD",
      },
    });

    // 2. Call PayPal Orders v2 with intent: AUTHORIZE
    try {
      const orderResult = await createPayPalOrder({
        milestoneId: milestone.id,
        projectId: milestone.projectId,
        milestoneTitle: milestone.title,
        amount: milestone.amount,
        currency: "USD",
        returnUrl,
        cancelUrl,
        idempotencyKey: paymentAttempt.idempotencyOrderCreate,
        paymentAttemptId: paymentAttempt.paymentAttemptId,
      });

      // 3. Persist the returned PayPal order ID in Supabase
      await updatePaymentWithOrderId(
        paymentAttempt.paymentAttemptId,
        orderResult.orderId,
        orderResult.raw
      );

      // 4. Record audit event: creation confirmed
      await recordAuditLogInDb({
        actorId: user.id,
        projectId: milestone.projectId,
        milestoneId: milestone.id,
        action: "PAYPAL_ORDER_CREATED",
        entityType: "payment",
        entityId: paymentAttempt.id,
        newState: {
          orderId: orderResult.orderId,
          paymentAttemptId: paymentAttempt.paymentAttemptId,
          amount: milestone.amount,
          currency: "USD",
          status: "CREATED",
        },
      });

      // 5. Return only safe public details to the browser
      return NextResponse.json(
        {
          success: true,
          orderId: orderResult.orderId,
          approvalUrl: orderResult.approvalUrl,
          paymentAttemptId: paymentAttempt.paymentAttemptId,
        },
        { status: 201 }
      );
    } catch (paypalErr: unknown) {
      const errMsg = paypalErr instanceof Error ? paypalErr.message : String(paypalErr);
      const isDefinitive =
        paypalErr instanceof PayPalApiError && paypalErr.isDefinitiveRejection;

      if (isDefinitive) {
        // DEFINITIVE REJECTION: Mark failed so future legitimate attempts are permitted
        await markPaymentAttemptFailed(paymentAttempt.paymentAttemptId, {
          error: errMsg,
          definitive: true,
          status: (paypalErr as PayPalApiError).status,
          failedAt: new Date().toISOString(),
        });

        await recordAuditLogInDb({
          actorId: user.id,
          projectId: milestone.projectId,
          milestoneId: milestone.id,
          action: "PAYPAL_ORDER_CREATION_FAILED",
          entityType: "payment",
          entityId: paymentAttempt.id,
          newState: {
            error: errMsg,
            paymentAttemptId: paymentAttempt.paymentAttemptId,
            definitive: true,
          },
        });

        return NextResponse.json(
          {
            error: `PayPal order creation rejected: ${errMsg}`,
            paymentAttemptId: paymentAttempt.paymentAttemptId,
            definitive: true,
          },
          { status: 400 }
        );
      }

      // UNCERTAIN OUTCOME (Timeout, 5xx, or network failure)
      // DO NOT MARK FAILED. Preserve CREATED state with manual_reconciliation_required = true
      await markPaymentAttemptUncertain(
        paymentAttempt.paymentAttemptId,
        {
          error: errMsg,
          outcome: "UNCERTAIN",
          errorType: paypalErr instanceof Error ? paypalErr.name : "UNKNOWN",
          timestamp: new Date().toISOString(),
        },
        `Uncertain outcome on order creation: ${errMsg}. Reconcile with idempotency key ${paymentAttempt.idempotencyOrderCreate}`
      );

      await recordAuditLogInDb({
        actorId: user.id,
        projectId: milestone.projectId,
        milestoneId: milestone.id,
        action: "PAYPAL_ORDER_CREATION_UNCERTAIN",
        entityType: "payment",
        entityId: paymentAttempt.id,
        newState: {
          error: errMsg,
          paymentAttemptId: paymentAttempt.paymentAttemptId,
          idempotencyKey: paymentAttempt.idempotencyOrderCreate,
          outcome: "UNCERTAIN",
        },
      });

      return NextResponse.json(
        {
          success: false,
          outcome: "UNCERTAIN",
          reconciliationPending: true,
          error: `PayPal order creation outcome is uncertain (${errMsg}). The transaction is held in reconciliation. Do not initiate a second charge.`,
          paymentAttemptId: paymentAttempt.paymentAttemptId,
        },
        { status: 202 }
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Internal Server Error: ${msg}` },
      { status: 500 }
    );
  } finally {
    releaseMilestoneLock(milestoneId);
  }
}
