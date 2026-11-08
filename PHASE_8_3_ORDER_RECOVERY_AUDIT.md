# MILESTONE AI — Phase 8.3: PayPal Order Creation Recovery Audit Report

**Date:** 2026-11-08  
**Phase:** 8.3 — PayPal Order Creation Security, Reliability & Recovery Audit  
**Status:** **AUDITED, HARDENED & VERIFIED (17/17 Automated Tests Passed)**

---

## 1. Executive Summary

This audit investigated a critical financial vulnerability identified in Phase 8.2: **unconditionally transitioning payment attempts to `FAILED` whenever PayPal returned an error or network timeout.** In distributed financial systems, if PayPal commits an order but the HTTP response drops, times out, or returns a 5xx error, marking the local attempt as `FAILED` unlocks the database unique active-attempt barrier (`uq_active_milestone_payment_attempt`). A subsequent user click would create a second payment attempt with a new idempotency key, causing duplicate orders and potential double billing.

In Phase 8.3, this flaw has been completely resolved. The codebase now:
1. **Distinguishes definitive rejection from uncertain outcomes:** Only definitive 4xx rejections (e.g., 400, 422) transition the attempt to `FAILED`.
2. **Preserves active locks on uncertainty:** Network timeouts, dropped connections, 5xx responses, and rate limits leave the attempt in `status = 'CREATED'` with `manual_reconciliation_required = true`. The milestone remains strictly locked from duplicate charges.
3. **Idempotent reconciliation:** Retries reuse the original `payment_attempt_id` and the original `PayPal-Request-Id` idempotency key to query or replay the operation against PayPal.
4. **In-flight concurrency protection:** An in-memory milestone lock blocks concurrent requests before database entry, complemented by the database unique index.
5. **Comprehensive audit trail:** Detailed append-only audit events trace the lifecycle: initiated, confirmed, rejected, uncertain, reconciliation started, and reconciliation resolved.

---

## 2. Source Code Findings & Vulnerabilities Discovered

| Area | Initial State (Vulnerable) | Hardened State (Phase 8.3) |
|---|---|---|
| **Error Classification** | Any caught error in `route.ts` executed `markPaymentAttemptFailed()`. | Structured error classes (`PayPalApiError`, `PayPalTimeoutError`, `PayPalNetworkError`) classify errors as definitive vs uncertain. |
| **Timeout Outcome** | 15s timeout marked the attempt `FAILED`. | Timeouts keep status `CREATED`, set `manual_reconciliation_required = true`, and lock the milestone. |
| **5xx Server Errors** | PayPal 5xx marked the attempt `FAILED`. | PayPal 5xx treated as uncertain (`isDefinitiveRejection = false`), preserving active lock. |
| **Idempotency Key Reuse** | Retries created new attempts with new keys. | Retries on uncertain attempts reuse the exact `payment_attempt_id` and `idempotency_order_create` key. |
| **In-Flight Concurrency** | Rapid double-clicks could race before insert. | In-memory mutex (`acquireMilestoneLock` / `releaseMilestoneLock`) returns HTTP 409 `inFlight = true`. |
| **Approval URL Verification** | Assumed URL was always present on return. | Validates approval URL; if missing/invalid, queries `getPayPalOrder()` before returning. |

---

## 3. Files Changed

### 3.1 [`src/lib/paypal/client.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/paypal/client.ts)
- Introduced typed error classes:
  - `PayPalError`: Base error class with credential sanitization.
  - `PayPalApiError`: Carries `status`, `debugId`, `details`, and `isDefinitiveRejection` (`true` for 400, 401, 403, 404, 422; `false` for 5xx, 408, 429).
  - `PayPalTimeoutError`: Raised on client AbortController timeout (`isTimeout = true`).
  - `PayPalNetworkError`: Raised on socket hang up, connection reset, or DNS failure (`isNetwork = true`).
- Sanitizes credentials from all error strings before throwing.

### 3.2 [`src/lib/paypal/orders.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/paypal/orders.ts)
- Added validation for order ID and approval URL in `createPayPalOrder()`.
- Added `getPayPalOrder(orderId)` to retrieve existing orders from PayPal (`GET /v2/checkout/orders/{orderId}`).

### 3.3 [`src/lib/supabase/payments-db.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/supabase/payments-db.ts)
- `markPaymentAttemptFailed()`: Only called for definitive rejections; sets `manual_reconciliation_required = false`.
- `markPaymentAttemptUncertain()`: Retains `status = 'CREATED'`, sets `manual_reconciliation_required = true`, notes error details for reconciliation.
- `reconcilePaymentAttemptOrder()`: Updates `order_id`, attaches raw response, clears `manual_reconciliation_required = false`.
- `validateMilestonePaymentEligibility()`: Returns `uncertainAttempt` when an un-reconciled attempt exists, returning milestone details to drive automatic reconciliation.

### 3.4 [`src/app/api/paypal/orders/route.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/api/paypal/orders/route.ts)
- Added in-flight concurrency lock (`acquireMilestoneLock` / `releaseMilestoneLock`).
- Implemented automatic reconciliation for uncertain attempts using the original idempotency key.
- Returns HTTP 202 with `outcome: "UNCERTAIN"` and `reconciliationPending: true` when resolution cannot be established.
- Added comprehensive audit logging.

### 3.5 [`test-phase8-3-order-recovery.js`](file:///c:/Users/moham/Desktop/milestone-ai/test-phase8-3-order-recovery.js)
- Standalone automated test suite with an embedded mock PayPal server testing all 10 failure, timeout, concurrency, and reconciliation scenarios.

---

## 4. Database Schema Evaluation

**No database migration was required.**  
The PostgreSQL schema hardened in Phase 7.1 (`supabase/migrations/20261108030000_paypal_payments_hardening.sql`) already contained all necessary architectural primitives:
- `manual_reconciliation_required` (boolean, default false)
- `reconciliation_notes` (text)
- `error_details` (jsonb)
- `idempotency_order_create` (text, unique)
- `uq_active_milestone_payment_attempt` on `milestone_id WHERE status IN ('CREATED', 'APPROVED', 'AUTHORIZED', 'CAPTURE_PENDING')`
- State transition trigger `trg_validate_payment_transition` permits field updates while `status = 'CREATED'`.

---

## 5. Automated Test Results (17/17 Passed)

Executed against live Next.js API server (`http://localhost:3000/api/paypal/orders`) and live Supabase instance with mock PayPal engine:

| Test ID | Test Scenario | Expected Outcome | Actual Result | Status |
|---|---|---|---|:---:|
| **1A** | Definitive PayPal Rejection (422) | HTTP 400 with `definitive: true` | HTTP 400 returned | **PASS** |
| **1B** | DB State on Definitive Rejection | `status = 'FAILED'`, `manual_rec = false` | Marked FAILED | **PASS** |
| **1C** | Audit Log on Definitive Rejection | `PAYPAL_ORDER_CREATION_FAILED` | Audit log verified | **PASS** |
| **2A** | Network Timeout / Connection Drop | HTTP 202 with `outcome: "UNCERTAIN"` | HTTP 202 returned | **PASS** |
| **2B** | DB State on Timeout | Status `CREATED`, `manual_rec = true`, no order_id | Retained CREATED | **PASS** |
| **2C** | Audit Log on Timeout | `PAYPAL_ORDER_CREATION_UNCERTAIN` | Audit log verified | **PASS** |
| **3A** | PayPal 5xx Ambiguous Server Error | HTTP 202 with `outcome: "UNCERTAIN"` | HTTP 202 returned | **PASS** |
| **3B** | DB State on PayPal 5xx | Preserves `CREATED`, `manual_rec = true` | Retained CREATED | **PASS** |
| **4** | Concurrent In-Flight Double Click | HTTP 409 with `inFlight: true` | HTTP 409 returned | **PASS** |
| **5** | Repeated Request Triggers Reconcile | Automatic reconciliation started | Reconciliation invoked | **PASS** |
| **6** | Reconciliation Resolves Existing Order | HTTP 200 with `orderId` & `approvalUrl` | HTTP 200 returned | **PASS** |
| **7** | Reconciliation Fails Repeatedly | HTTP 202 `reconciliationPending: true` | HTTP 202 returned | **PASS** |
| **8** | No Duplicate Attempts Created | Milestone attempt count remains exactly 1 | Verified: 1 attempt | **PASS** |
| **9** | Original Idempotency Key Reused | `PayPal-Request-Id` matches original key | Verified match | **PASS** |
| **10A** | Standard Order Creation Succeeded | HTTP 201 with `orderId` & `approvalUrl` | HTTP 201 returned | **PASS** |
| **10B** | Standard Order DB State | `status = 'CREATED'`, `order_id` populated | DB updated | **PASS** |
| **10C** | Standard Order Audit Events | `INITIATED` & `CREATED` logged | Both logs verified | **PASS** |

---

## 6. Build & Type Checking Verification

- **TypeScript (`npx tsc --noEmit`):** Executed cleanly with exit code 0. Zero errors.
- **Production Build (`npm run build`):** Turbopack compiled all 19 application routes in 1.4s with exit code 0. Dynamic route `ƒ /api/paypal/orders` verified.
- **Secret Scanner (`node audit-secrets.js`):** Confirmed zero hardcoded secrets across all files.

---

## 7. Scope Compliance & Remaining Limitations

### Scope Boundary Adherence:
- **No buyer approval executed:** Approval redirection is deferred to Phase 8.4.
- **No authorization executed:** Captures, refunds, and payouts remain completely unimplemented.
- **No test credentials leaked:** Test suite used mock HTTP endpoints.

### Remaining Limitations:
1. **PayPal Idempotency TTL:** PayPal Orders v2 retains `PayPal-Request-Id` for up to 72 hours. An attempt held in uncertainty for longer than 72 hours will require automated fallback or manual merchant review.
2. **Cross-Instance Memory Locks:** The in-memory mutex (`acquireMilestoneLock`) operates within the Node process. In multi-region horizontally scaled serverless deployments, concurrent requests within the same millisecond rely on the PostgreSQL database unique index (`uq_active_milestone_payment_attempt`) as the ultimate barrier.
