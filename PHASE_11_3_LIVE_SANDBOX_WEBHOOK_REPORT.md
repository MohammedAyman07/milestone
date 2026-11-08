# MILESTONE AI — Phase 11.3: PayPal Sandbox Webhook Registration and Live Delivery Report

**Date**: November 8, 2026  
**Status**: INVESTIGATION & READINESS VERIFIED; BLOCKED ON PUBLIC TUNNEL / REGISTRATION  
**Active Environment**: PayPal Sandbox (`PAYPAL_ENVIRONMENT=sandbox`)  
**Regression Tests**:
- Phase 11.2 Audit Suite: **16/16 Passed (100%)**
- Phase 11.1 Webhook Suite: **19/19 Passed (100%)**
- Phase 10.3 Capture Audit Suite: **25/25 Passed (100%)**
- TypeScript Check: **0 Errors**
- Production Build: **Success**

---

## 1. Executive Summary & Delivery Status

In accordance with Phase 11.3 requirements, we conducted a rigorous inspection of the current PayPal Sandbox configuration, the live PayPal Sandbox REST API, and local delivery prerequisites.

### Core Delivery Result:
> [!IMPORTANT]
> **Actual Unsolicited PayPal Sandbox Webhook Delivery to Localhost is BLOCKED.**  
> - **Root Cause**: The application is running locally on `http://localhost:3000`. PayPal Sandbox webhook delivery infrastructure explicitly rejects non-public / non-HTTPS URLs (`Not a valid webhook URL` on `localhost`) and currently has **0 webhooks registered** for this sandbox application.  
> - **Integrity Policy**: Per instructions, we do **not** claim success or substitute mocked dispatcher tests as proof of actual delivery. Real unsolicited webhook delivery from PayPal's servers requires a publicly accessible HTTPS tunnel (via ngrok or Cloudflare Tunnel) registered on PayPal.

---

## 2. Configuration Inspection

| Parameter | Current Value / State | Verification Note |
| :--- | :--- | :--- |
| **`PAYPAL_ENVIRONMENT`** | `sandbox` | Confirmed Sandbox mode. Live mode is strictly prohibited. |
| **`PAYPAL_CLIENT_ID`** | Configured | Verified valid OAuth2 credentials with PayPal Sandbox. |
| **`PAYPAL_CLIENT_SECRET`** | Configured | Verified valid OAuth2 credentials with PayPal Sandbox. Never exposed or printed. |
| **`PAYPAL_WEBHOOK_ID`** | *Not set* (Empty) | Ready to be populated once the public webhook is registered. |
| **Active Tunnel** | None running | No background tunnel (ngrok / cloudflared) is currently active. |

---

## 3. Separation of Verification Domains

### 3.1 Successfully Completed Live Checks (Real Sandbox & Real DB)
1. **Live PayPal Sandbox OAuth2 Authentication**:
   - Dispatched live OAuth2 request to `https://api-m.sandbox.paypal.com/v1/oauth2/token`.
   - **Result**: Successfully authenticated and obtained active access token (`App ID: APP-3E016709SK543213E`).
2. **Live PayPal Sandbox Webhook Query**:
   - Queried `GET /v1/notifications/webhooks` against `api-m.sandbox.paypal.com`.
   - **Result**: Verified that **0 webhooks** are currently registered on this Sandbox application.
3. **Live PayPal Signature Verification Endpoint**:
   - Sent live verification request to `POST /v1/notifications/verify-webhook-signature` on `api-m.sandbox.paypal.com`.
   - **Result**: Confirmed that PayPal's live API responds with HTTP 200 `{ verification_status: 'FAILURE' }` when given an invalid signature or unregistered webhook ID, demonstrating fail-closed behavior.
4. **Live Supabase PostgreSQL Database & RLS**:
   - Verified that `paypal_webhook_events` exists with all 11 columns.
   - Verified that PostgreSQL unique constraints on `transmission_id` reject duplicates (`23505`).
   - Verified that anonymous and authenticated browser users are strictly blocked by PostgreSQL permissions (`permission denied for table paypal_webhook_events`).
5. **Programmatic Registration Tooling**:
   - Authored `scripts/register_paypal_webhook.js` which automates registration of the 5 required event types via PayPal's official API and automatically updates `PAYPAL_WEBHOOK_ID` in `.env.local`.

### 3.2 Mocked or Simulated Tests
1. **Dispatcher Simulation Tests**:
   - Tests in `test-phase11-1-paypal-webhooks.js` and `test-phase11-2-webhook-audit.js` use an internal HTTP mock server to simulate the webhook delivery headers and payloads from PayPal.
   - **Distinction**: These tests verify our endpoint logic, deduplication, retry recovery, and database state transitions, but do **not** represent unsolicited network delivery from PayPal's public cloud servers.

### 3.3 Manual Steps Required to Receive Real PayPal Sandbox Deliveries
To allow PayPal Sandbox's cloud servers to deliver events to your local machine:

#### Step 1: Start a Public HTTPS Tunnel
In a separate terminal window, run either:
- **Using Cloudflare Tunnel (Recommended, No Account Required)**:
  ```bash
  npx --yes cloudflared tunnel --url http://localhost:3000
  ```
- **Using ngrok**:
  ```bash
  ngrok http 3000
  ```
Copy the generated HTTPS URL (e.g. `https://your-tunnel-name.trycloudflare.com` or `https://xyz.ngrok-free.app`).

#### Step 2: Register the Webhook with PayPal
Run the provided automated registration script using your tunnel URL:
```bash
node scripts/register_paypal_webhook.js https://YOUR_PUBLIC_TUNNEL/api/paypal/webhook
```
*Alternatively, register manually in [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) &rarr; Apps & Credentials &rarr; Sandbox &rarr; Webhooks.*

The script will subscribe to the 5 required event types and automatically save `PAYPAL_WEBHOOK_ID` in `.env.local`:
- `PAYMENT.AUTHORIZATION.CREATED`
- `PAYMENT.AUTHORIZATION.VOIDED`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.PENDING`

#### Step 3: Trigger Real Sandbox Delivery
- Go to **Developer Dashboard** &rarr; **Testing Tools** &rarr; **Webhook Simulator**.
- Target: `https://YOUR_PUBLIC_TUNNEL/api/paypal/webhook`.
- Event: `Payment capture completed` or `Payment authorization created`.
- Send Test.

### 3.4 Blocked Checks
- **Unsolicited Real Cloud Delivery**: Blocked pending developer provisioning of a public HTTPS tunnel (as local servers cannot receive external inbound traffic without port-forwarding or tunneling).

---

## 4. Safety & Invariant Verification Summary

| Invariant | Implementation Mechanism | Test Verification | Status |
| :--- | :--- | :--- | :--- |
| **Invalid Signature Rejection** | `/v1/notifications/verify-webhook-signature` check | `test-phase11-2-webhook-audit.js` (Security 4C) | **VERIFIED** |
| **Duplicate Event Safety** | PostgreSQL UNIQUE index on `transmission_id` | `test-phase11-2-webhook-audit.js` (Database 1B) | **VERIFIED** |
| **Terminal State Immutability** | Trigger `validate_payment_state_transition` | `test-phase11-2-webhook-audit.js` (Event Ordering 2A–2D) | **VERIFIED** |
| **No Direct Capture from Webhook** | Passive event reconciliation only | `test-phase11-1-paypal-webhooks.js` (Scenario 19: 0 capture calls) | **VERIFIED** |
| **No Premature Settlement** | Status set strictly to `CAPTURED`, never `SETTLED` | `test-phase11-2-webhook-audit.js` (Event Ordering 2E) | **VERIFIED** |
| **Failed Event Redelivery Recovery** | Status `'FAILED'` updated to `'PROCESSING'` on redelivery | `test-phase11-2-webhook-audit.js` (Reliability 3B) | **VERIFIED** |

---

## 5. Regression & Build Verification Results

- **TypeScript Typecheck**:
  `npx tsc --noEmit` &rarr; **Exit code 0 (0 errors)**
- **Production Build**:
  `npm run build` &rarr; **Exit code 0 (Success, `/api/paypal/webhook` dynamic route)**
- **Phase 11.2 Audit Suite**:
  `node test-phase11-2-webhook-audit.js` &rarr; **16/16 Passed (100%)**
- **Phase 11.1 Webhook Suite**:
  `node test-phase11-1-paypal-webhooks.js` &rarr; **19/19 Passed (100%)**
- **Phase 10.3 Capture Audit Suite**:
  `node test-phase10-3-capture-audit.js` &rarr; **25/25 Passed (100%)**
- **Secrets Audit**:
  `node audit-secrets.js` &rarr; **0 Exposed Secrets**
