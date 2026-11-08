import { NextRequest, NextResponse } from "next/server";
import {
  verifyPayPalWebhookSignature,
  recordWebhookEventInDb,
  processPayPalWebhookEvent,
  updateWebhookEventStatusInDb,
} from "@/lib/paypal/webhooks";

export async function POST(req: NextRequest) {
  // 1. Extract required PayPal webhook headers
  const transmissionId = req.headers.get("paypal-transmission-id");
  const transmissionTime = req.headers.get("paypal-transmission-time");
  const certUrl = req.headers.get("paypal-cert-url");
  const authAlgo = req.headers.get("paypal-auth-algo");
  const transmissionSig = req.headers.get("paypal-transmission-sig");

  // 2. Reject immediately if any required signature header is missing
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return NextResponse.json(
      { error: "Missing required PayPal webhook headers" },
      { status: 400 }
    );
  }

  // 3. Security validation: Certificate URL verification
  try {
    const parsedCertUrl = new URL(certUrl);
    const host = parsedCertUrl.hostname.toLowerCase();
    const envBaseUrl = process.env.PAYPAL_BASE_URL || "";
    let isMockHost = false;
    if (process.env.NODE_ENV !== "production" && envBaseUrl) {
      try {
        isMockHost = new URL(envBaseUrl).hostname.toLowerCase() === host;
      } catch {}
    }

    if (parsedCertUrl.protocol !== "https:" && !isMockHost) {
      return NextResponse.json(
        { error: "Invalid certificate URL protocol: must be HTTPS" },
        { status: 400 }
      );
    }

    const isPayPalDomain = host === "paypal.com" || host.endsWith(".paypal.com");
    if (!isPayPalDomain && !isMockHost) {
      return NextResponse.json(
        { error: "Invalid certificate URL host: must be a PayPal domain" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Malformed certificate URL in webhook headers" },
      { status: 400 }
    );
  }

  // 4. Read raw text body to ensure signature byte accuracy
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "Failed to read request body: " + (err instanceof Error ? err.message : String(err)) },
      { status: 400 }
    );
  }

  let webhookEvent: Record<string, unknown>;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  // 5. Verify PayPal webhook signature with PayPal API
  const isSignatureValid = await verifyPayPalWebhookSignature({
    transmissionId,
    transmissionTime,
    certUrl,
    authAlgo,
    transmissionSig,
    webhookEvent,
  });

  if (!isSignatureValid) {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 400 }
    );
  }

  // 6. Persistence & Deduplication
  const eventId = String(webhookEvent.id || transmissionId);
  const eventType = String(webhookEvent.event_type || "");
  const resource = (webhookEvent.resource as Record<string, unknown>) || {};
  const resourceId = String(resource.id || "unknown");
  const resourceType = String(webhookEvent.resource_type || "unknown");
  const eventTimestamp = String(webhookEvent.create_time || new Date().toISOString());

  const persistResult = await recordWebhookEventInDb({
    transmissionId,
    eventId,
    eventType,
    resourceId,
    resourceType,
    eventTimestamp,
    signatureVerified: true,
    verificationStatus: "VERIFIED",
    rawEvent: webhookEvent,
  });

  // Database error on persisting verified event - return 500 for PayPal retry
  if (!persistResult.success && !persistResult.isDuplicate) {
    return NextResponse.json(
      { error: "Failed to persist webhook event record: " + persistResult.error },
      { status: 500 }
    );
  }

  // Duplicate event detected: Return 200 OK without re-running payment logic
  if (persistResult.isDuplicate) {
    return NextResponse.json(
      {
        message: "Duplicate webhook event acknowledged; skipping execution.",
        eventId,
        duplicate: true,
        status: persistResult.status,
      },
      { status: 200 }
    );
  }

  // 7. Reconcile local state with PayPal transaction event
  try {
    const processResult = await processPayPalWebhookEvent(webhookEvent);

    if (persistResult.recordId) {
      await updateWebhookEventStatusInDb(
        persistResult.recordId,
        processResult.outcome === "IGNORED" ? "IGNORED" : "PROCESSED",
        processResult.error
      );
    }

    return NextResponse.json(
      {
        message: processResult.message || (processResult.success ? "Webhook processed successfully" : "Webhook processing encountered an issue"),
        outcome: processResult.outcome,
        error: processResult.error,
        eventId,
        eventType,
      },
      { status: processResult.success ? 200 : (processResult.outcome === "MISMATCH" || processResult.outcome === "UNMATCHED" || processResult.outcome === "IGNORED_TERMINAL" ? 200 : 500) }
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("Error processing PayPal webhook event:", errorMessage);

    if (persistResult.recordId) {
      await updateWebhookEventStatusInDb(
        persistResult.recordId,
        "FAILED",
        errorMessage
      );
    }

    // Return 500 so PayPal retries transient failure
    return NextResponse.json(
      { error: "Internal error processing webhook event", details: errorMessage },
      { status: 500 }
    );
  }
}
