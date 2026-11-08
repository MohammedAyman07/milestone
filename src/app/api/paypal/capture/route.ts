import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  capturePayPalAuthorization,
  getPayPalAuthorization,
} from "@/lib/paypal/payments";
import { PayPalApiError, PayPalTimeoutError } from "@/lib/paypal/client";
import {
  recordCaptureInitiatedInDb,
  recordCaptureSuccessInDb,
  recordCaptureUncertainInDb,
  recordCaptureDefinitiveFailureInDb,
} from "@/lib/supabase/payments-db";
import { recordAuditLogInDb } from "@/lib/supabase/db";
import { getPayPalIdempotencyRetentionConfig } from "@/lib/paypal/orders";

// In-flight concurrency lock to prevent duplicate capture calls for the same payment attempt (TTL: 30s)
const activeCaptureLocks = new Map<string, number>();

function acquireCaptureLock(paymentAttemptId: string): boolean {
  const now = Date.now();
  const existingTimestamp = activeCaptureLocks.get(paymentAttemptId);
  if (existingTimestamp && now - existingTimestamp < 30000) {
    return false; // Lock active
  }
  activeCaptureLocks.set(paymentAttemptId, now);
  return true;
}

function releaseCaptureLock(paymentAttemptId: string): void {
  activeCaptureLocks.delete(paymentAttemptId);
}

// Request payload validation
const CaptureRequestSchema = z.object({
  paymentAttemptId: z.string().min(1, "paymentAttemptId is required"),
  milestoneId: z.string().optional(),
  confirmed: z.boolean().optional(),
});

// Helper: Authenticate user from Supabase session or Bearer token
async function getAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    const admin = createAdminClient();
    if (admin) {
      const { data, error } = await admin.auth.getUser(token);
      if (!error && data?.user) {
        return data.user;
      }
    }
  }

  const supabase = await createServerSupabaseClient();
  if (supabase) {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user) {
      return data.user;
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  let paymentAttemptIdForLock: string | null = null;

  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized: An authenticated session is required to capture payment." },
        { status: 401 }
      );
    }

    // 2. Parse request body
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    const parsed = CaptureRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid capture request parameters.",
          details: parsed.error.format(),
        },
        { status: 400 }
      );
    }

    const { paymentAttemptId, milestoneId: clientSuppliedMilestoneId } = parsed.data;
    paymentAttemptIdForLock = paymentAttemptId;

    const admin = createAdminClient();
    const supabase = admin || (await createServerSupabaseClient());
    if (!supabase) {
      return NextResponse.json(
        { error: "Database client unavailable." },
        { status: 500 }
      );
    }

    // 3. Retrieve authoritative payment attempt record
    const { data: payment, error: pError } = await supabase
      .from("payments")
      .select("*")
      .eq("payment_attempt_id", paymentAttemptId)
      .single();

    if (pError || !payment) {
      return NextResponse.json(
        { error: `Payment attempt not found: ${paymentAttemptId}` },
        { status: 404 }
      );
    }

    // Milestone reference match check
    if (clientSuppliedMilestoneId && payment.milestone_id !== clientSuppliedMilestoneId) {
      return NextResponse.json(
        { error: "Security Violation: Payment attempt does not belong to the specified milestone." },
        { status: 400 }
      );
    }

    // 4. Retrieve authoritative milestone record
    const { data: milestone, error: mError } = await supabase
      .from("milestones")
      .select("id, project_id, amount, currency, status, payment_status, title")
      .eq("id", payment.milestone_id)
      .single();

    if (mError || !milestone) {
      return NextResponse.json(
        { error: "Associated milestone not found." },
        { status: 404 }
      );
    }

    // 5. Retrieve authoritative project record
    const { data: project, error: projError } = await supabase
      .from("projects")
      .select("id, client_id, freelancer_id")
      .eq("id", milestone.project_id)
      .single();

    if (projError || !project) {
      return NextResponse.json(
        { error: "Associated project not found." },
        { status: 404 }
      );
    }

    // 6. Role & Ownership Security Checks
    if (project.freelancer_id === user.id) {
      return NextResponse.json(
        { error: "Security Violation: Freelancers cannot capture payments." },
        { status: 403 }
      );
    }

    if (project.client_id !== user.id || payment.payer_id !== user.id) {
      return NextResponse.json(
        { error: "Forbidden: You are not authorized to capture payment for this project." },
        { status: 403 }
      );
    }

    // Check user profile role if present
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profile && profile.role === "freelancer") {
      return NextResponse.json(
        { error: "Security Violation: Freelancers cannot capture payments." },
        { status: 403 }
      );
    }

    // 7. Milestone Approval Gating
    // Rule: Milestone deliverables must be explicitly approved by the client before capturing payment
    if (milestone.status !== "approved" && milestone.status !== "completed") {
      return NextResponse.json(
        {
          error: `Cannot capture payment: Milestone deliverables must be explicitly approved by client before capturing payment. Current milestone status: ${milestone.status}.`,
        },
        { status: 400 }
      );
    }

    // 8. Idempotent check for already captured payment
    if (payment.status === "CAPTURED" || payment.status === "SETTLED") {
      return NextResponse.json({
        success: true,
        status: "CAPTURED",
        captureId: payment.capture_id,
        alreadyCaptured: true,
        amount: Number(payment.amount),
        currency: payment.currency,
        message: "Payment has already been captured.",
      });
    }

    // 9. Payment Status Eligibility Check
    if (payment.status !== "AUTHORIZED" && payment.status !== "CAPTURE_PENDING") {
      return NextResponse.json(
        {
          error: `Payment attempt cannot be captured. Current status: ${payment.status}; only AUTHORIZED payments can be captured.`,
        },
        { status: 400 }
      );
    }

    // 10. PayPal Authorization ID check
    if (!payment.authorization_id) {
      return NextResponse.json(
        { error: "Security Violation: Payment attempt has no valid PayPal authorization ID." },
        { status: 400 }
      );
    }

    // 11. Currency Check (USD only)
    if (payment.currency !== "USD") {
      return NextResponse.json(
        { error: `Currency Violation: Payment currency '${payment.currency}' is not supported (USD required).` },
        { status: 400 }
      );
    }

    // 12. Authorization Expiry Check
    if (payment.authorization_expires_at) {
      const expiresAt = new Date(payment.authorization_expires_at);
      if (expiresAt.getTime() <= Date.now()) {
        return NextResponse.json(
          {
            error: `Authorization Expired: The PayPal authorization expired at ${payment.authorization_expires_at} and cannot be captured.`,
            status: "EXPIRED",
          },
          { status: 409 }
        );
      }
    }

    // 12b. Check PayPal Idempotency Retention Window for Uncertain Replays
    const retentionConfig = getPayPalIdempotencyRetentionConfig();
    const attemptTimeStr =
      payment.capture_initiated_at ||
      payment.error_details?.timestamp ||
      payment.updated_at ||
      payment.created_at;
    const attemptAgeMs = Date.now() - new Date(attemptTimeStr).getTime();

    if (
      (payment.status === "CAPTURE_PENDING" || payment.manual_reconciliation_required) &&
      attemptAgeMs > retentionConfig.retentionMs
    ) {
      const elapsedHours = (attemptAgeMs / (1000 * 60 * 60)).toFixed(1);

      // Attempt read-only ground-truth reconciliation via getPayPalAuthorization
      try {
        const checkAuth = await getPayPalAuthorization(payment.authorization_id);
        const captures = checkAuth.payments?.captures || [];
        const completed = captures.find((c) => c.status === "COMPLETED");
        if (completed) {
          // Reconcile database state to CAPTURED
          await recordCaptureSuccessInDb({
            paymentAttemptId,
            authorizationId: payment.authorization_id,
            captureId: completed.id,
            rawPayload: checkAuth,
          });
          return NextResponse.json({
            success: true,
            status: "CAPTURED",
            captureId: completed.id,
            reconciled: true,
            amount: Number(payment.amount),
            currency: "USD",
            message: "Payment capture reconciled via PayPal authorization state.",
          });
        }
      } catch (checkErr) {
        console.warn("Read-only reconciliation check failed for expired retention attempt:", checkErr);
      }

      // Record audit log for expired retention window
      await recordAuditLogInDb({
        actorId: user.id,
        projectId: project.id,
        milestoneId: milestone.id,
        action: "PAYPAL_CAPTURE_RECONCILIATION_EXPIRED",
        entityType: "payment",
        entityId: payment.id,
        newState: {
          paymentAttemptId: payment.payment_attempt_id,
          attemptAgeHours: elapsedHours,
          retentionLimitHours: retentionConfig.retentionHours,
          extendedConfirmed: retentionConfig.isExtendedConfirmed,
          configSource: retentionConfig.source,
          reason: "PayPal capture idempotency retention window expired; automated replay blocked to prevent duplicate charges.",
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: `The PayPal idempotency retention window (${retentionConfig.retentionHours} hours) for this uncertain capture has expired (${elapsedHours}h elapsed). Automated replay is blocked to prevent duplicate charges. Manual merchant reconciliation is required.`,
          code: "RECONCILIATION_EXPIRED",
          retentionLimitHours: retentionConfig.retentionHours,
          isExtendedConfirmed: retentionConfig.isExtendedConfirmed,
        },
        { status: 409 }
      );
    }

    // 13. Acquire In-Flight Concurrency Lock (In-Memory Mutex)
    if (!acquireCaptureLock(paymentAttemptId)) {
      return NextResponse.json(
        {
          error: "Concurrent Request: A capture request is already in progress for this payment attempt. Please wait.",
          retryable: true,
        },
        { status: 409 }
      );
    }

    // 14. Safe Capture Lifecycle: Determine & Persist Operation-Specific Idempotency Key
    const idempotencyKey =
      payment.idempotency_auth_capture ||
      `cap_${payment.payment_attempt_id}`;

    // Persist CAPTURE_PENDING with Atomic Database Concurrency Guard
    const initResult = await recordCaptureInitiatedInDb({
      paymentAttemptId,
      authorizationId: payment.authorization_id,
      idempotencyKey,
    });

    if (!initResult.success) {
      if (initResult.conflict) {
        return NextResponse.json(
          {
            error: "Concurrent Request: Another server process is already capturing this payment attempt. Please wait.",
            retryable: true,
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: `Failed to initiate capture in database: ${initResult.error}` },
        { status: 500 }
      );
    }

    // 15. Reconciliation Check: Query PayPal authorization to verify if capture already completed
    try {
      const existingAuth = await getPayPalAuthorization(payment.authorization_id);
      const existingCaptures = existingAuth.payments?.captures || [];
      const completedCapture = existingCaptures.find(
        (c) => c.status === "COMPLETED" || c.status === "PENDING"
      );

      if (completedCapture && completedCapture.status === "COMPLETED") {
        // Validate amount and currency on completed capture
        const captureVal = parseFloat(completedCapture.amount?.value || "0");
        const captureCur = completedCapture.amount?.currency_code || "USD";

        if (captureVal !== Number(payment.amount)) {
          return NextResponse.json(
            {
              error: `Financial Integrity Violation: Completed capture amount ($${captureVal.toFixed(2)}) does not match payment amount ($${Number(payment.amount).toFixed(2)}).`,
            },
            { status: 400 }
          );
        }

        if (captureCur !== "USD") {
          return NextResponse.json(
            {
              error: `Currency Violation: Completed capture currency '${captureCur}' does not match required currency 'USD'.`,
            },
            { status: 400 }
          );
        }

        // Reconcile database state to CAPTURED
        await recordCaptureSuccessInDb({
          paymentAttemptId,
          authorizationId: payment.authorization_id,
          captureId: completedCapture.id,
          rawPayload: existingAuth,
        });

        return NextResponse.json({
          success: true,
          status: "CAPTURED",
          captureId: completedCapture.id,
          reconciled: true,
          amount: Number(payment.amount),
          currency: "USD",
          message: "Payment capture confirmed and reconciled via PayPal authorization state. Standard PayPal merchant capture pays the merchant account.",
        });
      }

      // Check if authorization was already expired or voided on PayPal
      if (existingAuth.status === "EXPIRED") {
        const adminClient = createAdminClient();
        if (adminClient) {
          await adminClient
            .from("payments")
            .update({ status: "EXPIRED", updated_at: new Date().toISOString() })
            .eq("id", payment.id);
        }
        return NextResponse.json(
          {
            error: "Authorization Expired: The PayPal authorization has expired on PayPal and cannot be captured.",
            status: "EXPIRED",
          },
          { status: 409 }
        );
      }

      if (existingAuth.status === "VOIDED") {
        const adminClient = createAdminClient();
        if (adminClient) {
          await adminClient
            .from("payments")
            .update({ status: "VOIDED", updated_at: new Date().toISOString() })
            .eq("id", payment.id);
        }
        return NextResponse.json(
          {
            error: "Authorization Voided: The PayPal authorization has been voided on PayPal and cannot be captured.",
            status: "VOIDED",
          },
          { status: 409 }
        );
      }
    } catch (reconcileErr) {
      console.warn("Pre-capture reconciliation query failed:", reconcileErr);
      // CRITICAL RECOVERY GUARD:
      // If payment was already CAPTURE_PENDING (prior uncertain attempt), and PayPal API is unavailable,
      // WE MUST NOT BLINDLY DISPATCH A SECOND CAPTURE!
      if (payment.status === "CAPTURE_PENDING" || payment.manual_reconciliation_required) {
        return NextResponse.json(
          {
            error: "Upstream PayPal service unavailable during reconciliation of uncertain capture attempt. Preserved in CAPTURE_PENDING status. Automated re-capture is withheld until PayPal status can be verified.",
            retryable: true,
            status: "CAPTURE_PENDING",
            requiresReconciliation: true,
          },
          { status: 504 }
        );
      }
    }

    // 16. Outbound PayPal Capture Call via Payments v2
    // POST /v2/payments/authorizations/{authorization_id}/capture
    let captureResult;
    try {
      captureResult = await capturePayPalAuthorization({
        authorizationId: payment.authorization_id,
        amount: Number(payment.amount),
        currency: "USD",
        idempotencyKey,
        noteToPayer: `Milestone AI client-approved capture for ${milestone.title}`,
      });
    } catch (captureErr: unknown) {
      const isTimeout =
        captureErr instanceof PayPalTimeoutError ||
        (captureErr instanceof PayPalApiError && (captureErr.status === 504 || captureErr.status === 408));
      const isServerError =
        captureErr instanceof PayPalApiError && captureErr.status >= 500 && captureErr.status < 600;

      // UNCERTAIN OUTCOME: Network timeout, socket disconnect, or 5xx server error
      if (isTimeout || isServerError) {
        const errorDetails = {
          error: captureErr instanceof Error ? captureErr.message : String(captureErr),
          status: captureErr instanceof PayPalApiError ? captureErr.status : 504,
          timestamp: new Date().toISOString(),
          type: isTimeout ? "TIMEOUT" : "5XX_SERVER_ERROR",
        };

        // NEVER mark the payment FAILED automatically. Preserve CAPTURE_PENDING!
        await recordCaptureUncertainInDb({
          paymentAttemptId,
          authorizationId: payment.authorization_id,
          errorDetails,
        });

        // Attempt ground-truth query
        try {
          const authOnPayPal = await getPayPalAuthorization(payment.authorization_id);
          const captures = authOnPayPal.payments?.captures || [];
          const matchedCapture = captures.find((c) => c.status === "COMPLETED");

          if (matchedCapture) {
            await recordCaptureSuccessInDb({
              paymentAttemptId,
              authorizationId: payment.authorization_id,
              captureId: matchedCapture.id,
              rawPayload: authOnPayPal,
            });

            return NextResponse.json({
              success: true,
              status: "CAPTURED",
              captureId: matchedCapture.id,
              reconciled: true,
              amount: Number(payment.amount),
              currency: "USD",
              message: "Capture succeeded on PayPal despite network error; locally reconciled to CAPTURED.",
            });
          }
        } catch {
          // Fall through to retryable response
        }

        const statusCode = isTimeout ? 504 : 502;
        return NextResponse.json(
          {
            error: `PayPal capture request timed out or returned upstream server error (${errorDetails.status}). The attempt is preserved in CAPTURE_PENDING status. Please retry to reconcile.`,
            retryable: true,
            status: "CAPTURE_PENDING",
            requiresReconciliation: true,
          },
          { status: statusCode }
        );
      }

      // DEFINITIVE PAYPAL REJECTION OR AMBIGUOUS 4XX
      if (captureErr instanceof PayPalApiError) {
        // Inspect actual PayPal error details for already-captured cases
        const detailsList = Array.isArray(captureErr.details) ? captureErr.details : [];
        const issue = (detailsList[0] as { issue?: string } | undefined)?.issue || "";
        const isAlreadyCaptured =
          issue === "AUTHORIZATION_ALREADY_CAPTURED" ||
          issue === "MAX_CAPTURE_COUNT_EXCEEDED" ||
          captureErr.name === "AUTHORIZATION_ALREADY_CAPTURED" ||
          captureErr.message.toLowerCase().includes("already been captured") ||
          captureErr.message.toLowerCase().includes("already captured");

        if (isAlreadyCaptured) {
          // PayPal indicates the capture already took place! Reconcile!
          try {
            const authAfterCapture = await getPayPalAuthorization(payment.authorization_id);
            const captures = authAfterCapture.payments?.captures || [];
            const completed = captures.find(
              (c) => c.status === "COMPLETED" || c.status === "PENDING"
            );

            if (completed && completed.status === "COMPLETED") {
              await recordCaptureSuccessInDb({
                paymentAttemptId,
                authorizationId: payment.authorization_id,
                captureId: completed.id,
                rawPayload: authAfterCapture,
              });

              return NextResponse.json({
                success: true,
                status: "CAPTURED",
                captureId: completed.id,
                reconciled: true,
                amount: Number(payment.amount),
                currency: "USD",
                message: "Capture confirmed and reconciled via PayPal authorization after already-captured report.",
              });
            }
          } catch (recErr) {
            console.warn("Failed to fetch authorization during already-captured reconciliation:", recErr);
          }

          // If ground truth couldn't be fetched immediately, preserve in CAPTURE_PENDING! NEVER mark FAILED!
          await recordCaptureUncertainInDb({
            paymentAttemptId,
            authorizationId: payment.authorization_id,
            errorDetails: {
              issue,
              message: captureErr.message,
              note: "PayPal indicated authorization already captured; awaiting reconciliation.",
            },
          });

          return NextResponse.json(
            {
              error: "PayPal reported authorization already captured; awaiting reconciliation.",
              status: "CAPTURE_PENDING",
              retryable: true,
              requiresReconciliation: true,
            },
            { status: 502 }
          );
        }

        const errPayload = {
          name: captureErr.name,
          status: captureErr.status,
          message: captureErr.message,
          debugId: captureErr.debugId,
          details: captureErr.details,
          timestamp: new Date().toISOString(),
        };

        // Mark definitive failure
        await recordCaptureDefinitiveFailureInDb({
          paymentAttemptId,
          authorizationId: payment.authorization_id,
          errorDetails: errPayload,
        });

        return NextResponse.json(
          {
            error: `PayPal capture rejected: ${captureErr.message}`,
            details: captureErr.details,
            status: "FAILED",
            definitive: true,
          },
          { status: captureErr.status }
        );
      }

      throw captureErr;
    }

    // 17. Successful Capture Response Validation
    if (!captureResult || !captureResult.captureId) {
      return NextResponse.json(
        { error: "Invalid PayPal capture response: No capture ID returned." },
        { status: 502 }
      );
    }

    if (captureResult.status !== "COMPLETED") {
      // If status is PENDING, keep in CAPTURE_PENDING
      return NextResponse.json({
        success: true,
        status: "CAPTURE_PENDING",
        captureId: captureResult.captureId,
        message: `PayPal capture is pending settlement (Status: ${captureResult.status}).`,
      });
    }

    // Validate amount and currency
    if (captureResult.amount !== Number(payment.amount)) {
      return NextResponse.json(
        {
          error: `Financial Integrity Violation: Captured amount ($${captureResult.amount.toFixed(2)}) does not match expected amount ($${Number(payment.amount).toFixed(2)}).`,
        },
        { status: 400 }
      );
    }

    if (captureResult.currency !== "USD") {
      return NextResponse.json(
        { error: `Currency Violation: Captured currency '${captureResult.currency}' does not match required currency 'USD'.` },
        { status: 400 }
      );
    }

    // 18. Persist CAPTURED state in database
    await recordCaptureSuccessInDb({
      paymentAttemptId,
      authorizationId: payment.authorization_id,
      captureId: captureResult.captureId,
      rawPayload: captureResult.raw,
    });

    return NextResponse.json({
      success: true,
      status: "CAPTURED",
      captureId: captureResult.captureId,
      amount: Number(payment.amount),
      currency: "USD",
      message: "Payment captured successfully via PayPal Payments v2. Standard PayPal merchant capture pays the merchant account receiving the transaction.",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error in POST /api/paypal/capture:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (paymentAttemptIdForLock) {
      releaseCaptureLock(paymentAttemptIdForLock);
    }
  }
}
