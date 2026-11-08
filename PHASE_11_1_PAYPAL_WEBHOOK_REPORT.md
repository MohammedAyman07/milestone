# MILESTONE AI — Phase 11.1: PayPal Webhook Infrastructure Report

**Date**: November 8, 2026  
**Status**: COMPLETE & VERIFIED  
**Environment**: PayPal Sandbox & Supabase PostgreSQL  
**Test Suite**: `test-phase11-1-paypal-webhooks.js` (19/19 Scenarios Passed, 100%)  

---

## 1. Executive Summary

Phase 11.1 implements a hardened, cryptographically verified, and database-deduplicated PayPal webhook infrastructure for the **MILESTONE AI** platform. The webhook service ingests asynchronous transaction lifecycle events from PayPal Orders v2 and Payments v2, reconciles local payment and milestone records, and enforces strict financial state machine invariants.

### Key Architectural & Financial Guarantees:
1. **Cryptographic Webhook Verification**: Every incoming webhook request is validated using PayPal's official API (`POST /v1/notifications/verify-webhook-signature`) against the configured `PAYPAL_WEBHOOK_ID`. Requests missing required transmission headers or presenting invalid signatures are rejected immediately with HTTP 400.
2. **PostgreSQL-Level Deduplication**: Deliveries are tracked and deduplicated in `public.paypal_webhook_events` using unique database constraints. Duplicate event deliveries (including high-concurrency race conditions) return HTTP 200 without re-executing state transitions.
3. **Strict Passive State Reconciliation**: Webhook handlers **NEVER** initiate financial actions. The handler is strictly prohibited from invoking PayPal's capture, authorization, or refund APIs.
4. **Prohibition of Premature Settlement**: A completed merchant capture (`PAYMENT.CAPTURE.COMPLETED`) transitions local payment records to `CAPTURED`. It **NEVER** marks records as `SETTLED`, respecting the boundary between merchant settlement and freelancer payout.
5. **Terminal State Protection & State Trigger Enforcement**: The database transition trigger (`validate_payment_state_transition`) and handler logic prevent regressing `CAPTURED` or `SETTLED` payments back to `AUTHORIZED`, `VOIDED`, or `FAILED`.
6. **Authoritative Financial Validation**: Webhook amounts and currencies are strictly validated against authoritative Supabase records; mismatches trigger audit logging and are blocked from mutating payment states.

---

## 2. Webhook Architecture & File Manifest

| File | Purpose |
| :--- | :--- |
| `src/app/api/paypal/webhook/route.ts` | Next.js API route receiving PayPal webhook HTTP POST requests. Validates headers, verifies signature, manages deduplication, and coordinates event processing. |
| `src/lib/paypal/webhooks.ts` | Core webhook engine containing signature verification, event persistence, and event-specific reconciliation routines. |
| `PAYPAL_WEBHOOK_SETUP.md` | Comprehensive operational guide for webhook configuration in the PayPal Developer Dashboard, local tunneling (ngrok/Cloudflare), and simulator testing. |
| `test-phase11-1-paypal-webhooks.js` | 19-scenario end-to-end integration and security test suite testing all signature, deduplication, reconciliation, and financial invariant cases. |

---

## 3. Supported Webhook Event Matrix

| PayPal Event Type | Trigger Condition | Local Payment Transition | Local Milestone Status | Security & Financial Invariants |
| :--- | :--- | :--- | :--- | :--- |
| `PAYMENT.AUTHORIZATION.CREATED` | Buyer completed PayPal checkout; authorization created. | `CREATED` / `APPROVED` &rarr; `AUTHORIZED` | `authorized` | Amount & currency verified. Does not regress `CAPTURED` payments. |
| `PAYMENT.AUTHORIZATION.VOIDED` | Authorization voided or expired on PayPal. | `AUTHORIZED` / `CAPTURE_PENDING` / `APPROVED` &rarr; `VOIDED` | `voided` | Blocked if local payment is already `CAPTURED`. |
| `PAYMENT.CAPTURE.COMPLETED` | Capture processed successfully by PayPal. | `CAPTURE_PENDING` / `AUTHORIZED` &rarr; `CAPTURED` | `captured` | Captures merchant funds. **NEVER marks `SETTLED`**. Never calls capture API. |
| `PAYMENT.CAPTURE.DENIED` | Capture denied or declined by PayPal. | `CAPTURE_PENDING` / `AUTHORIZED` &rarr; `FAILED` | `failed` | Error details persisted. Blocked if local payment is already `CAPTURED`. |
| `PAYMENT.CAPTURE.PENDING` | Capture held for manual review by PayPal. | `AUTHORIZED` &rarr; `CAPTURE_PENDING` | `capture_pending` | Status retained in `CAPTURE_PENDING`. Not marked as captured or failed. |
| *Unsupported Events* | e.g. `CUSTOMER.DISPUTE.CREATED`, `CHECKOUT.ORDER.APPROVED` | *No change* | *No change* | Persisted in `paypal_webhook_events` with status `IGNORED`; acknowledged with HTTP 200. |

---

## 4. Security & Idempotency Controls

### 4.1 Header & Certificate Validation
Every request must supply five PayPal webhook transmission headers:
- `paypal-transmission-id`
- `paypal-transmission-time`
- `paypal-cert-url`
- `paypal-auth-algo`
- `paypal-transmission-sig`

Missing headers return HTTP 400. In addition, the `paypal-cert-url` is strictly verified to ensure the URL protocol is HTTPS and the host belongs to the `*.paypal.com` domain (preventing SSRF and certificate spoofing attacks).

### 4.2 Database Deduplication & Concurrent Race Handling
```
Incoming Webhook Delivery (event_id, transmission_id)
        │
        ├──> Query `paypal_webhook_events` by event_id / transmission_id
        │       ├──> Found existing record: Return HTTP 200 { duplicate: true }
        │
        └──> Insert new record with status 'PROCESSING'
                ├──> Unique Violation (PostgreSQL 23505):
                │       Concurrent duplicate delivery detected!
                │       Return HTTP 200 { duplicate: true, status: 'CONCURRENT_DUPLICATE' }
                │
                └──> Insert Success:
                        Execute processPayPalWebhookEvent(...)
                        Update payload with 'PROCESSED' or 'IGNORED'
```

### 4.3 Out-of-Order Delivery Tolerance
If PayPal delivers `PAYMENT.CAPTURE.COMPLETED` prior to receiving or persisting local `CAPTURE_PENDING` (e.g. out-of-order network arrival), the webhook processor automatically steps through intermediate state transitions (`AUTHORIZED` &rarr; `CAPTURE_PENDING` &rarr; `CAPTURED`) to satisfy the PostgreSQL state transition trigger without failing.

### 4.4 Financial Field Integrity
The handler extracts `amount.value` and `amount.currency_code` from the resource and compares them against the authoritative payment record in Supabase:
- If a mismatch occurs, the event is rejected from state mutation, an audit log `PAYPAL_WEBHOOK_AMOUNT_MISMATCH` is persisted, and the payment status remains unchanged.

---

## 5. Test Suite Verification Results

The automated integration test suite (`test-phase11-1-paypal-webhooks.js`) executed all 19 required scenarios against the active dev server and Supabase database.

```
================================================================
MILESTONE AI — Phase 11.1: PayPal Webhook Infrastructure Test Suite
================================================================

✓ Mock PayPal Server running on port 9889
✓ Loaded test project a4fa3ccf-ce87-4848-aaea-9cddd196a083 and test profiles

✓ [PASS] Scenario 1: Valid signature verification -> HTTP 200 returned, signature verified via mock
✓ [PASS] Scenario 2: Invalid signature rejection -> HTTP 400 returned for rejected signature
✓ [PASS] Scenario 3: Missing signature headers -> HTTP 400 returned when any required header is omitted
✓ [PASS] Scenario 4: Duplicate event delivery -> HTTP 200 returned, duplicate detected, no execution
✓ [PASS] Scenario 5: Concurrent duplicate delivery handling -> Both returned HTTP 200 without DB corruption (duplicate flagged: true)
✓ [PASS] Scenario 6: Unsupported event type -> HTTP 200, outcome IGNORED persisted in DB
✓ [PASS] Scenario 7: PAYMENT.AUTHORIZATION.CREATED reconciliation -> Payment updated to AUTHORIZED, milestone to authorized
✓ [PASS] Scenario 8: PAYMENT.AUTHORIZATION.VOIDED reconciliation -> Payment updated to VOIDED, milestone to voided
✓ [PASS] Scenario 9: PAYMENT.CAPTURE.COMPLETED reconciliation -> Payment reconciled to CAPTURED, capture_id persisted
✓ [PASS] Scenario 10: PAYMENT.CAPTURE.DENIED reconciliation -> Payment reconciled to FAILED with denial reason
✓ [PASS] Scenario 11: PAYMENT.CAPTURE.PENDING reconciliation -> Payment status retained/set in CAPTURE_PENDING
✓ [PASS] Scenario 12: Incorrect amount in webhook payload -> Rejected modification, state remained AUTHORIZED
✓ [PASS] Scenario 13: Incorrect currency in webhook payload -> Currency mismatch rejected, status unchanged
✓ [PASS] Scenario 14: Unknown payment attempt / resource -> Gracefully acknowledged (UNMATCHED), HTTP 200 returned
✓ [PASS] Scenario 15: Replay of old event on already-CAPTURED payment -> Replay blocked, status remained CAPTURED
✓ [PASS] Scenario 16: Processing failure returns retryable status -> HTTP 500 returned on transient failure for PayPal retry
✓ [PASS] Scenario 17: Out-of-order event delivery -> Stepped through transitions safely to reach CAPTURED
✓ [PASS] Scenario 18: Webhook cannot transition CAPTURED to SETTLED -> Status is CAPTURED, never marked SETTLED
✓ [PASS] Scenario 19: Webhook handler never invokes PayPal capture API -> Total capture calls on mock server: 0

Cleaning up fixtures and restoring environment...

================================================================
Phase 11.1 Test Summary: 19 Passed, 0 Failed (Total 19)
================================================================
```

---

## 6. Regression & Security Audit Verification

1. **Phase 10.3 Capture Security Audit Test Suite**:
   - `node test-phase10-3-capture-audit.js`: **25/25 Passed (100%)**
2. **Secrets Exposure Audit**:
   - `node audit-secrets.js`: **0 Hardcoded Secrets Found (PASS)**
3. **TypeScript Typecheck**:
   - `npx tsc --noEmit`: **0 Errors (Exit code 0)**
4. **Production Build**:
   - `npm run build`: **Success (Exit code 0)**, `/api/paypal/webhook` generated as dynamic route.

---

## 7. Operational Readiness

- Webhook setup documentation is complete in `PAYPAL_WEBHOOK_SETUP.md`.
- Developers can configure `PAYPAL_WEBHOOK_ID` in `.env.local` upon registering their webhook listener URL in the PayPal Developer Dashboard or using a tunnel (ngrok / Cloudflare).
- The infrastructure is ready for Sandbox and Live deployment.
