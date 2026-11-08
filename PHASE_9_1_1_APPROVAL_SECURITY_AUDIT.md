# MILESTONE AI — Phase 9.1.1: Buyer Approval Security Audit Report

**Date:** 2026-11-08  
**Environment:** PayPal Sandbox / Localhost Development  
**Status:** COMPLETE (All Hardening Implemented, 14/14 Security Audit Tests Passing, Full Regression Passing)

---

## Executive Summary

Phase 9.1.1 performed a comprehensive security and reliability audit of the PayPal Sandbox Buyer Approval workflow implemented in Phase 9.1. The audit identified and resolved four critical vulnerability vectors before any authorization, capture, or payout capabilities are introduced:

1. **Identity Conflation Elimination:** Completely disentangled the internal Supabase User UUID (`user.id` / `payment.payer_id`) from PayPal's external alphanumeric customer account identifier (`paypalOrder.payer.payer_id` / `payment.paypal_payer_id`). Eliminated dangerous direct comparisons and rejected all untrusted client-supplied `payerId` parameters.
2. **Cancellation and Duplicate-Order Vulnerability Elimination:** Resolved an unsafe cancellation flaw where client-reported cancellations could prematurely mark local database payment records as `VOIDED` while the PayPal order remained active and approvable (`CREATED`) at PayPal. Under the hardened architecture, payment attempts are only transitioned to `VOIDED` if PayPal definitively confirms the order is expired, voided, or non-existent. Otherwise, the attempt remains locked in `CREATED` with `manual_reconciliation_required = true`, preventing duplicate active attempts and protecting escrow milestone integrity.
3. **Host Header Injection and Open Redirect Hardening:** Deprecated blind usage of `req.nextUrl.origin` and user-controlled callback query/body parameters. Enforced server-configured canonical origins (`APP_URL` / `NEXT_PUBLIC_APP_URL`) with strict localhost allowlisting for development environments, ensuring redirect URLs strictly target safe application routes.
4. **Late Approval Revocation Defenses & Idempotency:** Enforced database-level terminal transition protections preventing late PayPal approval callbacks from mutating safely voided attempts (HTTP 409 Conflict), while guaranteeing idempotent responses (HTTP 200) for repeated cancellation or approval calls.

---

## 1. PayPal Payer Identity Verification Model

### 1.1 The Vulnerability
In naïve implementations, developers often compare PayPal's `payer_id` with the authenticated session's user ID. This is fundamentally flawed:
- **Supabase Application Identity:** A standard UUIDv4 (e.g., `9a61f650-7efc-4620-8efd-bd234cbc39fb`), representing the registered client account in PostgreSQL.
- **PayPal Financial Identity:** An external alphanumeric merchant/payer identifier assigned by PayPal (e.g., `PAYER-SANDBOX-001` or `J9ABC123XYZ`).

Direct equality comparisons (`supabaseUser.id === paypalOrder.payer.payer_id`) invariably fail or lead developers to introduce unsafe fallbacks (such as accepting `payerId` from the client request body).

### 1.2 The Hardened Architecture Model
Milestone AI enforces strict separation between Application Identity and Financial Identity across the database and API tiers:

| Dimension | Application Identity | Financial Identity |
| :--- | :--- | :--- |
| **Identifier** | Supabase User UUID (`user.id`) | PayPal Payer ID (`payer.payer_id`) |
| **Format** | UUIDv4 (e.g., `9a61f650-...`) | Alphanumeric (e.g., `PAYER-SANDBOX-777`) |
| **Database Column** | `payments.payer_id` | `payments.paypal_payer_id` |
| **Verification Authority** | Supabase JWT & Row-Level Security | PayPal OAuth2 Server-to-Server GET Order |
| **Client Control** | Completely server-derived | Completely server-derived (client params ignored) |

```
Browser (Client User)
  │
  ├── 1. POST /api/paypal/orders/validate-approval { orderId: "..." }
  │      (PayerId from client body is strictly ignored / discarded)
  ▼
Next.js Server
  │
  ├── 2. Authenticate session via Supabase JWT -> user.id (UUID)
  │
  ├── 3. Load Payment Attempt from DB:
  │      - Confirm payment.payer_id === user.id (Client Ownership)
  │      - Confirm client owns the milestone & project (Role Authorization)
  │
  ├── 4. Server-to-Server GET https://api-m.sandbox.paypal.com/v2/checkout/orders/{orderId}
  │
  ├── 5. Extract verified payer:
  │      verifiedPayerId = paypalOrder.payer?.payer_id
  │
  └── 6. Persist to DB:
         payment.paypal_payer_id = verifiedPayerId
         payment.status = 'APPROVED'
```

### 1.3 Concrete Code Hardening
In [`src/app/api/paypal/orders/validate-approval/route.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/api/paypal/orders/validate-approval/route.ts):
- Removed any direct equality check between `user.id` and `payer_id`.
- Removed fallback to `body.payerId`.
- Verified that `user.id === paymentAttempt.payer_id` (Application Identity check).
- Verified that `paypalOrder.payer?.payer_id` exists and stored it in `paymentAttempt.paypal_payer_id` (Financial Identity recording).

---

## 2. Cancellation and Duplicate-Order Safety

### 2.1 The Vulnerability
When a user clicks "Cancel and return to Milestone AI" during PayPal checkout, or cancels from the frontend UI, the browser hits `/api/paypal/orders/cancel`.

In PayPal Orders v2, an unapproved order in the `CREATED` state is **not automatically cancelled or voided by PayPal** upon user redirection. It remains active on PayPal's servers until its 3-hour expiry window lapses.

If the application server unconditionally marked the local payment attempt as `VOIDED`:
1. PostgreSQL unique partial index `uq_active_milestone_payment_attempt` (`WHERE status IN ('CREATED', 'APPROVED', 'AUTHORIZED')`) would release its lock on the milestone.
2. The client could immediately click "Pay with PayPal" again, initiating a second PayPal order.
3. The user could return to their open browser tab from the first order and approve it, resulting in **two active, approvable orders for the same milestone**.

### 2.2 The Hardened Cancellation Policy
The cancellation workflow in [`src/app/api/paypal/orders/cancel/route.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/api/paypal/orders/cancel/route.ts) and [`src/lib/supabase/payments-db.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/supabase/payments-db.ts) now enforces a safe, stateful cancellation protocol:

1. **Server-Side Order Query:** The server queries PayPal via `getPayPalOrder(orderId)` to inspect the true upstream status.
2. **Rejection of Approved Orders:** If PayPal reports the order is already `APPROVED`, cancellation is rejected with **HTTP 409 Conflict** (`Order has already been approved by buyer`).
3. **Handling of Active Orders (`CREATED`):**
   - If the order remains in `CREATED` status on PayPal, the server **REFUSES to transition the local database record to `VOIDED`**.
   - Instead, the attempt is preserved in `CREATED` status with `manual_reconciliation_required = true` and `buyer_cancelled: true` annotated in payment notes.
   - The unique constraint `uq_active_milestone_payment_attempt` remains engaged, preventing duplicate orders. Any new payment requests idempotently resume or require manual resolution.
4. **Definitive Voiding Only Upon True Closure:**
   - Only when PayPal confirms the order is definitively closed (`VOIDED`, `EXPIRED`, or `RESOURCE_NOT_FOUND` / 404) does the server mark the database record `VOIDED` and reset the milestone status to `unauthorized`.
5. **Upstream Network Failures:**
   - If PayPal times out or returns 5xx during cancellation verification, the server returns **HTTP 504 Gateway Timeout** with `retryable: true`. The local attempt is preserved in `CREATED` status without premature voiding.
6. **Late Approval Revocation Defenses:**
   - If an order was definitively `VOIDED`, any subsequent or late approval callback to `/api/paypal/orders/validate-approval` is strictly rejected with **HTTP 409 Conflict** (`Payment attempt is in terminal status VOIDED`), preventing resurrection of closed attempts.
7. **Cancellation Idempotency:**
   - Repeated cancellation calls on an already voided attempt safely return **HTTP 200** with `alreadyVoided: true`.

---

## 3. Callback URL Security & Open Redirect Defenses

### 3.1 Host Header & Open Redirect Risks
Using `req.nextUrl.origin` or headers (`Host`, `X-Forwarded-Host`) directly to generate PayPal callback URLs allows attackers to perform Host Header Injection, tricking the server into generating return URLs pointing to malicious proxy servers. Additionally, allowing clients to pass arbitrary `returnUrl` or `cancelUrl` in request bodies exposes the system to Open Redirect vulnerabilities.

### 3.2 Canonical Origin Resolution
Implemented `getTrustedApplicationOrigin()` and `resolveSafeCallbackUrls()` in [`src/lib/paypal/orders.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/paypal/orders.ts):
- Origin is strictly derived from `process.env.APP_URL` or `process.env.NEXT_PUBLIC_APP_URL`.
- In development/sandbox environments only, if environment variables are unset, it falls back strictly to `http://localhost:3000` (or allowlisted localhost ports).
- Untrusted `Host` and `X-Forwarded-Host` request headers are ignored.
- Return and Cancel URLs are strictly hardcoded to application paths:
  - Return: `<trustedOrigin>/payments/paypal/success`
  - Cancel: `<trustedOrigin>/payments/paypal/cancel`
- Any client-supplied redirect URLs are discarded.

---

## 4. Comprehensive Validation Rules

Every approval verification at `POST /api/paypal/orders/validate-approval` strictly verifies all nine parameters before updating database state:
1. **Order ID Integrity:** Validated format and existence in Supabase database.
2. **Intent Verification:** Confirmed `paypalOrder.intent === 'AUTHORIZE'`. Orders with `CAPTURE` intent are rejected.
3. **Approval Status:** Confirmed `paypalOrder.status === 'APPROVED'`. Unapproved orders (`CREATED`) are rejected.
4. **Purchase Unit Integrity:** Exactly one purchase unit must exist (`purchase_units.length === 1`).
5. **Reference ID Matching:** `purchase_unit.reference_id === milestone.id`.
6. **Custom ID Matching:** `purchase_unit.custom_id === paymentAttempt.id`.
7. **Amount Exact Matching:** `purchase_unit.amount.value` matches milestone cost formatted to 2 decimals.
8. **Currency Integrity:** `purchase_unit.amount.currency_code === 'USD'`.
9. **Merchant Payee Verification:** `purchase_unit.payee.merchant_id` matches expected merchant ID or authorized platform payee.

---

## 5. Security Audit Test Suite Results

The automated test suite `test-phase9-1-1-security-audit.js` was executed against the running application and database. All 14 assertions passed cleanly:

```
=============================================================================
MILESTONE AI — Phase 9.1.1: Buyer Approval Security Audit Test Suite
=============================================================================

--- 1. Testing Identity Verification Model: Supabase UUID vs PayPal Payer ID ---
✓ [PASS] TEST 1A: Server did not fail or miscompare Supabase UUID with PayPal payer ID
✓ [PASS] TEST 1B: Verified database strictly separates Application Identity (payer_id: UUID)
                   and PayPal Financial Identity (paypal_payer_id: PayPal ID)
                   -> payer_id: 9a61f650-7efc-4620-8efd-bd234cbc39fb
                   -> paypal_payer_id: PAYER-SANDBOX-ALPHANUM-999

--- 2. Testing Non-Owner Client Order Validation ---
✓ [PASS] TEST 2: Attempt by another authenticated user rejected with HTTP 403 Forbidden
                  -> Forbidden: You are not authorized to approve this payment attempt.

--- 3. Testing Cancellation Followed by Late PayPal Approval ---
✓ [PASS] TEST 3A: Order successfully closed and voided
✓ [PASS] TEST 3B: Late approval callback rejected with HTTP 409
                  -> Cannot validate approval: Payment attempt is in terminal status VOIDED.
✓ [PASS] TEST 3C: Database state machine verified: record remains locked in terminal VOIDED status

--- 4. Testing Repeated Cancellation Callback ---
✓ [PASS] TEST 4: Repeated cancellation on already voided attempt returned idempotent HTTP 200
                  -> alreadyVoided: true

--- 5. Testing Cancellation When PayPal Order Is Still Usable ---
✓ [PASS] TEST 5A: Server refused to mark attempt VOIDED because PayPal order is still usable;
                   preserved in CREATED status
✓ [PASS] TEST 5B: Database record preserved in CREATED status with manual_reconciliation_required=true
✓ [PASS] TEST 5C: Verified milestone cannot be unlocked while PayPal order is usable;
                   second active attempt rejected by database unique constraint
                   -> duplicate key value violates unique constraint "uq_active_milestone_payment_attempt"

--- 6. Testing Untrusted Host Header Defense ---
✓ [PASS] TEST 6: Untrusted Host header ignored; server strictly used trusted application origin
                  -> http://localhost:3000/payments/paypal/success

--- 7. Testing Untrusted Return URL Defense (Open Redirect) ---
✓ [PASS] TEST 7: Untrusted returnUrl rejected; defaulted safely to http://localhost:3000/payments/paypal/success

--- 8. Testing Duplicate Approval Callback ---
✓ [PASS] TEST 8: Duplicate approval callback returned idempotent HTTP 200 without duplicate mutations
                  -> status: APPROVED

--- 9. Testing Correct PayPal Payer ID with Valid Client Ownership ---
✓ [PASS] TEST 9: Correct PayPal payer ID verified from PayPal API and recorded with client ownership
                  -> payerId: PAYER-SANDBOX-VERIFIED-777

=============================================================================
TOTAL PASSED: 14
TOTAL FAILED: 0
=============================================================================
```

---

## 6. Full Regression Suite Verification

All historical regression suites were executed to ensure zero breaking changes or regressions across distributed concurrency, recovery, and buyer approval flows:

| Test Suite | Focus Area | Assertions Passed | Status |
| :--- | :--- | :--- | :--- |
| **`test-phase9-1-1-security-audit.js`** | Identity, Cancellation Safety, Open Redirects, Late Callbacks | **14 / 14** | **PASS** |
| **`test-phase9-1-buyer-approval.js`** | Buyer Approval Workflow, State Transitions, Tamper Defenses | **20 / 20** | **PASS** |
| **`test-phase8-5-idempotency-config.js`**| 6-Hour Default, Confirmed 72-Hour Expiration Policies | **22 / 22** | **PASS** |
| **`test-phase8-4-distributed-recovery.js`**| Multi-process Concurrency, DB Atomic Lock, Stale CREATED Barrier | **11 / 11** | **PASS** |
| **`audit-secrets.js`** | Secret Leaks & Hardcoded Credential Scanning | Zero exposures found | **PASS** |
| **TypeScript Typecheck (`tsc --noEmit`)** | Static typing & type safety | 0 errors | **PASS** |
| **Production Build (`npm run build`)** | Next.js Turbo production build & route bundling | Compiled successfully | **PASS** |

---

## 7. Next Steps & Phase Boundaries

Per project instructions:
- **Phase 9.1.1 is complete.**
- Payment authorization (`AUTHORIZE`), capture (`CAPTURE`), refunds, and merchant payouts remain strictly un-implemented until scheduled in subsequent phases.
- Real PayPal Sandbox credentials remain secured exclusively in `.env.local` and are never committed or exposed to browser bundles.
