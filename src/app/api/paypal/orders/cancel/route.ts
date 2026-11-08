import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limiter";
import { recordBuyerCancellationInDb, getPaymentByOrderId } from "@/lib/supabase/payments-db";
import { getPayPalOrder } from "@/lib/paypal/orders";
import {
  PayPalApiError,
  PayPalTimeoutError,
  PayPalNetworkError,
} from "@/lib/paypal/client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1";

  const rateCheck = checkRateLimit(`paypal-cancel-order:${clientIp}`, 20, 60000);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many cancellation requests. Please wait a moment." },
      { status: 429 }
    );
  }

  let body: { orderId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request payload." },
      { status: 400 }
    );
  }

  const { orderId, reason } = body;
  if (!orderId || typeof orderId !== "string" || !orderId.trim()) {
    return NextResponse.json(
      { error: "Order ID (token) is required to cancel a payment attempt." },
      { status: 400 }
    );
  }

  const cleanOrderId = orderId.trim();

  // Authenticate user
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
      { error: "Unauthorized: An authenticated session is required to cancel payment." },
      { status: 401 }
    );
  }

  // Retrieve payment
  const paymentLookup = await getPaymentByOrderId(cleanOrderId);
  if (!paymentLookup.success || !paymentLookup.payment) {
    return NextResponse.json(
      { error: "Payment attempt not found for the specified PayPal order ID." },
      { status: 404 }
    );
  }

  const payment = paymentLookup.payment;

  if (payment.payer_id !== user.id) {
    return NextResponse.json(
      { error: "Forbidden: You are not authorized to cancel this payment attempt." },
      { status: 403 }
    );
  }

  // Idempotent repeated cancellation check
  if (payment.status === "VOIDED" || payment.status === "EXPIRED") {
    return NextResponse.json(
      {
        success: true,
        alreadyVoided: true,
        status: payment.status,
        orderId: cleanOrderId,
        milestoneId: payment.milestone_id,
        projectId: payment.project_id,
        message: `Payment attempt is already closed in status ${payment.status}.`,
      },
      { status: 200 }
    );
  }

  if (["APPROVED", "AUTHORIZED", "CAPTURE_PENDING", "CAPTURED", "SETTLED"].includes(payment.status)) {
    return NextResponse.json(
      {
        error: `Cannot cancel payment: Payment has already progressed to ${payment.status} status.`,
        status: payment.status,
      },
      { status: 409 }
    );
  }

  // Verify actual order status directly with PayPal
  let isDefinitiveClose = false;
  let orderStatusAtPayPal = "UNKNOWN";

  try {
    const paypalOrder = await getPayPalOrder(cleanOrderId);
    orderStatusAtPayPal = paypalOrder.status;

    if (orderStatusAtPayPal === "APPROVED") {
      return NextResponse.json(
        {
          error: "Cannot cancel payment attempt: Order has already been APPROVED by the buyer on PayPal. Approval validation is required.",
          status: "APPROVED",
        },
        { status: 409 }
      );
    }

    if (orderStatusAtPayPal === "VOIDED" || orderStatusAtPayPal === "EXPIRED") {
      isDefinitiveClose = true;
    }
  } catch (err: unknown) {
    if (err instanceof PayPalTimeoutError || err instanceof PayPalNetworkError) {
      return NextResponse.json(
        {
          error: "Network timeout checking order status with PayPal. Safe cancellation cannot be confirmed. Please retry.",
          retryable: true,
        },
        { status: 504 }
      );
    }

    if (err instanceof PayPalApiError && err.status === 404) {
      // Order not found on PayPal (purged or never committed) -> definitively closed
      isDefinitiveClose = true;
      orderStatusAtPayPal = "RESOURCE_NOT_FOUND";
    } else if (err instanceof PayPalApiError && !err.isDefinitiveRejection) {
      return NextResponse.json(
        {
          error: `Upstream PayPal service unavailable [HTTP ${err.status}]. Safe cancellation cannot be confirmed. Please retry.`,
          retryable: true,
        },
        { status: 502 }
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Failed to verify order status with PayPal: ${msg}` },
        { status: 500 }
      );
    }
  }

  // Record cancellation in DB using safe cancellation policy
  const cancelResult = await recordBuyerCancellationInDb({
    orderId: cleanOrderId,
    userId: user.id,
    reason: reason || "Buyer cancelled PayPal checkout in browser",
    confirmedDefinitiveClose: isDefinitiveClose,
    orderStatusAtPayPal,
  });

  if (!cancelResult.success) {
    return NextResponse.json(
      { error: cancelResult.error || "Failed to process cancellation." },
      { status: 409 }
    );
  }

  // If order was preserved in CREATED because PayPal order is still active:
  if (cancelResult.outcome === "CANCELLATION_RECORDED_ORDER_PRESERVED") {
    return NextResponse.json(
      {
        success: true,
        status: "CREATED",
        preserved: true,
        orderStatusAtPayPal,
        orderId: cleanOrderId,
        milestoneId: payment.milestone_id,
        projectId: payment.project_id,
        message: "Buyer cancellation recorded. Because the PayPal order remains active on PayPal, the attempt is preserved in CREATED status to prevent duplicate orders.",
      },
      { status: 200 }
    );
  }

  // Order definitively closed
  return NextResponse.json(
    {
      success: true,
      status: "VOIDED",
      orderId: cleanOrderId,
      milestoneId: payment.milestone_id,
      projectId: payment.project_id,
      message: "PayPal order is definitively closed. Payment attempt has been voided and the milestone is unlocked.",
    },
    { status: 200 }
  );
}
