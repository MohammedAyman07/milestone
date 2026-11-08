import { createAdminClient } from "./admin";
import { createServerSupabaseClient } from "./server";
import { recordAuditLogInDb } from "./db";
import { getPayPalAuthorization, capturePayPalAuthorization } from "../paypal/payments";

export interface CreatePaymentAttemptInput {
  milestoneId: string;
  projectId: string;
  clientId: string;
  freelancerId: string;
  amount: number;
  currency?: string;
}

export interface PaymentAttemptRecord {
  id: string;
  paymentAttemptId: string;
  attemptNumber: number;
  milestoneId: string;
  projectId: string;
  amount: number;
  currency: string;
  status: string;
  idempotencyOrderCreate: string;
  idempotencyOrderAuth: string;
  idempotencyAuthCapture: string;
  idempotencyRefund: string;
}

// 1. Create a new distinct payment attempt record with stable idempotency keys
export async function createPaymentAttemptRecord(
  input: CreatePaymentAttemptInput
): Promise<{ success: boolean; payment?: PaymentAttemptRecord; error?: string; isConflict?: boolean }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    // Check if an active payment attempt already exists for this milestone
    const { data: activeExisting } = await supabase
      .from("payments")
      .select("id, status, payment_attempt_id, order_id, authorization_id")
      .eq("milestone_id", input.milestoneId)
      .in("status", ["CREATED", "APPROVED", "AUTHORIZED", "CAPTURE_PENDING"])
      .maybeSingle();

    if (activeExisting) {
      return {
        success: false,
        error: `Active payment attempt already exists for milestone (Status: ${activeExisting.status}, Order: ${activeExisting.order_id || "pending"}). Complete, void, or cancel existing attempt first.`,
      };
    }

    // Determine attempt number for this milestone
    const { count: previousAttemptsCount } = await supabase
      .from("payments")
      .select("*", { count: "exact", head: true })
      .eq("milestone_id", input.milestoneId);

    const attemptNumber = (previousAttemptsCount || 0) + 1;
    const rawUuid = crypto.randomUUID().replace(/-/g, "");
    const paymentAttemptId = `att_${rawUuid}`;

    // Stable idempotency keys tied uniquely to this payment attempt
    const idempotencyOrderCreate = `ord_create_${paymentAttemptId}`;
    const idempotencyOrderAuth = `ord_auth_${paymentAttemptId}`;
    const idempotencyAuthCapture = `auth_cap_${paymentAttemptId}`;
    const idempotencyRefund = `refund_${paymentAttemptId}`;

    const { data: newPayment, error: insertErr } = await supabase
      .from("payments")
      .insert({
        milestone_id: input.milestoneId,
        project_id: input.projectId,
        payer_id: input.clientId,
        payee_id: input.freelancerId,
        amount: input.amount,
        currency: "USD", // MVP restricted to USD
        payment_type: "order",
        status: "CREATED",
        payment_attempt_id: paymentAttemptId,
        attempt_number: attemptNumber,
        idempotency_order_create: idempotencyOrderCreate,
        idempotency_order_auth: idempotencyOrderAuth,
        idempotency_auth_capture: idempotencyAuthCapture,
        idempotency_refund: idempotencyRefund,
      })
      .select()
      .single();

    if (insertErr || !newPayment) {
      const isUniqueConflict =
        insertErr?.message?.includes("uq_active_milestone_payment_attempt") ||
        (insertErr as any)?.code === "23505";
      return {
        success: false,
        isConflict: isUniqueConflict,
        error: isUniqueConflict
          ? "Concurrent transaction conflict: an active payment attempt was already created for this milestone by another process."
          : (insertErr?.message || "Failed to persist payment record."),
      };
    }

    // Update milestone payment status to 'created'
    await supabase
      .from("milestones")
      .update({ payment_status: "created" })
      .eq("id", input.milestoneId);

    // Record audit log
    await recordAuditLogInDb({
      actorId: input.clientId,
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      action: "PAYMENT_ATTEMPT_CREATED",
      entityType: "payment",
      entityId: newPayment.id,
      newState: {
        paymentAttemptId,
        attemptNumber,
        amount: input.amount,
        currency: "USD",
        status: "CREATED",
      },
    });

    return {
      success: true,
      payment: {
        id: newPayment.id,
        paymentAttemptId,
        attemptNumber,
        milestoneId: input.milestoneId,
        projectId: input.projectId,
        amount: input.amount,
        currency: "USD",
        status: "CREATED",
        idempotencyOrderCreate,
        idempotencyOrderAuth,
        idempotencyAuthCapture,
        idempotencyRefund,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 2. Update payment attempt with PayPal order ID and raw response
export async function updatePaymentWithOrderId(
  paymentAttemptId: string,
  orderId: string,
  rawPayload?: unknown
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const { error } = await supabase
    .from("payments")
    .update({
      order_id: orderId,
      raw_paypal_response: rawPayload || {},
      updated_at: new Date().toISOString(),
    })
    .eq("payment_attempt_id", paymentAttemptId);

  return { success: !error, error: error?.message };
}

// 2b. Mark payment attempt as FAILED upon definitive rejection ONLY
export async function markPaymentAttemptFailed(
  paymentAttemptId: string,
  errorDetails: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const { error } = await supabase
    .from("payments")
    .update({
      status: "FAILED",
      manual_reconciliation_required: false,
      error_details: errorDetails,
      updated_at: new Date().toISOString(),
    })
    .eq("payment_attempt_id", paymentAttemptId)
    .eq("status", "CREATED");

  return { success: !error, error: error?.message };
}

// 2c. Mark payment attempt as UNCERTAIN (preserves CREATED status and active lock)
export async function markPaymentAttemptUncertain(
  paymentAttemptId: string,
  errorDetails: Record<string, unknown>,
  notes: string
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const { error } = await supabase
    .from("payments")
    .update({
      manual_reconciliation_required: true,
      error_details: errorDetails,
      reconciliation_notes: notes,
      updated_at: new Date().toISOString(),
    })
    .eq("payment_attempt_id", paymentAttemptId)
    .eq("status", "CREATED");

  return { success: !error, error: error?.message };
}

// 2d. Reconcile payment attempt upon resolving uncertain order with PayPal
export async function reconcilePaymentAttemptOrder(
  paymentAttemptId: string,
  orderId: string,
  rawPayload: unknown,
  reconciliationNotes = "Reconciled with PayPal Orders v2"
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const { error } = await supabase
    .from("payments")
    .update({
      order_id: orderId,
      raw_paypal_response: rawPayload || {},
      manual_reconciliation_required: false,
      reconciliation_notes: reconciliationNotes,
      updated_at: new Date().toISOString(),
    })
    .eq("payment_attempt_id", paymentAttemptId);

  return { success: !error, error: error?.message };
}

export interface MilestoneEligibilityResult {
  eligible: boolean;
  httpStatus: number;
  error?: string;
  milestone?: {
    id: string;
    projectId: string;
    title: string;
    amount: number;
    currency: string;
    status: string;
    paymentStatus: string;
  };
  project?: {
    id: string;
    clientId: string;
    freelancerId: string;
    title: string;
    status: string;
  };
  existingOrder?: {
    orderId: string;
    paymentAttemptId: string;
    approvalUrl?: string;
  };
  uncertainAttempt?: {
    id: string;
    paymentAttemptId: string;
    idempotencyOrderCreate: string;
    manualReconciliationRequired: boolean;
    errorDetails: unknown;
    createdAt?: string;
  };
}

// 2e. Server-side validation of milestone payment eligibility & project ownership
export async function validateMilestonePaymentEligibility(
  milestoneId: string,
  userId: string,
  providedProjectId?: string
): Promise<MilestoneEligibilityResult> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { eligible: false, httpStatus: 500, error: "Database client unavailable." };
  }

  // 1. Fetch milestone
  const { data: milestone, error: mErr } = await supabase
    .from("milestones")
    .select("id, project_id, title, amount, currency, status, payment_status")
    .eq("id", milestoneId)
    .maybeSingle();

  if (mErr || !milestone) {
    return { eligible: false, httpStatus: 404, error: "Milestone not found." };
  }

  // 2. Validate project linkage if providedProjectId is supplied
  if (providedProjectId && milestone.project_id !== providedProjectId) {
    return {
      eligible: false,
      httpStatus: 400,
      error: "Milestone does not belong to the specified project.",
    };
  }

  // 3. Fetch project
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, client_id, freelancer_id, title, status")
    .eq("id", milestone.project_id)
    .maybeSingle();

  if (pErr || !project) {
    return { eligible: false, httpStatus: 404, error: "Project not found." };
  }

  // 4. Validate user is the project client
  if (project.client_id !== userId) {
    return {
      eligible: false,
      httpStatus: 403,
      error: "Forbidden: Only the project client can authorize milestone payments.",
    };
  }

  // 5. Validate currency is USD
  if (milestone.currency !== "USD") {
    return {
      eligible: false,
      httpStatus: 400,
      error: `Unsupported currency '${milestone.currency}'. MILESTONE AI requires USD.`,
    };
  }

  // 6. Validate amount is positive and numeric
  const amount = Number(milestone.amount);
  if (isNaN(amount) || amount <= 0) {
    return {
      eligible: false,
      httpStatus: 400,
      error: "Milestone amount must be a positive number.",
    };
  }

  // 7. Validate milestone payment eligibility
  const ineligiblePaymentStatuses = ["authorized", "capture_pending", "captured", "settled"];
  if (ineligiblePaymentStatuses.includes((milestone.payment_status || "").toLowerCase())) {
    return {
      eligible: false,
      httpStatus: 400,
      error: `Milestone is not eligible for payment (current status: ${milestone.payment_status}).`,
    };
  }

  // 8. Check for active payment attempts
  const { data: activePayment } = await supabase
    .from("payments")
    .select("id, status, payment_attempt_id, idempotency_order_create, order_id, raw_paypal_response, manual_reconciliation_required, error_details, created_at")
    .eq("milestone_id", milestoneId)
    .in("status", ["CREATED", "APPROVED", "AUTHORIZED", "CAPTURE_PENDING"])
    .maybeSingle();

  if (activePayment) {
    const milestoneDetails = {
      id: milestone.id,
      projectId: milestone.project_id,
      title: milestone.title,
      amount,
      currency: milestone.currency,
      status: milestone.status,
      paymentStatus: milestone.payment_status,
    };

    const projectDetails = {
      id: project.id,
      clientId: project.client_id,
      freelancerId: project.freelancer_id,
      title: project.title,
      status: project.status,
    };

    if (activePayment.status === "AUTHORIZED" || activePayment.status === "CAPTURE_PENDING") {
      return {
        eligible: false,
        httpStatus: 409,
        error: `Milestone is already authorized or capture is pending (Status: ${activePayment.status}).`,
        milestone: milestoneDetails,
        project: projectDetails,
      };
    }

    // If active attempt is CREATED and already has an order_id
    if (activePayment.status === "CREATED" && activePayment.order_id) {
      const raw = activePayment.raw_paypal_response as Record<string, unknown> | null;
      const links = (raw?.links as Array<{ rel: string; href: string }>) || [];
      const approvalUrl = links.find((l) => l.rel === "approve")?.href;

      return {
        eligible: false,
        httpStatus: 409,
        error: "An active unapproved payment order already exists for this milestone.",
        milestone: milestoneDetails,
        project: projectDetails,
        existingOrder: {
          orderId: activePayment.order_id,
          paymentAttemptId: activePayment.payment_attempt_id,
          approvalUrl,
        },
      };
    }

    // If active attempt is CREATED and has NO order_id (uncertain outcome on prior attempt)
    if (activePayment.status === "CREATED" && !activePayment.order_id) {
      return {
        eligible: false,
        httpStatus: 202,
        error: "A payment order creation attempt for this milestone has an uncertain outcome and is currently in reconciliation. A new attempt cannot be created until this is resolved.",
        milestone: milestoneDetails,
        project: projectDetails,
        uncertainAttempt: {
          id: activePayment.id,
          paymentAttemptId: activePayment.payment_attempt_id,
          idempotencyOrderCreate: activePayment.idempotency_order_create,
          manualReconciliationRequired: activePayment.manual_reconciliation_required,
          errorDetails: activePayment.error_details,
          createdAt: activePayment.created_at,
        },
      };
    }

    return {
      eligible: false,
      httpStatus: 409,
      error: `An active payment attempt is already in progress for this milestone (Status: ${activePayment.status}).`,
    };
  }

  return {
    eligible: true,
    httpStatus: 200,
    milestone: {
      id: milestone.id,
      projectId: milestone.project_id,
      title: milestone.title,
      amount,
      currency: milestone.currency,
      status: milestone.status,
      paymentStatus: milestone.payment_status,
    },
    project: {
      id: project.id,
      clientId: project.client_id,
      freelancerId: project.freelancer_id,
      title: project.title,
      status: project.status,
    },
  };
}

// 2f. Retrieve payment record by PayPal order ID
export async function getPaymentByOrderId(orderId: string): Promise<{
  success: boolean;
  payment?: any;
  error?: string;
}> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const { data: payment, error } = await supabase
    .from("payments")
    .select("*, milestone:milestones(id, title, status, payment_status, amount, currency), project:projects(id, title, client_id, freelancer_id, status)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error || !payment) {
    return { success: false, error: error?.message || "Payment attempt not found for order." };
  }

  return { success: true, payment };
}

// 2f-2. Retrieve payment record by payment_attempt_id
export async function getPaymentByAttemptId(paymentAttemptId: string): Promise<{
  success: boolean;
  payment?: any;
  error?: string;
}> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const { data: payment, error } = await supabase
    .from("payments")
    .select("*, milestone:milestones(id, title, status, payment_status, amount, currency), project:projects(id, title, client_id, freelancer_id, status)")
    .eq("payment_attempt_id", paymentAttemptId)
    .maybeSingle();

  if (error || !payment) {
    return { success: false, error: error?.message || "Payment attempt not found." };
  }

  return { success: true, payment };
}

// 2g. Record verified buyer approval in database (transitions CREATED -> APPROVED)
export interface RecordBuyerApprovalParams {
  orderId: string;
  payerId?: string;
  payerEmail?: string;
  rawPayload: unknown;
}

export async function recordBuyerApprovalInDb(params: RecordBuyerApprovalParams): Promise<{
  success: boolean;
  payment?: any;
  error?: string;
  isAlreadyApproved?: boolean;
}> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    // 1. Fetch current payment record
    const { data: payment, error: fetchErr } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", params.orderId)
      .maybeSingle();

    if (fetchErr || !payment) {
      return { success: false, error: "Payment attempt not found for order." };
    }

    // 2. If already APPROVED, return idempotent success
    if (payment.status === "APPROVED") {
      return { success: true, payment, isAlreadyApproved: true };
    }

    // 3. Must be in CREATED status to transition to APPROVED
    if (payment.status !== "CREATED") {
      return {
        success: false,
        error: `Invalid Transition: Payment is currently in ${payment.status} status; only CREATED payments can be approved.`,
      };
    }

    const now = new Date().toISOString();

    // 4. Update payment record to APPROVED
    const { data: updatedPayment, error: updateErr } = await supabase
      .from("payments")
      .update({
        status: "APPROVED",
        paypal_payer_id: params.payerId || payment.paypal_payer_id || null,
        paypal_payer_email: params.payerEmail || payment.paypal_payer_email || null,
        raw_paypal_response: params.rawPayload || payment.raw_paypal_response,
        manual_reconciliation_required: false,
        updated_at: now,
      })
      .eq("id", payment.id)
      .eq("status", "CREATED") // Concurrency safety guard
      .select()
      .single();

    if (updateErr || !updatedPayment) {
      return {
        success: false,
        error: updateErr?.message || "Failed to transition payment status to APPROVED.",
      };
    }

    // 5. Update milestone payment_status to 'approved'
    await supabase
      .from("milestones")
      .update({
        payment_status: "approved",
      })
      .eq("id", payment.milestone_id);

    // 6. Record Audit Log
    await recordAuditLogInDb({
      actorId: payment.payer_id,
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "BUYER_APPROVAL_CONFIRMED",
      entityType: "payment",
      entityId: payment.id,
      newState: {
        paymentAttemptId: payment.payment_attempt_id,
        orderId: params.orderId,
        payerId: params.payerId,
        payerEmail: params.payerEmail,
        status: "APPROVED",
        amount: payment.amount,
        currency: payment.currency,
      },
    });

    return { success: true, payment: updatedPayment };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 2h. Record buyer cancellation in database (Phase 9.1.1 hardened cancellation)
// Safe cancellation policy: An order that remains usable at PayPal cannot silently unlock a milestone.
// If definitive closure is confirmed by PayPal (VOIDED/EXPIRED/404), the attempt transitions to VOIDED.
// If the order is still usable (CREATED) at PayPal, the attempt is preserved in CREATED status.
export async function recordBuyerCancellationInDb(params: {
  orderId: string;
  userId: string;
  reason?: string;
  confirmedDefinitiveClose?: boolean;
  orderStatusAtPayPal?: string;
}): Promise<{
  success: boolean;
  payment?: any;
  error?: string;
  isAlreadyVoided?: boolean;
  outcome?: "VOIDED" | "ALREADY_VOIDED" | "CANCELLATION_RECORDED_ORDER_PRESERVED";
}> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const { data: payment, error: fetchErr } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", params.orderId)
      .maybeSingle();

    if (fetchErr || !payment) {
      return { success: false, error: "Payment attempt not found for order." };
    }

    if (payment.payer_id !== params.userId) {
      return { success: false, error: "Forbidden: You do not own this payment attempt." };
    }

    // Idempotent repeated cancellation check
    if (payment.status === "VOIDED" || payment.status === "EXPIRED") {
      return { success: true, payment, isAlreadyVoided: true, outcome: "ALREADY_VOIDED" };
    }

    if (payment.status !== "CREATED") {
      return {
        success: false,
        error: `Cannot cancel payment: Status is ${payment.status}; only CREATED orders can be cancelled.`,
      };
    }

    const now = new Date().toISOString();

    // Policy Rule: If safe cancellation cannot be definitively confirmed by PayPal (e.g. order is still CREATED at PayPal),
    // PRESERVE the attempt in CREATED status to prevent duplicate orders from being opened!
    if (!params.confirmedDefinitiveClose) {
      const { data: preservedPayment, error: presErr } = await supabase
        .from("payments")
        .update({
          manual_reconciliation_required: true,
          reconciliation_notes: `Buyer cancelled in browser, but PayPal order remains active (${params.orderStatusAtPayPal || "UNKNOWN"}). Attempt preserved in CREATED to prevent duplicate orders.`,
          error_details: {
            buyer_cancelled: true,
            reason: params.reason || "Buyer cancelled PayPal checkout in browser",
            order_status_paypal: params.orderStatusAtPayPal || "CREATED",
            cancelled_at: now,
          },
          updated_at: now,
        })
        .eq("id", payment.id)
        .eq("status", "CREATED")
        .select()
        .single();

      if (presErr || !preservedPayment) {
        return { success: false, error: presErr?.message || "Failed to update cancellation state." };
      }

      await recordAuditLogInDb({
        actorId: params.userId,
        projectId: payment.project_id,
        milestoneId: payment.milestone_id,
        action: "BUYER_CANCELLATION_RECORDED_ORDER_PRESERVED",
        entityType: "payment",
        entityId: payment.id,
        newState: {
          paymentAttemptId: payment.payment_attempt_id,
          orderId: params.orderId,
          status: "CREATED",
          orderStatusAtPayPal: params.orderStatusAtPayPal || "CREATED",
          reason: params.reason || "Buyer cancelled checkout; order preserved",
        },
      });

      return {
        success: true,
        payment: preservedPayment,
        outcome: "CANCELLATION_RECORDED_ORDER_PRESERVED",
      };
    }

    // PayPal has confirmed the order is definitively closed (VOIDED / EXPIRED / 404):
    // Safe to transition to VOIDED and unlock milestone
    const { data: updatedPayment, error: updateErr } = await supabase
      .from("payments")
      .update({
        status: "VOIDED",
        manual_reconciliation_required: false,
        reconciliation_notes: params.reason || "PayPal order definitively closed/voided",
        updated_at: now,
      })
      .eq("id", payment.id)
      .eq("status", "CREATED")
      .select()
      .single();

    if (updateErr || !updatedPayment) {
      return { success: false, error: updateErr?.message || "Failed to void payment attempt." };
    }

    // Reset milestone payment_status to 'unauthorized'
    await supabase
      .from("milestones")
      .update({ payment_status: "unauthorized" })
      .eq("id", payment.milestone_id);

    // Record audit log
    await recordAuditLogInDb({
      actorId: params.userId,
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "BUYER_APPROVAL_CANCELLED",
      entityType: "payment",
      entityId: payment.id,
      newState: {
        paymentAttemptId: payment.payment_attempt_id,
        orderId: params.orderId,
        status: "VOIDED",
        reason: params.reason || "PayPal order confirmed closed",
      },
    });

    return { success: true, payment: updatedPayment, outcome: "VOIDED" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 3. Update payment to AUTHORIZED after buyer approval
export async function updatePaymentToAuthorized(params: {
  orderId: string;
  authorizationId: string;
  payerId?: string;
  payerEmail?: string;
  rawPayload?: unknown;
}): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date();
    const authorizedAt = now.toISOString();
    const honorPeriodExpiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const authorizationExpiresAt = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString();

    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        status: "AUTHORIZED",
        authorization_id: params.authorizationId,
        authorized_at: authorizedAt,
        honor_period_expires_at: honorPeriodExpiresAt,
        authorization_expires_at: authorizationExpiresAt,
        paypal_payer_id: params.payerId || null,
        paypal_payer_email: params.payerEmail || null,
        raw_paypal_response: params.rawPayload || {},
        manual_reconciliation_required: false,
        reconciliation_notes: "Payment authorized successfully",
        updated_at: authorizedAt,
      })
      .eq("order_id", params.orderId)
      .select("id, milestone_id, project_id, payer_id, amount")
      .single();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to update payment to authorized." };
    }

    // Update milestone
    await supabase
      .from("milestones")
      .update({
        payment_status: "authorized",
        authorization_id: params.authorizationId,
        authorized_date: authorizedAt,
      })
      .eq("id", updatedPayment.milestone_id);

    // Record audit log
    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_AUTHORIZED",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        authorizationId: params.authorizationId,
        status: "AUTHORIZED",
        authorizedAt,
        honorPeriodExpiresAt,
        authorizationExpiresAt,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 3a. Record Authorization Dispatch Initiated (Phase 9.2 Pre-flight persistence)
export async function recordAuthorizationInitiatedInDb(
  paymentAttemptId: string
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date().toISOString();
    const { data: payment, error } = await supabase
      .from("payments")
      .update({
        reconciliation_notes: `Authorization dispatch initiated at ${now}`,
        updated_at: now,
      })
      .eq("payment_attempt_id", paymentAttemptId)
      .in("status", ["APPROVED", "AUTHORIZED"])
      .select("id, payer_id, project_id, milestone_id, payment_attempt_id, order_id")
      .maybeSingle();

    if (error || !payment) {
      return { success: false, error: error?.message || "Payment attempt not found or not in APPROVED state." };
    }

    await recordAuditLogInDb({
      actorId: payment.payer_id,
      projectId: payment.project_id,
      milestoneId: payment.milestone_id,
      action: "PAYMENT_AUTHORIZATION_DISPATCH_INITIATED",
      entityType: "payment",
      entityId: payment.id,
      newState: {
        paymentAttemptId: payment.payment_attempt_id,
        orderId: payment.order_id,
        status: "APPROVED",
        initiatedAt: now,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 3b. Record Confirmed Authorization Success in DB (Phase 9.2 Transitions APPROVED -> AUTHORIZED)
export interface RecordAuthorizationSuccessParams {
  paymentAttemptId: string;
  authorizationId: string;
  payerId?: string;
  payerEmail?: string;
  expirationTime?: string;
  rawPayload?: unknown;
}

export async function recordAuthorizationSuccessInDb(
  params: RecordAuthorizationSuccessParams
): Promise<{ success: boolean; payment?: any; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const { data: currentPayment, error: fetchErr } = await supabase
      .from("payments")
      .select("*")
      .eq("payment_attempt_id", params.paymentAttemptId)
      .maybeSingle();

    if (fetchErr || !currentPayment) {
      return { success: false, error: "Payment attempt not found." };
    }

    // Idempotent success if already AUTHORIZED with the same authorization_id
    if (currentPayment.status === "AUTHORIZED" && currentPayment.authorization_id === params.authorizationId) {
      return { success: true, payment: currentPayment };
    }

    const now = new Date();
    const authorizedAt = now.toISOString();
    const honorPeriodExpiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const authorizationExpiresAt =
      params.expirationTime || new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString();

    const { data: updatedPayment, error: updateErr } = await supabase
      .from("payments")
      .update({
        status: "AUTHORIZED",
        authorization_id: params.authorizationId,
        authorized_at: authorizedAt,
        honor_period_expires_at: honorPeriodExpiresAt,
        authorization_expires_at: authorizationExpiresAt,
        paypal_payer_id: params.payerId || currentPayment.paypal_payer_id || null,
        paypal_payer_email: params.payerEmail || currentPayment.paypal_payer_email || null,
        raw_paypal_response: params.rawPayload || currentPayment.raw_paypal_response,
        manual_reconciliation_required: false,
        reconciliation_notes: "Payment authorized successfully via PayPal authorization hold",
        updated_at: authorizedAt,
      })
      .eq("id", currentPayment.id)
      .in("status", ["APPROVED", "AUTHORIZED"])
      .select()
      .single();

    if (updateErr || !updatedPayment) {
      return {
        success: false,
        error: updateErr?.message || "Failed to update payment attempt to AUTHORIZED.",
      };
    }

    // Update milestone payment status
    await supabase
      .from("milestones")
      .update({
        payment_status: "authorized",
        authorization_id: params.authorizationId,
        authorized_date: authorizedAt,
      })
      .eq("id", updatedPayment.milestone_id);

    // Record audit log
    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_AUTHORIZED",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        paymentAttemptId: updatedPayment.payment_attempt_id,
        orderId: updatedPayment.order_id,
        authorizationId: params.authorizationId,
        status: "AUTHORIZED",
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        authorizedAt,
        honorPeriodExpiresAt,
        authorizationExpiresAt,
      },
    });

    return { success: true, payment: updatedPayment };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 3c. Record Uncertain Authorization State (Preserves APPROVED, Flags manual_reconciliation_required)
export async function recordAuthorizationUncertainInDb(params: {
  paymentAttemptId: string;
  errorDetails: Record<string, unknown>;
  notes: string;
}): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date().toISOString();
    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        manual_reconciliation_required: true,
        reconciliation_notes: params.notes,
        error_details: params.errorDetails,
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .select("id, payer_id, project_id, milestone_id, payment_attempt_id, order_id")
      .single();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to record uncertain authorization state." };
    }

    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_AUTHORIZATION_UNCERTAIN",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        paymentAttemptId: updatedPayment.payment_attempt_id,
        orderId: updatedPayment.order_id,
        status: "APPROVED",
        manual_reconciliation_required: true,
        notes: params.notes,
        errorDetails: params.errorDetails,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 3d. Record Definitive Authorization Failure (Phase 9.2 Confirmed Rejection Only)
export async function recordAuthorizationDefinitiveFailureInDb(params: {
  paymentAttemptId: string;
  errorDetails: Record<string, unknown>;
  notes: string;
}): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date().toISOString();
    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        status: "FAILED",
        manual_reconciliation_required: false,
        reconciliation_notes: params.notes,
        error_details: params.errorDetails,
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .eq("status", "APPROVED")
      .select("id, payer_id, project_id, milestone_id, payment_attempt_id, order_id")
      .single();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to record definitive authorization failure." };
    }

    // Update milestone
    await supabase
      .from("milestones")
      .update({ payment_status: "failed" })
      .eq("id", updatedPayment.milestone_id);

    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_AUTHORIZATION_FAILED",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        paymentAttemptId: updatedPayment.payment_attempt_id,
        orderId: updatedPayment.order_id,
        status: "FAILED",
        notes: params.notes,
        errorDetails: params.errorDetails,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 4. Pre-Capture: Mark payment as CAPTURE_PENDING before dispatching network request
export interface RecordCaptureInitiatedResult {
  success: boolean;
  payment?: any;
  error?: string;
  conflict?: boolean;
}

export async function recordCaptureInitiatedInDb(params: {
  paymentAttemptId: string;
  authorizationId: string;
  idempotencyKey: string;
}): Promise<RecordCaptureInitiatedResult> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const now = new Date().toISOString();
  const nowMs = Date.now();

  // 1. Fetch current status and timestamps to evaluate transition
  const { data: currentPayment, error: fetchErr } = await supabase
    .from("payments")
    .select("id, status, capture_initiated_at, manual_reconciliation_required, milestone_id")
    .eq("payment_attempt_id", params.paymentAttemptId)
    .maybeSingle();

  if (fetchErr || !currentPayment) {
    return { success: false, error: fetchErr?.message || "Payment attempt not found." };
  }

  // 2. If already CAPTURED or SETTLED, no need to initiate
  if (currentPayment.status === "CAPTURED" || currentPayment.status === "SETTLED") {
    return { success: true, payment: currentPayment };
  }

  // 3. If currently AUTHORIZED: Perform atomic conditional update strictly from AUTHORIZED
  if (currentPayment.status === "AUTHORIZED") {
    const { data, error } = await supabase
      .from("payments")
      .update({
        status: "CAPTURE_PENDING",
        idempotency_auth_capture: params.idempotencyKey,
        capture_initiated_at: now,
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .eq("status", "AUTHORIZED") // Atomic conditional guard
      .select()
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }
    if (!data) {
      // 0 rows updated: another concurrent process won the transition race!
      return {
        success: false,
        conflict: true,
        error: "Concurrent capture collision: another server process is already capturing this payment attempt.",
      };
    }

    // Update milestone
    await supabase
      .from("milestones")
      .update({ payment_status: "capture_pending" })
      .eq("id", data.milestone_id);

    return { success: true, payment: data };
  }

  // 4. If currently CAPTURE_PENDING:
  // Check if an in-flight capture is already active (initiated within last 30s and not flagged for manual reconciliation)
  if (currentPayment.status === "CAPTURE_PENDING") {
    const initiatedAt = currentPayment.capture_initiated_at
      ? new Date(currentPayment.capture_initiated_at).getTime()
      : 0;
    const isRecentInFlight =
      !currentPayment.manual_reconciliation_required && nowMs - initiatedAt < 30000;

    if (isRecentInFlight) {
      return {
        success: false,
        conflict: true,
        error: "Concurrent capture in progress: a capture operation is already in-flight on another server process.",
      };
    }

    // Attempt is a retry of a timed-out or uncertain capture. Atomically claim retry lock.
    const { data: retryData, error: retryErr } = await supabase
      .from("payments")
      .update({
        capture_initiated_at: now,
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .eq("status", "CAPTURE_PENDING")
      .select()
      .maybeSingle();

    if (retryErr || !retryData) {
      return {
        success: false,
        conflict: true,
        error: "Failed to claim capture retry lock at database level.",
      };
    }

    return { success: true, payment: retryData };
  }

  return {
    success: false,
    error: `Payment is in invalid status '${currentPayment.status}' for capture initiation.`,
  };
}

export async function markPaymentCapturePending(
  authorizationId: string
): Promise<{ success: boolean; payment?: any; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("payments")
    .update({
      status: "CAPTURE_PENDING",
      capture_initiated_at: now,
      updated_at: now,
    })
    .eq("authorization_id", authorizationId)
    .in("status", ["AUTHORIZED", "CAPTURE_PENDING"])
    .select()
    .single();

  if (error || !data) {
    return {
      success: false,
      error: error?.message || "Payment is not in an authorized state eligible for capture.",
    };
  }

  // Update milestone
  await supabase
    .from("milestones")
    .update({ payment_status: "capture_pending" })
    .eq("id", data.milestone_id);

  return { success: true, payment: data };
}

// 5. Post-Capture: Mark payment as CAPTURED upon confirmed PayPal capture
export async function recordCaptureSuccessInDb(params: {
  paymentAttemptId: string;
  authorizationId: string;
  captureId: string;
  rawPayload?: unknown;
}): Promise<{ success: boolean; payment?: any; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    // 1. Fetch current payment record to check if already captured
    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id, status, capture_id, captured_at, milestone_id, project_id, payer_id, amount, currency")
      .eq("payment_attempt_id", params.paymentAttemptId)
      .maybeSingle();

    if (existingPayment?.status === "CAPTURED") {
      // Already captured: safely return existing record without overwriting capture_id or timestamps
      return { success: true, payment: existingPayment };
    }

    const now = new Date().toISOString();
    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        status: "CAPTURED",
        capture_id: params.captureId,
        captured_at: now,
        manual_reconciliation_required: false,
        raw_paypal_response: params.rawPayload || {},
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .in("status", ["AUTHORIZED", "CAPTURE_PENDING"])
      .select("id, milestone_id, project_id, payer_id, amount, currency")
      .maybeSingle();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to update payment to captured (invalid state or concurrent transition)." };
    }

    // Update milestone to captured and completed
    await supabase
      .from("milestones")
      .update({
        payment_status: "captured",
        capture_id: params.captureId,
        captured_date: now,
        status: "completed",
      })
      .eq("id", updatedPayment.milestone_id);

    // Record audit log
    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_CAPTURED",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        captureId: params.captureId,
        status: "CAPTURED",
        capturedAt: now,
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        paymentSafety: "Standard merchant capture completed. Payment authorization captured; settlement is separate.",
      },
    });

    return { success: true, payment: updatedPayment };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function recordCaptureUncertainInDb(params: {
  paymentAttemptId: string;
  authorizationId: string;
  errorDetails: Record<string, unknown>;
}): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date().toISOString();
    // Payment remains in CAPTURE_PENDING with manual_reconciliation_required = true
    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        status: "CAPTURE_PENDING",
        manual_reconciliation_required: true,
        error_details: params.errorDetails,
        reconciliation_notes: `Uncertain capture result at ${now}. Preserved in CAPTURE_PENDING without blind re-capture.`,
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .select("id, milestone_id, project_id, payer_id")
      .single();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to record uncertain capture state." };
    }

    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_CAPTURE_UNCERTAIN",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        status: "CAPTURE_PENDING",
        manualReconciliationRequired: true,
        errorDetails: params.errorDetails,
        reason: "PayPal capture returned timeout or 5xx; preserved in CAPTURE_PENDING to prevent double charge.",
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function recordCaptureDefinitiveFailureInDb(params: {
  paymentAttemptId: string;
  authorizationId: string;
  errorDetails: Record<string, unknown>;
}): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date().toISOString();
    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        status: "FAILED",
        manual_reconciliation_required: false,
        error_details: params.errorDetails,
        updated_at: now,
      })
      .eq("payment_attempt_id", params.paymentAttemptId)
      .select("id, milestone_id, project_id, payer_id")
      .single();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to record definitive capture failure." };
    }

    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_CAPTURE_FAILED",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        status: "FAILED",
        errorDetails: params.errorDetails,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function updatePaymentToCaptured(params: {
  authorizationId: string;
  captureId: string;
  rawPayload?: unknown;
}): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Database client unavailable." };

  try {
    const now = new Date().toISOString();
    const { data: updatedPayment, error } = await supabase
      .from("payments")
      .update({
        status: "CAPTURED",
        capture_id: params.captureId,
        captured_at: now,
        raw_paypal_response: params.rawPayload || {},
        updated_at: now,
      })
      .eq("authorization_id", params.authorizationId)
      .select("id, milestone_id, project_id, payer_id, amount")
      .single();

    if (error || !updatedPayment) {
      return { success: false, error: error?.message || "Failed to update payment to captured." };
    }

    // Update milestone to captured and completed
    await supabase
      .from("milestones")
      .update({
        payment_status: "captured",
        capture_id: params.captureId,
        captured_date: now,
        status: "completed",
      })
      .eq("id", updatedPayment.milestone_id);

    // Record audit log
    await recordAuditLogInDb({
      actorId: updatedPayment.payer_id,
      projectId: updatedPayment.project_id,
      milestoneId: updatedPayment.milestone_id,
      action: "PAYMENT_CAPTURED",
      entityType: "payment",
      entityId: updatedPayment.id,
      newState: {
        captureId: params.captureId,
        status: "CAPTURED",
        capturedAt: now,
      },
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 6. Uncertain Capture Recovery Routine
export async function recoverUncertainCapture(
  authorizationId: string,
  idempotencyKey: string,
  amount: number
): Promise<{
  recovered: boolean;
  finalStatus: "CAPTURED" | "CAPTURE_PENDING" | "FAILED" | "EXPIRED" | "VOIDED";
  captureId?: string;
  details: string;
}> {
  console.warn(`[RECOVERY] Initiating recovery protocol for authorization: ${authorizationId}`);

  try {
    // Query PayPal for true ground-truth state
    const authResource = await getPayPalAuthorization(authorizationId);

    // Step A: Inspect captures array on PayPal resource
    const existingCaptures = authResource.payments?.captures || [];
    const completedCapture = existingCaptures.find(
      (c) => c.status === "COMPLETED" || c.status === "PENDING"
    );

    if (completedCapture) {
      if (completedCapture.status === "COMPLETED") {
        await updatePaymentToCaptured({
          authorizationId,
          captureId: completedCapture.id,
          rawPayload: authResource,
        });
        return {
          recovered: true,
          finalStatus: "CAPTURED",
          captureId: completedCapture.id,
          details: `Capture was previously confirmed on PayPal (${completedCapture.id}). Local state reconciled to CAPTURED.`,
        };
      } else {
        return {
          recovered: true,
          finalStatus: "CAPTURE_PENDING",
          captureId: completedCapture.id,
          details: `PayPal reported capture status as PENDING (${completedCapture.id}). Awaiting settlement.`,
        };
      }
    }

    // Step B: If captures array is empty, check authorization status
    if (authResource.status === "CREATED") {
      // Authorization is still open on PayPal and never captured. Safe to retry capture with same idempotency key!
      console.info(`[RECOVERY] Authorization ${authorizationId} is still open. Safely retrying capture with stable key...`);
      const retryResult = await capturePayPalAuthorization({
        authorizationId,
        amount,
        currency: "USD",
        idempotencyKey,
      });

      if (retryResult.status === "COMPLETED") {
        await updatePaymentToCaptured({
          authorizationId,
          captureId: retryResult.captureId,
          rawPayload: retryResult.raw,
        });
        return {
          recovered: true,
          finalStatus: "CAPTURED",
          captureId: retryResult.captureId,
          details: `Capture safely completed on retry (${retryResult.captureId}).`,
        };
      }
    } else if (authResource.status === "VOIDED" || authResource.status === "EXPIRED") {
      const admin = createAdminClient();
      if (admin) {
        await admin
          .from("payments")
          .update({ status: authResource.status, updated_at: new Date().toISOString() })
          .eq("authorization_id", authorizationId);
      }
      return {
        recovered: true,
        finalStatus: authResource.status as any,
        details: `Authorization is in terminal state on PayPal: ${authResource.status}.`,
      };
    }

    // Step C: Fallback when status cannot be confirmed
    const admin = createAdminClient();
    if (admin) {
      await admin
        .from("payments")
        .update({
          manual_reconciliation_required: true,
          reconciliation_notes: `Ambiguous capture state at ${new Date().toISOString()}. PayPal status: ${authResource.status}`,
        })
        .eq("authorization_id", authorizationId);
    }

    return {
      recovered: false,
      finalStatus: "CAPTURE_PENDING",
      details: "Could not establish clear capture resolution. Payment retained in CAPTURE_PENDING for human/webhook reconciliation.",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[RECOVERY] Recovery routine error for ${authorizationId}:`, msg);
    return {
      recovered: false,
      finalStatus: "CAPTURE_PENDING",
      details: `Recovery call failed: ${msg}. Flagged for manual review.`,
    };
  }
}
