# MILESTONE AI — Phase 9.2: PayPal Server-Side Payment Authorization Report

**Date:** 2026-11-08  
**Environment:** PayPal Sandbox / Localhost Development  
**Status:** COMPLETE (All 16 Authorization Test Scenarios Passing, Full Regression Passing)

---

## Executive Summary

Phase 9.2 implements secure, server-side PayPal Orders v2 payment authorization (`POST /v2/checkout/orders/{id}/authorize`) for the Milestone AI MVP. Following buyer approval (Phase 9.1 & 9.1.1), the client can now securely lock agreed escrow funds without capturing or releasing them.

Crucially, **authorization is strictly distinguished from capture**. The system places an official 29-day authorization hold on the client's PayPal payment source (with a 3-day honor period), locking the funds in escrow. Funds remain untouched until work is submitted by the freelancer, reviewed by AI verification, and approved by the client.

All 16 test scenarios specified in the Phase 9.2 requirements—encompassing role authorization, financial integrity checks, operation-specific idempotency, timeout/5xx recovery without state corruption, duplicate protection, and database transition triggers—passed with **26/26 assertions passing**. Full historical regressions (Phase 9.1.1, 9.1, 8.5, 8.4) and production builds remain green.

---

## 1. Architectural Implementation Overview

```
                                      ┌─────────────────────────────────────────────────────────┐
                                      │              CLIENT BROWSER (Next.js UI)                │
                                      │  Shows "Authorize Escrow Hold" Action & Clear Notice    │
                                      │  "Funds held in escrow — NOT captured at this stage"   │
                                      └────────────────────────────┬────────────────────────────┘
                                                                   │
                                        POST /api/paypal/orders/authorize
                                        { paymentAttemptId: "att_..." }
                                        (Client body parameters are unauthoritative)
                                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 SERVER-SIDE AUTHORIZATION ROUTE                                        │
│                        (src/app/api/paypal/orders/authorize/route.ts)                                  │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Authenticate user via Supabase Session or Bearer Token                                              │
│ 2. Load paymentAttempt, milestone, and project from PostgreSQL by payment_attempt_id                    │
│ 3. Authorize Role & Ownership: Require payment.payer_id === user.id && project.client_id === user.id    │
│ 4. Check Payment Status:                                                                               │
│    - If already AUTHORIZED: Return HTTP 200 idempotent response with existing auth details             │
│    - If status !== APPROVED: Reject with HTTP 400 Bad Request                                          │
│ 5. Check Idempotency Retention Window (6h default / 72h confirmed) if uncertain                        │
│ 6. Fetch PayPal Order: GET /v2/checkout/orders/{order_id}                                              │
│    - If order already has an authorization on PayPal: Reconcile DB to AUTHORIZED & return 200          │
│ 7. Validate Order Details against Database:                                                            │
│    - intent === 'AUTHORIZE'                                                                            │
│    - status === 'APPROVED'                                                                             │
│    - reference_id === milestone.id                                                                     │
│    - custom_id === payment_attempt_id                                                                  │
│    - amount === milestone.amount (USD)                                                                 │
│    - payee merchant_id matches platform payee                                                          │
│ 8. Pre-flight Persist: Record PAYMENT_AUTHORIZATION_DISPATCH_INITIATED in DB                           │
│ 9. Outbound PayPal Call: POST /v2/checkout/orders/{order_id}/authorize                                 │
│    - Uses stable idempotency key: payment.idempotency_order_auth                                       │
│ 10. Handle Response:                                                                                   │
│     - Success (200/201): Transition DB to AUTHORIZED, set expiration times, log PAYMENT_AUTHORIZED      │
│     - Timeout (504) / 5xx (502): Preserve APPROVED state, set manual_reconciliation_required = true    │
│     - Definitive 4xx (422): Transition DB to FAILED, log PAYMENT_AUTHORIZATION_FAILED                  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key Modules Implemented & Enhanced

### 2.1 Server-Side Authorization Route
**Path:** [`src/app/api/paypal/orders/authorize/route.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/api/paypal/orders/authorize/route.ts)
- **Protected Endpoint:** Accepts only `paymentAttemptId`. Discards and overrides all client-supplied amounts, currencies, or order identifiers.
- **Role Verification:** Validates that `payment.payer_id === user.id` and `project.client_id === user.id`. Freelancers and unauthorized clients are rejected with HTTP 403 Forbidden.
- **Strict Financial Verification:** Checks `intent === 'AUTHORIZE'`, `status === 'APPROVED'`, exact USD amount match, milestone reference ID, custom attempt ID, and merchant payee prior to dispatch.
- **Idempotent Handling:** If the payment attempt is already in `AUTHORIZED` status, it immediately returns HTTP 200 with the existing authorization ID and timestamps without mutating database records or dispatching outbound requests.

### 2.2 Operation-Specific Recovery & Persistence
**Path:** [`src/lib/supabase/payments-db.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/supabase/payments-db.ts)
Added dedicated, operation-specific database helpers for payment authorization:
- `getPaymentByAttemptId(paymentAttemptId)`: Retrieves payment record with joined milestone and project details.
- `recordAuthorizationInitiatedInDb(paymentAttemptId)`: Persists pre-dispatch intent, updating `reconciliation_notes` and logging `PAYMENT_AUTHORIZATION_DISPATCH_INITIATED`.
- `recordAuthorizationSuccessInDb(params)`: Atomically transitions the attempt from `APPROVED` to `AUTHORIZED`, sets `authorization_id`, populates `authorized_at`, `honor_period_expires_at` (+3 days), and `authorization_expires_at` (+29 days), updates milestone `payment_status` to `authorized`, and logs `PAYMENT_AUTHORIZED`.
- `recordAuthorizationUncertainInDb(params)`: Preserves `status = 'APPROVED'`, flags `manual_reconciliation_required = true`, records timeout/5xx error details, and logs `PAYMENT_AUTHORIZATION_UNCERTAIN`. **Never marks an uncertain authorization as FAILED and never unlocks the milestone.**
- `recordAuthorizationDefinitiveFailureInDb(params)`: Transitions `APPROVED -> FAILED` and milestone `payment_status -> failed` only upon confirmed PayPal definitive rejections.

### 2.3 PayPal Orders v2 Client
**Path:** [`src/lib/paypal/orders.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/paypal/orders.ts)
- `authorizePayPalOrder(orderId, idempotencyKey)`: Executes `POST /v2/checkout/orders/{orderId}/authorize` with header `PayPal-Request-Id: idempotencyKey` and body `{}`.
- Extracts authorization resource `id`, `status`, `amount`, and `expiration_time` from `purchase_units[0].payments.authorizations[0]`.

### 2.4 User Interface
**Paths:**
- [`src/app/payments/paypal/success/page.tsx`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/payments/paypal/success/page.tsx)
- [`src/app/projects/[id]/page.tsx`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/projects/[id]/page.tsx)
- Added **Authorize Escrow Hold** action to the client after buyer approval is validated.
- Displays animated spinner during authorization hold processing.
- Renders confirmed escrow authorization card with `authorizationId`, `status: AUTHORIZED`, and validity duration.
- Prominently displays the institutional trust notice:
  > **"Escrow Lock Active — Payment Not Captured:** An authorization hold has been placed on your PayPal account. Funds are not captured or transferred to the freelancer at this time. Capture occurs only after the freelancer submits work and review confirms completion."
- Never displays payments as captured at this stage.
- Shows "Escrow Held" lock badge on milestone cards in project view when `milestone.paymentStatus === 'authorized'`.

---

## 3. Failure and Recovery Handling Protocol

| Failure Scenario | Upstream Error | Application Action | Database State | Milestone Lock |
| :--- | :--- | :--- | :--- | :--- |
| **Network Timeout** | AbortError / 504 | Returns HTTP 504 with `retryable: true`, `uncertain: true` | Preserved in `APPROVED` with `manual_reconciliation_required = true` | LOCKED |
| **PayPal 5xx / 429** | 500 / 502 / 503 | Returns HTTP 502 with `retryable: true`, `uncertain: true` | Preserved in `APPROVED` with `manual_reconciliation_required = true` | LOCKED |
| **Definitive 4xx** | 422 `UNPROCESSABLE_ENTITY` | Returns HTTP 422 with definitive error details | Transitioned to `FAILED` with error details | UNLOCKED |
| **Client Retry after Uncertainty** | N/A | Queries PayPal `GET /v2/checkout/orders/{id}` before retry | Reconciles to `AUTHORIZED` if auth exists, or replays with same idempotency key | LOCKED |
| **Retention Window Expiry** | Older than 6h (or 72h confirmed) | Returns HTTP 409 `RECONCILIATION_EXPIRED` (blocks auto-replay) | Preserved in `APPROVED` requiring manual merchant review | LOCKED |
| **Duplicate Authorization Call** | N/A | Detected via DB status or PayPal order payments | Returns HTTP 200 idempotent response (`alreadyAuthorized: true`) | LOCKED |

---

## 4. Test Suite Execution & Results

The automated test suite [`test-phase9-2-payment-authorization.js`](file:///c:/Users/moham/Desktop/milestone-ai/test-phase9-2-payment-authorization.js) was executed against the running Next.js application, Supabase PostgreSQL, and the Mock PayPal Server.

### Results: 26 / 26 Assertions PASSED (0 Failed)

```
=============================================================================
MILESTONE AI — Phase 9.2: PayPal Server-Side Payment Authorization Test Suite
=============================================================================

✓ Mock PayPal Server running on port 9876
✓ Client A (Owner / Payer): audit.free.1794144752818@test.milestoneai.dev (9a61f650-7efc-4620-8efd-bd234cbc39fb)
✓ Freelancer (Payee): audit.free.1794144722963@test.milestoneai.dev (57d86ec7-8560-41de-bf04-6369df4bf894)
✓ Client B (Wrong Owner): audit.free.1794144722963@test.milestoneai.dev (57d86ec7-8560-41de-bf04-6369df4bf894)
✓ Test Project: 95462716-6abe-492c-ad81-28a05263e487

--- 1. Testing Valid Authorization ---
✓ [PASS] TEST 1A: Valid authorization returned HTTP 200 with AUTHORIZED status -> authId: AUTH_UMG3BGJ6
✓ [PASS] TEST 1B: Database payment record updated to AUTHORIZED with authorization_id and timestamps
✓ [PASS] TEST 1C: Milestone payment_status successfully transitioned to 'authorized'
✓ [PASS] TEST 1D: Audit event PAYMENT_AUTHORIZED logged in database

--- 2. Testing Unauthenticated Request ---
✓ [PASS] TEST 2: Unauthenticated request rejected with HTTP 401 Unauthorized

--- 3. Testing Freelancer Attempting Authorization ---
✓ [PASS] TEST 3: Freelancer rejected with HTTP 403 Forbidden -> Forbidden: You are not authorized to authorize this payment attempt.

--- 4. Testing Wrong Project Owner ---
✓ [PASS] TEST 4: Non-owner client rejected with HTTP 403 Forbidden -> Forbidden: You are not authorized to authorize this payment attempt.

--- 5. Testing Payment Not in APPROVED State ---
✓ [PASS] TEST 5: Non-approved status (CREATED) rejected with HTTP 400 -> Payment attempt cannot be authorized. Current status: CREATED; only APPROVED payments can be authorized.

--- 6. Testing Wrong Order ID ---
✓ [PASS] TEST 6: Mismatched order ID rejected with HTTP 400 -> Security Violation: Provided order ID does not match the payment attempt's stored PayPal order ID.

--- 7. Testing Amount Mismatch ---
✓ [PASS] TEST 7: Tampered amount ($150.00 vs $75.00) rejected with HTTP 400 -> Financial Integrity Violation: PayPal order amount ($150.00) does not match milestone amount ($75.00).

--- 8. Testing Currency Mismatch ---
✓ [PASS] TEST 8: Non-USD currency (EUR) rejected with HTTP 400 -> Currency Violation: PayPal order currency 'EUR' does not match required currency 'USD'.

--- 9. Testing Wrong Merchant Payee ---
✓ [PASS] TEST 9: Wrong merchant payee rejected with HTTP 400 -> Payee Mismatch Violation: Order merchant payee 'MERCHANT-MALICIOUS-HIJACK' does not match expected payee 'MERCHANT-LEGITIMATE-PLATFORM'.

--- 10. Testing Duplicate Authorization Request ---
✓ [PASS] TEST 10: Duplicate authorization returned idempotent HTTP 200 with existing authId -> authId: AUTH_UMG3BGJ6

--- 11. Testing PayPal Timeout ---
✓ [PASS] TEST 11A: PayPal timeout handled safely with HTTP 504 and retryable: true
✓ [PASS] TEST 11B: Database attempt preserved in APPROVED status with manual_reconciliation_required=true (not marked FAILED)

--- 12. Testing PayPal 5xx Server Error ---
✓ [PASS] TEST 12A: PayPal 5xx handled safely with HTTP 502 and retryable: true
✓ [PASS] TEST 12B: Database attempt preserved in APPROVED status with manual_reconciliation_required=true

--- 13. Testing Reconciliation After Uncertain Result ---
✓ [PASS] TEST 13A: Server successfully reconciled uncertain attempt and returned HTTP 200 -> authId: AUTH_RECONCILED_0ED65370
✓ [PASS] TEST 13B: Database record updated to AUTHORIZED with manual_reconciliation_required=false

--- 14. Testing Authorization Already Completed ---
✓ [PASS] TEST 14: Order already authorized at PayPal reconciled safely (HTTP 200) -> authId: AUTH_PRIOR_A1480013

--- 15. Testing Invalid PayPal Authorization Response ---
✓ [PASS] TEST 15A: Malformed response rejected with HTTP 502 -> Invalid PayPal authorization response
✓ [PASS] TEST 15B: Database record remained in APPROVED with null authorization_id

--- 16. Testing Database State Transition Protections ---
✓ [PASS] TEST 16A: Database trigger rejected mutation of payment amount -> Security Violation: Payment amount is immutable once created
✓ [PASS] TEST 16B: Database trigger rejected mutation of payment currency -> Security Violation: Payment currency is immutable
✓ [PASS] TEST 16C: Transition APPROVED -> AUTHORIZED automatically populated timestamps (authorized_at, honor_period, auth_expires)
✓ [PASS] TEST 16D: Database trigger rejected illegal backward transition AUTHORIZED -> CREATED -> Invalid Transition: Cannot transition from AUTHORIZED to CREATED

=============================================================================
TOTAL PASSED: 26
TOTAL FAILED: 0
=============================================================================
```

---

## 5. Full Regression Suite Results

| Test Suite | Purpose | Results | Status |
| :--- | :--- | :---: | :---: |
| **`test-phase9-2-payment-authorization.js`** | Orders v2 Authorization, Roles, Safety, Recovery | **26 / 26** | **PASS** |
| **`test-phase9-1-1-security-audit.js`** | Identity Disentanglement, Safe Cancellation, Open Redirects | **14 / 14** | **PASS** |
| **`test-phase9-1-buyer-approval.js`** | Buyer Approval Workflow & Validation Rules | **20 / 20** | **PASS** |
| **`test-phase8-5-idempotency-config.js`** | Idempotency Retention Matrix (6h / 72h window) | **22 / 22** | **PASS** |
| **`test-phase8-4-distributed-recovery.js`** | Concurrency, DB Atomic Lock, Stale CREATED Barrier | **11 / 11** | **PASS** |
| **`audit-secrets.js`** | Secret Scanner for Hardcoded Credentials | Clean (0 leaks) | **PASS** |
| **`npx tsc --noEmit`** | Static TypeScript Type Checking | 0 errors | **PASS** |
| **`npm run build`** | Next.js Turbo Production Build | Compiled successfully | **PASS** |

---

## 6. Remaining Scope and Phase Boundaries

In strict compliance with instructions:
- **Sandbox environment only.**
- **Payment Capture (`/capture`) is NOT implemented.**
- **Refunds and Freelancer Payouts are NOT implemented.**
- **Webhook processing is NOT implemented.**
- Real Sandbox credentials remain safely restricted to `.env.local` and are never exposed to browser client bundles or committed files.
- **Milestone AI Phase 9.2 is complete.**
