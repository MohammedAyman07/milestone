import { paypalRequest, getPayPalConfig } from "./client";
import { createAdminClient } from "../supabase/admin";
import { recordAuditLogInDb } from "../supabase/db";

export interface WebhookVerificationParams {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
  webhookId?: string;
  webhookEvent: Record<string, unknown>;
}

export interface WebhookPersistenceParams {
  transmissionId: string;
  eventId: string;
  eventType: string;
  resourceId: string;
  resourceType: string;
  eventTimestamp: string;
  signatureVerified: boolean;
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "FAILED";
  rawEvent: Record<string, unknown>;
}

export type WebhookOutcome =
  | "PROCESSED"
  | "IGNORED"
  | "IGNORED_TERMINAL"
  | "MISMATCH"
  | "UNMATCHED"
  | "FAILED";

export interface WebhookProcessResult {
  success: boolean;
  outcome: WebhookOutcome;
  message?: string;
  error?: string;
}

/**
 * 1. Verify PayPal webhook signature using PayPal's official API:
 * POST /v1/notifications/verify-webhook-signature
 */
export async function verifyPayPalWebhookSignature(
  params: WebhookVerificationParams
): Promise<boolean> {
  const { webhookId: configWebhookId } = getPayPalConfig();
  const effectiveWebhookId = params.webhookId || configWebhookId;

  if (!effectiveWebhookId || !params.transmissionSig) {
    return false;
  }

  try {
    const payload = {
      auth_algo: params.authAlgo,
      cert_url: params.certUrl,
      transmission_id: params.transmissionId,
      transmission_sig: params.transmissionSig,
      transmission_time: params.transmissionTime,
      webhook_id: effectiveWebhookId,
      webhook_event: params.webhookEvent,
    };

    const response = await paypalRequest<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        body: payload,
      }
    );

    return response.data?.verification_status === "SUCCESS";
  } catch (err: unknown) {
    console.warn("PayPal webhook verification request failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * 2. Deduplicate and persist webhook event in paypal_webhook_events
 */
export async function recordWebhookEventInDb(
  params: WebhookPersistenceParams
): Promise<{ success: boolean; isDuplicate?: boolean; recordId?: string; status?: string; error?: string }> {
  const supabase = createAdminClient();
  if (!supabase) {
    return { success: false, error: "Database client unavailable." };
  }

  const lookupEventId = params.eventId || params.transmissionId;

  try {
    // Check if event already exists
    const { data: existing, error: selectErr } = await supabase
      .from("paypal_webhook_events")
      .select("id, payload, verification_status")
      .or(`transmission_id.eq.${lookupEventId},transmission_id.eq.${params.transmissionId}`)
      .maybeSingle();

    if (selectErr) {
      return { success: false, error: `Failed to query existing webhook event: ${selectErr.message}` };
    }

    if (existing) {
      const payloadObj = (existing.payload as Record<string, unknown>) || {};
      const processingStatus = String(payloadObj.processing_status || "PROCESSED");

      // If previous processing succeeded or was acknowledged/ignored, it is a true completed duplicate
      if (processingStatus === "PROCESSED" || processingStatus === "IGNORED") {
        return {
          success: true,
          isDuplicate: true,
          recordId: existing.id,
          status: processingStatus,
        };
      }

      // If previous execution was actively initiated less than 15s ago, guard concurrent in-flight worker
      const receivedAtMs = payloadObj.received_at ? new Date(String(payloadObj.received_at)).getTime() : 0;
      const ageMs = Date.now() - receivedAtMs;
      if (processingStatus === "PROCESSING" && ageMs < 15000) {
        return {
          success: true,
          isDuplicate: true,
          recordId: existing.id,
          status: "CONCURRENT_IN_FLIGHT",
        };
      }

      // If previous processing FAILED or was interrupted (>15s in PROCESSING): allow retry!
      const attempts = (Number(payloadObj.processing_attempts) || 1) + 1;
      const nowIso = new Date().toISOString();
      await supabase
        .from("paypal_webhook_events")
        .update({
          payload: {
            ...payloadObj,
            processing_status: "PROCESSING",
            processing_attempts: attempts,
            last_retry_at: nowIso,
          },
        })
        .eq("id", existing.id);

      return {
        success: true,
        isDuplicate: false, // NOT treated as duplicate; allows execution retry
        recordId: existing.id,
        status: "RETRY_PROCESSING",
      };
    }

    // Persist new verified webhook event
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertErr } = await supabase
      .from("paypal_webhook_events")
      .insert({
        transmission_id: lookupEventId,
        event_type: params.eventType,
        resource_id: params.resourceId,
        resource_type: params.resourceType,
        event_timestamp: params.eventTimestamp,
        signature_verified: params.signatureVerified,
        verification_status: params.verificationStatus,
        verified_at: params.signatureVerified ? nowIso : null,
        payload: {
          event_id: params.eventId,
          transmission_id: params.transmissionId,
          processing_status: "PROCESSING",
          processing_attempts: 1,
          received_at: nowIso,
          raw_event: params.rawEvent,
        },
      })
      .select("id, payload")
      .single();

    if (insertErr || !inserted) {
      // Handle race condition: concurrent duplicate delivery colliding on unique transmission_id
      const isUniqueConflict =
        insertErr?.message?.includes("unique") ||
        insertErr?.message?.includes("duplicate key") ||
        (insertErr as any)?.code === "23505";

      if (isUniqueConflict) {
        return {
          success: true,
          isDuplicate: true,
          status: "CONCURRENT_DUPLICATE",
        };
      }

      return {
        success: false,
        error: insertErr?.message || "Failed to persist webhook event record.",
      };
    }

    return {
      success: true,
      isDuplicate: false,
      recordId: inserted.id,
      status: "PROCESSING",
    };
  } catch (err: any) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unexpected database error persisting webhook.",
    };
  }
}

/**
 * 3. Update processing status and error in paypal_webhook_events
 */
export async function updateWebhookEventStatusInDb(
  recordId: string,
  status: "PROCESSED" | "IGNORED" | "FAILED",
  error?: string
): Promise<void> {
  const supabase = createAdminClient();
  if (!supabase) return;

  try {
    const { data: current } = await supabase
      .from("paypal_webhook_events")
      .select("payload")
      .eq("id", recordId)
      .maybeSingle();

    const currentPayload = (current?.payload as Record<string, unknown>) || {};
    const attempts = (Number(currentPayload.processing_attempts) || 1) + (status === "FAILED" ? 1 : 0);

    await supabase
      .from("paypal_webhook_events")
      .update({
        payload: {
          ...currentPayload,
          processing_status: status,
          processing_attempts: attempts,
          last_error: error || null,
          processed_at: new Date().toISOString(),
        },
        processed_at: new Date().toISOString(),
      })
      .eq("id", recordId);
  } catch (err) {
    console.warn("Failed to update webhook event status in DB:", err);
  }
}

/**
 * Helper to extract parent authorization ID from links or supplementary data
 */
function extractParentAuthorizationId(resource: Record<string, unknown>): string | null {
  const links = Array.isArray(resource.links) ? resource.links : [];
  const authLink = links.find(
    (l: any) => l && (l.rel === "up_to" || l.rel === "authorization") && typeof l.href === "string"
  );
  if (authLink) {
    const parts = authLink.href.split("/");
    const id = parts[parts.length - 1];
    if (id) return id;
  }

  const supplementaryData = (resource.supplementary_data as Record<string, unknown>) || {};
  const relatedIds = (supplementaryData.related_ids as Record<string, unknown>) || {};
  if (typeof relatedIds.authorization_id === "string" && relatedIds.authorization_id) {
    return relatedIds.authorization_id;
  }

  if (typeof resource.parent_payment === "string" && resource.parent_payment) {
    return resource.parent_payment;
  }

  return null;
}

/**
 * 4. Main Event Processing Dispatcher
 * Reconciles local payment & milestone records safely.
 * CRITICAL FINANCIAL INVARIANTS:
 * - NEVER initiates PayPal capture from a webhook.
 * - NEVER marks a payment as SETTLED from a capture webhook.
 * - NEVER regresses terminal states (CAPTURED cannot become AUTHORIZED or FAILED).
 * - Verifies amount and currency.
 */
export async function processPayPalWebhookEvent(
  webhookEvent: Record<string, unknown>
): Promise<WebhookProcessResult> {
  if (webhookEvent.debug_simulate_error && process.env.NODE_ENV !== "production") {
    throw new Error("Simulated transient processing failure");
  }

  const eventType = String(webhookEvent.event_type || "");
  const resource = (webhookEvent.resource as Record<string, unknown>) || {};

  switch (eventType) {
    case "PAYMENT.AUTHORIZATION.CREATED":
      return handleAuthorizationCreated(webhookEvent, resource);
    case "PAYMENT.AUTHORIZATION.VOIDED":
      return handleAuthorizationVoided(webhookEvent, resource);
    case "PAYMENT.CAPTURE.COMPLETED":
      return handleCaptureCompleted(webhookEvent, resource);
    case "PAYMENT.CAPTURE.DENIED":
      return handleCaptureDenied(webhookEvent, resource);
    case "PAYMENT.CAPTURE.PENDING":
      return handleCapturePending(webhookEvent, resource);
    default:
      return handleUnsupportedEvent(webhookEvent);
  }
}

/**
 * Handler: PAYMENT.AUTHORIZATION.CREATED
 */
async function handleAuthorizationCreated(
  webhookEvent: Record<string, unknown>,
  resource: Record<string, unknown>
): Promise<WebhookProcessResult> {
  const supabase = createAdminClient();
  if (!supabase) return { success: false, outcome: "FAILED", error: "Database client unavailable." };

  const authId = String(resource.id || "");
  const customId = typeof resource.custom_id === "string" ? resource.custom_id : "";
  const parentPayment = typeof resource.parent_payment === "string" ? resource.parent_payment : "";
  const amountObj = (resource.amount as Record<string, unknown>) || {};
  const webhookAmount = parseFloat(String(amountObj.value || "0"));
  const webhookCurrency = String(amountObj.currency_code || "USD").toUpperCase();

  // Find local payment record
  let query = supabase.from("payments").select("*");
  if (authId && customId) {
    query = query.or(`authorization_id.eq.${authId},payment_attempt_id.eq.${customId}`);
  } else if (authId) {
    query = query.eq("authorization_id", authId);
  } else if (customId) {
    query = query.eq("payment_attempt_id", customId);
  } else if (parentPayment) {
    query = query.eq("order_id", parentPayment);
  } else {
    return { success: true, outcome: "UNMATCHED", message: "Resource missing identifiable payment keys." };
  }

  const { data: payment, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) {
    return { success: false, outcome: "FAILED", error: fetchErr.message };
  }

  if (!payment) {
    await recordAuditLogInDb({
      action: "PAYPAL_WEBHOOK_PAYMENT_NOT_FOUND",
      entityType: "payment",
      entityId: authId || "unknown",
      newState: { eventType: "PAYMENT.AUTHORIZATION.CREATED", authId, customId },
    });
    return { success: true, outcome: "UNMATCHED", message: `No matching payment record found for auth: ${authId}` };
  }

  // Financial verification: amount & currency check
  if (Math.abs(payment.amount - webhookAmount) > 0.001 || payment.currency !== webhookCurrency) {
    await recordAuditLogInDb({
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "PAYPAL_WEBHOOK_AMOUNT_MISMATCH",
      entityType: "payment",
      entityId: payment.id,
      oldState: { expectedAmount: payment.amount, expectedCurrency: payment.currency },
      newState: {
        reason: "Authorization webhook amount/currency mismatch",
        webhookAmount,
        webhookCurrency,
      },
    });
    return {
      success: true,
      outcome: "MISMATCH",
      error: `Financial mismatch: expected ${payment.amount} ${payment.currency}, got ${webhookAmount} ${webhookCurrency}. Payment state unchanged.`,
    };
  }

  // Prevent regressing captured or settled payments
  if (payment.status === "CAPTURED" || payment.status === "SETTLED") {
    await recordAuditLogInDb({
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "PAYPAL_WEBHOOK_OUT_OF_ORDER_IGNORED",
      entityType: "payment",
      entityId: payment.id,
      oldState: { status: payment.status },
      newState: {
        reason: `Payment is already ${payment.status}; ignoring authorization created event.`,
        currentStatus: payment.status,
      },
    });
    return {
      success: true,
      outcome: "IGNORED_TERMINAL",
      message: `Payment already ${payment.status}; authorization event ignored.`,
    };
  }

  // If already AUTHORIZED, ensure authorization_id is saved
  if (payment.status === "AUTHORIZED") {
    if (!payment.authorization_id && authId) {
      await supabase.from("payments").update({ authorization_id: authId }).eq("id", payment.id);
    }
    return { success: true, outcome: "PROCESSED", message: "Payment already in AUTHORIZED state." };
  }

  // Step-by-step transition to satisfy trigger
  if (payment.status === "CREATED") {
    await supabase.from("payments").update({ status: "APPROVED" }).eq("id", payment.id);
  }

  // Transition to AUTHORIZED
  const nowIso = new Date().toISOString();
  const { error: authErr } = await supabase
    .from("payments")
    .update({
      status: "AUTHORIZED",
      authorization_id: authId || payment.authorization_id,
      authorized_at: nowIso,
    })
    .eq("id", payment.id);

  if (authErr) {
    return { success: false, outcome: "FAILED", error: authErr.message };
  }

  // Update milestone payment status
  await supabase
    .from("milestones")
    .update({ payment_status: "authorized" })
    .eq("id", payment.milestone_id);

  await recordAuditLogInDb({
    projectId: payment.project_id,
    milestoneId: payment.milestone_id,
    action: "PAYPAL_WEBHOOK_AUTHORIZATION_CREATED",
    entityType: "payment",
    entityId: payment.id,
    oldState: { status: payment.status },
    newState: { authId, amount: webhookAmount, currency: webhookCurrency, status: "AUTHORIZED" },
  });

  return { success: true, outcome: "PROCESSED", message: "Payment authorization reconciled to AUTHORIZED." };
}

/**
 * Handler: PAYMENT.AUTHORIZATION.VOIDED
 */
async function handleAuthorizationVoided(
  webhookEvent: Record<string, unknown>,
  resource: Record<string, unknown>
): Promise<WebhookProcessResult> {
  const supabase = createAdminClient();
  if (!supabase) return { success: false, outcome: "FAILED", error: "Database client unavailable." };

  const authId = String(resource.id || "");
  const customId = typeof resource.custom_id === "string" ? resource.custom_id : "";

  let query = supabase.from("payments").select("*");
  if (authId && customId) {
    query = query.or(`authorization_id.eq.${authId},payment_attempt_id.eq.${customId}`);
  } else if (authId) {
    query = query.eq("authorization_id", authId);
  } else if (customId) {
    query = query.eq("payment_attempt_id", customId);
  } else {
    return { success: true, outcome: "UNMATCHED", message: "Resource missing identifiable auth ID." };
  }

  const { data: payment, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) return { success: false, outcome: "FAILED", error: fetchErr.message };

  if (!payment) {
    return { success: true, outcome: "UNMATCHED", message: `No payment found for voided auth: ${authId}` };
  }

  // Never void captured or settled payment
  if (payment.status === "CAPTURED" || payment.status === "SETTLED") {
    await recordAuditLogInDb({
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "PAYPAL_WEBHOOK_VOID_BLOCKED_FOR_CAPTURED",
      entityType: "payment",
      entityId: payment.id,
      oldState: { status: payment.status },
      newState: { currentStatus: payment.status, authId },
    });
    return {
      success: true,
      outcome: "IGNORED_TERMINAL",
      message: `Cannot void payment that is already ${payment.status}.`,
    };
  }

  if (payment.status === "VOIDED") {
    return { success: true, outcome: "PROCESSED", message: "Payment already in VOIDED state." };
  }

  const nowIso = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("payments")
    .update({
      status: "VOIDED",
      voided_at: nowIso,
    })
    .eq("id", payment.id);

  if (updateErr) {
    return { success: false, outcome: "FAILED", error: updateErr.message };
  }

  await supabase
    .from("milestones")
    .update({ payment_status: "voided" })
    .eq("id", payment.milestone_id);

  await recordAuditLogInDb({
    projectId: payment.project_id,
    milestoneId: payment.milestone_id,
    action: "PAYPAL_WEBHOOK_AUTHORIZATION_VOIDED",
    entityType: "payment",
    entityId: payment.id,
    oldState: { status: payment.status },
    newState: { authId, status: "VOIDED" },
  });

  return { success: true, outcome: "PROCESSED", message: "Payment reconciled to VOIDED." };
}

/**
 * Handler: PAYMENT.CAPTURE.COMPLETED
 */
async function handleCaptureCompleted(
  webhookEvent: Record<string, unknown>,
  resource: Record<string, unknown>
): Promise<WebhookProcessResult> {
  const supabase = createAdminClient();
  if (!supabase) return { success: false, outcome: "FAILED", error: "Database client unavailable." };

  const captureId = String(resource.id || "");
  const customId = typeof resource.custom_id === "string" ? resource.custom_id : "";
  const parentAuthId = extractParentAuthorizationId(resource);
  const amountObj = (resource.amount as Record<string, unknown>) || {};
  const webhookAmount = parseFloat(String(amountObj.value || "0"));
  const webhookCurrency = String(amountObj.currency_code || "USD").toUpperCase();

  // Find payment by capture_id, parent authorization_id, or payment_attempt_id
  let query = supabase.from("payments").select("*");
  const orConditions: string[] = [];
  if (captureId) orConditions.push(`capture_id.eq.${captureId}`);
  if (parentAuthId) orConditions.push(`authorization_id.eq.${parentAuthId}`);
  if (customId) orConditions.push(`payment_attempt_id.eq.${customId}`);

  if (orConditions.length > 0) {
    query = query.or(orConditions.join(","));
  } else {
    return { success: true, outcome: "UNMATCHED", message: "Missing identifiable capture keys." };
  }

  const { data: payment, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) return { success: false, outcome: "FAILED", error: fetchErr.message };

  if (!payment) {
    await recordAuditLogInDb({
      action: "PAYPAL_WEBHOOK_PAYMENT_NOT_FOUND",
      entityType: "payment",
      entityId: captureId || "unknown",
      newState: { eventType: "PAYMENT.CAPTURE.COMPLETED", captureId, parentAuthId, customId },
    });
    return { success: true, outcome: "UNMATCHED", message: `No payment found for capture: ${captureId}` };
  }

  // Financial verification: amount & currency check
  if (Math.abs(payment.amount - webhookAmount) > 0.001 || payment.currency !== webhookCurrency) {
    await recordAuditLogInDb({
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "PAYPAL_WEBHOOK_AMOUNT_MISMATCH",
      entityType: "payment",
      entityId: payment.id,
      oldState: { expectedAmount: payment.amount, expectedCurrency: payment.currency },
      newState: {
        reason: "Capture webhook amount/currency mismatch",
        webhookAmount,
        webhookCurrency,
      },
    });
    return {
      success: true,
      outcome: "MISMATCH",
      error: `Financial mismatch: expected ${payment.amount} ${payment.currency}, got ${webhookAmount} ${webhookCurrency}. State unchanged.`,
    };
  }

  // Idempotency: Already captured
  if (payment.status === "CAPTURED") {
    if (!payment.capture_id && captureId) {
      await supabase.from("payments").update({ capture_id: captureId }).eq("id", payment.id);
    }
    return { success: true, outcome: "PROCESSED", message: "Payment already in CAPTURED state." };
  }

  // CRITICAL RULE: Webhook must NEVER mark payment as SETTLED!
  // And settled payment must not be altered
  if (payment.status === "SETTLED") {
    return { success: true, outcome: "PROCESSED", message: "Payment already SETTLED; unchanged." };
  }

  const captureTime = String(resource.create_time || new Date().toISOString());

  // Step transitions if necessary to satisfy database state machine:
  if (payment.status === "CREATED") {
    await supabase.from("payments").update({ status: "APPROVED" }).eq("id", payment.id);
    await supabase.from("payments").update({ status: "AUTHORIZED", authorization_id: parentAuthId || payment.authorization_id }).eq("id", payment.id);
    await supabase.from("payments").update({ status: "CAPTURE_PENDING" }).eq("id", payment.id);
  } else if (payment.status === "APPROVED") {
    await supabase.from("payments").update({ status: "AUTHORIZED", authorization_id: parentAuthId || payment.authorization_id }).eq("id", payment.id);
    await supabase.from("payments").update({ status: "CAPTURE_PENDING" }).eq("id", payment.id);
  } else if (payment.status === "AUTHORIZED") {
    // Transition to CAPTURE_PENDING first
    await supabase.from("payments").update({ status: "CAPTURE_PENDING" }).eq("id", payment.id);
  }

  // Transition to CAPTURED
  const { error: capErr } = await supabase
    .from("payments")
    .update({
      status: "CAPTURED",
      capture_id: captureId || payment.capture_id,
      captured_at: captureTime,
    })
    .eq("id", payment.id);

  if (capErr) {
    return { success: false, outcome: "FAILED", error: capErr.message };
  }

  // Update milestone payment status
  await supabase
    .from("milestones")
    .update({ payment_status: "captured" })
    .eq("id", payment.milestone_id);

  await recordAuditLogInDb({
    projectId: payment.project_id,
    milestoneId: payment.milestone_id,
    action: "PAYPAL_WEBHOOK_CAPTURE_COMPLETED",
    entityType: "payment",
    entityId: payment.id,
    oldState: { status: payment.status },
    newState: { captureId, amount: webhookAmount, currency: webhookCurrency, status: "CAPTURED" },
  });

  return { success: true, outcome: "PROCESSED", message: "Payment reconciled to CAPTURED." };
}

/**
 * Handler: PAYMENT.CAPTURE.DENIED
 */
async function handleCaptureDenied(
  webhookEvent: Record<string, unknown>,
  resource: Record<string, unknown>
): Promise<WebhookProcessResult> {
  const supabase = createAdminClient();
  if (!supabase) return { success: false, outcome: "FAILED", error: "Database client unavailable." };

  const captureId = String(resource.id || "");
  const customId = typeof resource.custom_id === "string" ? resource.custom_id : "";
  const parentAuthId = extractParentAuthorizationId(resource);

  let query = supabase.from("payments").select("*");
  const orConditions: string[] = [];
  if (captureId) orConditions.push(`capture_id.eq.${captureId}`);
  if (parentAuthId) orConditions.push(`authorization_id.eq.${parentAuthId}`);
  if (customId) orConditions.push(`payment_attempt_id.eq.${customId}`);

  if (orConditions.length > 0) {
    query = query.or(orConditions.join(","));
  } else {
    return { success: true, outcome: "UNMATCHED", message: "Missing identifiable capture keys." };
  }

  const { data: payment, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) return { success: false, outcome: "FAILED", error: fetchErr.message };

  if (!payment) {
    return { success: true, outcome: "UNMATCHED", message: `No payment found for denied capture: ${captureId}` };
  }

  // Never revert captured or settled payment
  if (payment.status === "CAPTURED" || payment.status === "SETTLED") {
    await recordAuditLogInDb({
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "PAYPAL_WEBHOOK_DENIAL_BLOCKED_FOR_CAPTURED",
      entityType: "payment",
      entityId: payment.id,
      oldState: { status: payment.status },
      newState: { currentStatus: payment.status, captureId },
    });
    return {
      success: true,
      outcome: "IGNORED_TERMINAL",
      message: `Cannot mark payment as failed when already ${payment.status}.`,
    };
  }

  if (payment.status === "FAILED") {
    return { success: true, outcome: "PROCESSED", message: "Payment already FAILED." };
  }

  const statusDetails = (resource.status_details as Record<string, unknown>) || {};
  const failureReason = String(statusDetails.reason || "PAYPAL_CAPTURE_DENIED");
  const nowIso = new Date().toISOString();

  const { error: failErr } = await supabase
    .from("payments")
    .update({
      status: "FAILED",
      error_details: { reason: failureReason, denied_at: nowIso },
    })
    .eq("id", payment.id);

  if (failErr) {
    return { success: false, outcome: "FAILED", error: failErr.message };
  }

  await supabase
    .from("milestones")
    .update({ payment_status: "failed" })
    .eq("id", payment.milestone_id);

  await recordAuditLogInDb({
    projectId: payment.project_id,
    milestoneId: payment.milestone_id,
    action: "PAYPAL_WEBHOOK_CAPTURE_DENIED",
    entityType: "payment",
    entityId: payment.id,
    oldState: { status: payment.status },
    newState: { captureId, reason: failureReason, status: "FAILED" },
  });

  return { success: true, outcome: "PROCESSED", message: "Payment reconciled to FAILED due to capture denial." };
}

/**
 * Handler: PAYMENT.CAPTURE.PENDING
 */
async function handleCapturePending(
  webhookEvent: Record<string, unknown>,
  resource: Record<string, unknown>
): Promise<WebhookProcessResult> {
  const supabase = createAdminClient();
  if (!supabase) return { success: false, outcome: "FAILED", error: "Database client unavailable." };

  const captureId = String(resource.id || "");
  const customId = typeof resource.custom_id === "string" ? resource.custom_id : "";
  const parentAuthId = extractParentAuthorizationId(resource);

  let query = supabase.from("payments").select("*");
  const orConditions: string[] = [];
  if (captureId) orConditions.push(`capture_id.eq.${captureId}`);
  if (parentAuthId) orConditions.push(`authorization_id.eq.${parentAuthId}`);
  if (customId) orConditions.push(`payment_attempt_id.eq.${customId}`);

  if (orConditions.length > 0) {
    query = query.or(orConditions.join(","));
  } else {
    return { success: true, outcome: "UNMATCHED", message: "Missing identifiable capture keys." };
  }

  const { data: payment, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) return { success: false, outcome: "FAILED", error: fetchErr.message };

  if (!payment) {
    return { success: true, outcome: "UNMATCHED", message: `No payment found for pending capture: ${captureId}` };
  }

  // Never revert captured or settled payment
  if (payment.status === "CAPTURED" || payment.status === "SETTLED") {
    return { success: true, outcome: "IGNORED_TERMINAL", message: `Payment already ${payment.status}; pending ignored.` };
  }

  if (payment.status === "AUTHORIZED") {
    await supabase
      .from("payments")
      .update({
        status: "CAPTURE_PENDING",
        capture_id: captureId || payment.capture_id,
      })
      .eq("id", payment.id);

    await supabase
      .from("milestones")
      .update({ payment_status: "capture_pending" })
      .eq("id", payment.milestone_id);
  } else if (payment.status === "CAPTURE_PENDING") {
    if (!payment.capture_id && captureId) {
      await supabase.from("payments").update({ capture_id: captureId }).eq("id", payment.id);
    }
  }

  await recordAuditLogInDb({
    projectId: payment.project_id,
    milestoneId: payment.milestone_id,
    action: "PAYPAL_WEBHOOK_CAPTURE_PENDING",
    entityType: "payment",
    entityId: payment.id,
    newState: { captureId },
  });

  return { success: true, outcome: "PROCESSED", message: "Payment status retained in CAPTURE_PENDING." };
}

/**
 * Handler: Unsupported event types (e.g. CHECKOUT.ORDER.APPROVED, CUSTOMER.DISPUTE.CREATED)
 */
async function handleUnsupportedEvent(
  webhookEvent: Record<string, unknown>
): Promise<WebhookProcessResult> {
  const eventType = String(webhookEvent.event_type || "UNKNOWN");
  const eventId = String(webhookEvent.id || "unknown");

  await recordAuditLogInDb({
    action: "PAYPAL_WEBHOOK_IGNORED_UNSUPPORTED",
    entityType: "webhook_event",
    entityId: eventId,
    newState: { eventType, summary: webhookEvent.summary || null },
  });

  return {
    success: true,
    outcome: "IGNORED",
    message: `Event type ${eventType} acknowledged and gracefully ignored.`,
  };
}

/**
 * Administrative / Cron Recovery Routine for Failed Webhook Events
 */
export async function retryFailedWebhookEvent(
  recordId: string
): Promise<WebhookProcessResult> {
  const supabase = createAdminClient();
  if (!supabase) return { success: false, outcome: "FAILED", error: "Database client unavailable." };

  const { data: record, error: fetchErr } = await supabase
    .from("paypal_webhook_events")
    .select("*")
    .eq("id", recordId)
    .maybeSingle();

  if (fetchErr || !record) {
    return { success: false, outcome: "FAILED", error: fetchErr?.message || "Record not found." };
  }

  const payload = (record.payload as Record<string, unknown>) || {};
  const rawEvent = (payload.raw_event as Record<string, unknown>) || null;

  if (!rawEvent) {
    return { success: false, outcome: "FAILED", error: "No raw event payload stored in webhook record." };
  }

  try {
    const result = await processPayPalWebhookEvent(rawEvent);
    await updateWebhookEventStatusInDb(
      recordId,
      result.outcome === "IGNORED" ? "IGNORED" : (result.success ? "PROCESSED" : "FAILED"),
      result.error
    );
    return result;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateWebhookEventStatusInDb(recordId, "FAILED", errorMsg);
    return { success: false, outcome: "FAILED", error: errorMsg };
  }
}

