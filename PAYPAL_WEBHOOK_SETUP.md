# PayPal Webhook Setup Guide — MILESTONE AI

This document provides complete instructions for configuring, testing, and securing PayPal webhooks in the **MILESTONE AI** platform.

---

## 1. Overview

MILESTONE AI utilizes PayPal Orders v2 and Payments v2 for milestone funding and capture. Webhooks ensure that asynchronous PayPal transaction state transitions are reliably reconciled with our Supabase database.

### Key Financial & Architectural Guarantees:
1. **Official Signature Verification**: Every webhook request is verified via PayPal's `/v1/notifications/verify-webhook-signature` API using `PAYPAL_WEBHOOK_ID`. Requests with missing or invalid signatures are rejected immediately (HTTP 400).
2. **Database Deduplication**: Webhook deliveries are deduplicated at the PostgreSQL database level using the `paypal_webhook_events` table. Duplicate deliveries immediately return HTTP 200 without re-running business logic.
3. **Passive Reconciliation Only**: Webhook handlers **NEVER** initiate financial operations (no calls to capture, authorization, or refund APIs).
4. **No Premature Settlement**: Merchant capture completion reconciles payment status to `CAPTURED`. It **NEVER** marks payment as `SETTLED` (merchant capture is distinct from freelancer payout).
5. **Terminal State Protection**: Once a payment is `CAPTURED` or `SETTLED`, it can never be regressed to `AUTHORIZED`, `VOIDED`, or `FAILED`.
6. **Financial Field Validation**: Amount and currency in webhook payloads are strictly validated against authoritative Supabase records before state mutation.

---

## 2. Supported Webhook Events

| Event Type | Local State Transition | Local Milestone Status | Description |
| :--- | :--- | :--- | :--- |
| `PAYMENT.AUTHORIZATION.CREATED` | `CREATED`/`APPROVED` &rarr; `AUTHORIZED` | `authorized` | Buyer approved and authorization was created. |
| `PAYMENT.AUTHORIZATION.VOIDED` | `AUTHORIZED`/`CAPTURE_PENDING` &rarr; `VOIDED` | `voided` | Authorization expired or was voided. |
| `PAYMENT.CAPTURE.COMPLETED` | `CAPTURE_PENDING`/`AUTHORIZED` &rarr; `CAPTURED` | `captured` | Capture completed successfully. |
| `PAYMENT.CAPTURE.DENIED` | `CAPTURE_PENDING`/`AUTHORIZED` &rarr; `FAILED` | `failed` | Capture was declined by PayPal. |
| `PAYMENT.CAPTURE.PENDING` | `AUTHORIZED` &rarr; `CAPTURE_PENDING` | `capture_pending` | Capture is pending manual review. |
| *All other events* | *No state change* (Logged as `IGNORED`) | *Unchanged* | Gracefully acknowledged with HTTP 200. |

---

## 3. Configuring Webhooks in PayPal Developer Dashboard

### Step 1: Open PayPal Developer Dashboard
1. Go to [https://developer.paypal.com/dashboard/](https://developer.paypal.com/dashboard/) and log in with your PayPal developer credentials.
2. Under **Apps & Credentials**, select the **Sandbox** tab.
3. Click on your active application (e.g. `Default Application` or your milestone app).

### Step 2: Add Webhook
1. Scroll down to the **Webhooks** section.
2. Click **Add Webhook**.
3. In the **Webhook URL** field, enter your public endpoint:
   ```
   https://<your-public-domain>/api/paypal/webhook
   ```
   *(For local development, see Section 4 for setting up a tunnel)*.
4. In the **Event types** list, select the following events:
   - `Payment authorization created` (`PAYMENT.AUTHORIZATION.CREATED`)
   - `Payment authorization voided` (`PAYMENT.AUTHORIZATION.VOIDED`)
   - `Payment capture completed` (`PAYMENT.CAPTURE.COMPLETED`)
   - `Payment capture denied` (`PAYMENT.CAPTURE.DENIED`)
   - `Payment capture pending` (`PAYMENT.CAPTURE.PENDING`)
5. Click **Save**.

### Step 3: Copy Webhook ID
1. Once saved, PayPal displays the **Webhook ID** (e.g., `WH-85885233K9773200T-27L9610214643534B`).
2. Copy this ID and add it to your `.env.local` file:
   ```env
   PAYPAL_WEBHOOK_ID=WH-85885233K9773200T-27L9610214643534B
   ```

---

## 4. Local Development with Tunneling (ngrok / Cloudflare Tunnel)

Since PayPal Sandbox requires a publicly accessible HTTPS URL to deliver webhooks, use a tunnel during local development:

### Option A: Using ngrok
```bash
ngrok http 3000
```
Copy the generated HTTPS URL (e.g., `https://a1b2-c3d4.ngrok-free.app`) and configure:
`https://a1b2-c3d4.ngrok-free.app/api/paypal/webhook` as your Webhook URL in PayPal Developer Dashboard.

### Option B: Using Cloudflare Tunnel
```bash
cloudflared tunnel --url http://localhost:3000
```
Use the generated `*.trycloudflare.com` HTTPS URL.

---

## 5. Testing Webhooks with PayPal Webhook Simulator

1. Go to **PayPal Developer Dashboard** &rarr; **Testing Tools** &rarr; **Webhook Simulator**.
2. Set **Webhook URL** to your endpoint (e.g. `https://<tunnel-url>/api/paypal/webhook`).
3. Select **Webhook Event**:
   - `Payment capture completed`
   - `Payment authorization created`
   - `Payment authorization voided`
4. Click **Send Test**.
5. Check your application server logs to verify receipt, signature verification, and deduplication.

---

## 6. Automated Integration Testing

Run the comprehensive 19-scenario test suite locally:
```bash
node test-phase11-1-paypal-webhooks.js
```

All 19 test scenarios run against the Next.js endpoint and Supabase database, verifying signature verification, header security, deduplication, state transitions, financial checks, and error recovery.
