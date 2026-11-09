import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limiter";
import { getPayPalOrder } from "@/lib/paypal/orders";
import {
  PayPalApiError,
  PayPalTimeoutError,
  PayPalNetworkError,
} from "@/lib/paypal/client";
import {
  getPaymentByOrderId,
  recordBuyerApprovalInDb,
} from "@/lib/supabase/payments-db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 1. Rate Limiting Check (per client IP)
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1";

  const rateCheck = checkRateLimit(`paypal-validate-approval:${clientIp}`, 30, 60000);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many validation requests. Please wait a moment and try again." },
      { status: 429 }
    );
  }

  // 2. Parse request body
  let body: { orderId?: string; payerId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request payload." },
      { status: 400 }
    );
  }

  const { orderId, payerId } = body;
  if (!orderId || typeof orderId !== "string" || !orderId.trim()) {
    return NextResponse.json(
      { error: "Order ID (token) is required to validate buyer approval." },
      { status: 400 }
    );
  }

  const cleanOrderId = orderId.trim();

  // 3. Authenticate current user via Supabase session or Bearer token
  const authHeader = req.headers.get("authorization");
  let user: { id: string } | null = null;
  const supabase = await createServerSupabaseClient();

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (supabase) {
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (!userError && userData?.user) {
        user = userData.user;
      }
    }
  }

  if (!user && supabase) {
    const { data: cookieUserData } = await supabase.auth.getUser();
    if (cookieUserData?.user) {
      user = cookieUserData.user;
    }
  }

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized: An authenticated session is required to validate payment approval." },
      { status: 401 }
    );
  }

  // 4. Retrieve stored payment attempt from Supabase
  const paymentLookup = await getPaymentByOrderId(cleanOrderId);
  if (!paymentLookup.success || !paymentLookup.payment) {
    return NextResponse.json(
      { error: "Payment attempt not found for the specified PayPal order ID." },
      { status: 404 }
    );
  }

  const payment = paymentLookup.payment;

  // 5. Verify ownership: user must be the client/payer
  if (payment.payer_id !== user.id) {
    return NextResponse.json(
      {
        error: "Forbidden: You are currently signed in with a Freelancer or unauthorized account. Only the project Client who initiated this payment hold is authorized to confirm and authorize it.",
        ownershipMismatch: true,
      },
      { status: 403 }
    );
  }

  // 6. Handle Idempotent & Terminal State Checks
  if (payment.status === "APPROVED") {
    return NextResponse.json(
      {
        success: true,
        alreadyApproved: true,
        status: "APPROVED",
        paymentAttemptId: payment.payment_attempt_id,
        milestoneId: payment.milestone_id,
        orderId: cleanOrderId,
        amount: payment.amount,
        currency: payment.currency,
        message: "Payment approval was already verified and recorded.",
      },
      { status: 200 }
    );
  }

  const activePostApprovalStatuses = ["AUTHORIZED", "CAPTURE_PENDING", "CAPTURED", "SETTLED"];
  if (activePostApprovalStatuses.includes(payment.status)) {
    return NextResponse.json(
      {
        success: true,
        alreadyApproved: true,
        status: payment.status,
        paymentAttemptId: payment.payment_attempt_id,
        milestoneId: payment.milestone_id,
        orderId: cleanOrderId,
        amount: payment.amount,
        currency: payment.currency,
        message: `Payment is already past approval (Current status: ${payment.status}).`,
      },
      { status: 200 }
    );
  }

  if (["FAILED", "VOIDED", "EXPIRED"].includes(payment.status)) {
    return NextResponse.json(
      {
        error: `Cannot validate approval: Payment attempt is in terminal status ${payment.status}.`,
        status: payment.status,
      },
      { status: 409 }
    );
  }

  if (payment.status !== "CREATED") {
    return NextResponse.json(
      {
        error: `Invalid transition: Expected payment status CREATED, but found ${payment.status}.`,
        status: payment.status,
      },
      { status: 409 }
    );
  }

  // 7. Fetch the actual order details directly from PayPal using server-side credentials
  let paypalOrder;
  try {
    paypalOrder = await getPayPalOrder(cleanOrderId);
  } catch (err: unknown) {
    if (err instanceof PayPalTimeoutError || err instanceof PayPalNetworkError) {
      return NextResponse.json(
        {
          error: "Network timeout while verifying order with PayPal. Please retry verification shortly.",
          retryable: true,
          outcome: "UNCERTAIN_NETWORK",
        },
        { status: 504 }
      );
    }

    if (err instanceof PayPalApiError) {
      if (!err.isDefinitiveRejection) {
        return NextResponse.json(
          {
            error: `Upstream PayPal service unavailable [HTTP ${err.status}]: ${err.message}. Please retry verification shortly.`,
            retryable: true,
            outcome: "UNCERTAIN_UPSTREAM",
            debugId: err.debugId,
          },
          { status: err.status === 504 || err.status === 408 ? 504 : 502 }
        );
      }

      return NextResponse.json(
        {
          error: `PayPal order verification rejected [HTTP ${err.status}]: ${err.message}`,
          definitive: true,
          debugId: err.debugId,
        },
        { status: 400 }
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to retrieve order details from PayPal: ${msg}` },
      { status: 500 }
    );
  }

  if (!paypalOrder || !paypalOrder.id) {
    return NextResponse.json(
      { error: "PayPal response did not contain valid order details." },
      { status: 400 }
    );
  }

  // 8. Strict Financial Integrity Validations against the PayPal Order

  // 8a. Verify Order Intent is strictly AUTHORIZE
  if (paypalOrder.intent !== "AUTHORIZE") {
    return NextResponse.json(
      {
        error: `Security Violation: PayPal order intent is '${paypalOrder.intent}', expected 'AUTHORIZE'.`,
      },
      { status: 400 }
    );
  }

  // 8b. Verify Order Status is strictly APPROVED
  if (paypalOrder.status !== "APPROVED") {
    return NextResponse.json(
      {
        error: `PayPal order has not been approved by buyer (Current PayPal status: ${paypalOrder.status}).`,
        orderStatus: paypalOrder.status,
      },
      { status: 400 }
    );
  }

  // 8c. Inspect Purchase Unit
  const purchaseUnit = paypalOrder.purchase_units?.[0];
  if (!purchaseUnit) {
    return NextResponse.json(
      { error: "PayPal order contains no purchase units." },
      { status: 400 }
    );
  }

  // 8d. Verify Milestone Reference ID
  if (purchaseUnit.reference_id !== payment.milestone_id) {
    return NextResponse.json(
      {
        error: `Security Violation: Order reference ID '${purchaseUnit.reference_id}' does not match milestone '${payment.milestone_id}'.`,
      },
      { status: 400 }
    );
  }

  // 8e. Verify Custom ID (Payment Attempt ID)
  if (purchaseUnit.custom_id !== payment.payment_attempt_id) {
    return NextResponse.json(
      {
        error: `Security Violation: Order custom ID '${purchaseUnit.custom_id}' does not match payment attempt '${payment.payment_attempt_id}'.`,
      },
      { status: 400 }
    );
  }

  // 8f. Verify Amount
  const orderAmountValue = parseFloat(purchaseUnit.amount?.value || "0");
  const storedAmountValue = parseFloat(Number(payment.amount).toFixed(2));
  if (Math.abs(orderAmountValue - storedAmountValue) > 0.001) {
    return NextResponse.json(
      {
        error: `Financial Integrity Violation: PayPal order amount ($${orderAmountValue.toFixed(2)}) does not match milestone amount ($${storedAmountValue.toFixed(2)}).`,
      },
      { status: 400 }
    );
  }

  // 8g. Verify Currency (strictly USD)
  const orderCurrency = purchaseUnit.amount?.currency_code;
  if (orderCurrency !== "USD" || payment.currency !== "USD") {
    return NextResponse.json(
      {
        error: `Currency Violation: PayPal order currency '${orderCurrency}' does not match required currency 'USD'.`,
      },
      { status: 400 }
    );
  }

  // 8h. Verify Merchant Payee (if specified on the PayPal order)
  if (purchaseUnit.payee?.merchant_id && payment.raw_paypal_response?.purchase_units?.[0]?.payee?.merchant_id) {
    const expectedMerchantId = payment.raw_paypal_response.purchase_units[0].payee.merchant_id;
    if (purchaseUnit.payee.merchant_id !== expectedMerchantId) {
      return NextResponse.json(
        {
          error: `Payee Mismatch Violation: Order merchant payee '${purchaseUnit.payee.merchant_id}' does not match expected payee '${expectedMerchantId}'.`,
        },
        { status: 400 }
      );
    }
  }

  // 9. Extract Verified PayPal Payer Details STRICTLY from the PayPal API response
  // Identity Architecture Note (Phase 9.1.1 Security Audit):
  // - Supabase user.id is the Application Identity (PostgreSQL UUID: payment.payer_id).
  // - PayPal payer_id is the Financial Identity (PayPal customer account ID: payment.paypal_payer_id).
  // They are fundamentally distinct identifiers and must NEVER be directly compared.
  // We NEVER trust client-supplied payer IDs or fall back to browser-supplied parameters.
  const verifiedPayerId = paypalOrder.payer?.payer_id;
  const verifiedPayerEmail = paypalOrder.payer?.email_address;

  if (!verifiedPayerId || typeof verifiedPayerId !== "string" || !verifiedPayerId.trim()) {
    return NextResponse.json(
      { error: "PayPal order response does not contain verified buyer payer details." },
      { status: 400 }
    );
  }

  // Explicit check: reject invalid assumption that PayPal payer_id equals Supabase user UUID
  if (payerId && payerId === user.id) {
    console.warn(
      `[Security Audit] Client submitted Supabase User UUID as payerId. Ignored in favor of verified PayPal payer_id: ${verifiedPayerId}`
    );
  }

  // 10. Record Verified Buyer Approval in Database
  const updateResult = await recordBuyerApprovalInDb({
    orderId: cleanOrderId,
    payerId: verifiedPayerId,
    payerEmail: verifiedPayerEmail,
    rawPayload: paypalOrder,
  });

  if (!updateResult.success) {
    return NextResponse.json(
      { error: updateResult.error || "Failed to persist approved payment status." },
      { status: 500 }
    );
  }

  // 11. Return Verified Success Response
  return NextResponse.json(
    {
      success: true,
      status: "APPROVED",
      paymentAttemptId: payment.payment_attempt_id,
      milestoneId: payment.milestone_id,
      projectId: payment.project_id,
      orderId: cleanOrderId,
      payerId: verifiedPayerId,
      payerEmail: verifiedPayerEmail,
      amount: storedAmountValue,
      currency: "USD",
      message: "Buyer approval verified and recorded successfully. Funds are pending payment authorization hold.",
    },
    { status: 200 }
  );
}
