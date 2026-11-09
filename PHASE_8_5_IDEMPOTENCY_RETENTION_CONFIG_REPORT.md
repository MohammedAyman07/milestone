# MILESTONE AI — Phase 8.5: PayPal Idempotency Retention Configuration Report

**Date:** 2026-11-08  
**Status:** COMPLETE (All 22 Configuration & Recovery Tests Passed, 11/11 Regression Tests Passed)  
**Scope:** PayPal Orders v2 Idempotency Retention Window Configuration, Safety Guardrails, Expired Attempt Protection, Regression Verification, and Build Validation.

---

## 1. Executive Summary

In Phase 8.4, idempotency retention was initially implemented with a static 72-hour constant based on PayPal's maximum architectural retention window. However, PayPal's Orders v2 specification dictates:
- **Default Retention Window:** PayPal retains idempotency keys (`PayPal-Request-Id`) for **6 hours (21,600 seconds)** across standard developer and merchant accounts.
- **Extended Retention Window:** Retention up to **72 hours** is **not standard** and requires explicit contract agreement and technical enablement by a **PayPal Account Manager** or **Partner Solutions Engineer**.
- **Financial Risk:** If an application assumes 72 hours and replays an uncertain request after hour 6 (e.g. at hour 12), PayPal has already purged the idempotency key and treats the replay as a **brand-new transaction**, creating duplicate orders and authorizations.

**Phase 8.5 resolves this architectural risk:**
1. **Zero Assumption Policy:** The system defaults strictly to **6 hours** (`DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 6`).
2. **Server-Only Configurable Retention:** Added server-only environment variables `PAYPAL_IDEMPOTENCY_RETENTION_HOURS` and `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED`.
3. **Automatic Safety Clamping:** If `PAYPAL_IDEMPOTENCY_RETENTION_HOURS` is set higher than 6 hours without `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true`, the runtime logs a warning and **automatically clamps retention to 6 hours**.
4. **Hard Ceiling (72 Hours):** Even when confirmed, the retention window cannot exceed PayPal's documented 72-hour platform limit.
5. **Strict Non-Replay of Expired Attempts:** Uncertain attempts exceeding the active window are permanently blocked from automated replay (HTTP 409 `RECONCILIATION_EXPIRED`). Zero network calls are dispatched to PayPal, the database record remains safely frozen in `CREATED` status with `manual_reconciliation_required = true`, and an audit event is persisted.
6. **Verification & Cleanliness:** 22/22 Phase 8.5 configuration tests passed, 11/11 Phase 8.4 regression tests passed, TypeScript compiled with zero errors, zero secrets exposed, and Next.js production build succeeded.

---

## 2. Configuration Architecture & Implementation

### 2.1 Configuration Resolver: [`src/lib/paypal/orders.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/lib/paypal/orders.ts)

The configuration resolver inspects server-only environment variables and returns typed configuration metadata:

```typescript
export const DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 6;
export const MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 72;

export interface PayPalRetentionConfig {
  retentionHours: number;
  retentionMs: number;
  isExtendedConfirmed: boolean;
  source: "default" | "configured_standard" | "configured_extended" | "fallback_unconfirmed";
}

export function getPayPalIdempotencyRetentionConfig(): PayPalRetentionConfig {
  const confirmedRaw = (process.env.PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED || "").trim().toLowerCase();
  const isExtendedConfirmed = confirmedRaw === "true" || confirmedRaw === "1" || confirmedRaw === "yes";

  const envHoursRaw = process.env.PAYPAL_IDEMPOTENCY_RETENTION_HOURS?.trim();

  // If not explicitly set:
  if (!envHoursRaw) {
    if (isExtendedConfirmed) {
      return {
        retentionHours: MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
        retentionMs: MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
        isExtendedConfirmed: true,
        source: "configured_extended",
      };
    }
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed: false,
      source: "default",
    };
  }

  const parsedHours = parseFloat(envHoursRaw);
  if (isNaN(parsedHours) || parsedHours <= 0) {
    console.warn(
      `[PayPal Config Warning] Invalid PAYPAL_IDEMPOTENCY_RETENTION_HOURS "${envHoursRaw}". Defaulting safely to ${DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS}h.`
    );
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed,
      source: "default",
    };
  }

  // Safety Clamping: if > 6h requested but not confirmed by account manager
  if (parsedHours > DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS && !isExtendedConfirmed) {
    console.warn(
      `[PayPal Config Warning] PAYPAL_IDEMPOTENCY_RETENTION_HOURS is set to ${parsedHours}h (> 6h), ` +
      `but PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED is not 'true'. ` +
      `PayPal default retention is 6 hours; accounts require explicit Account Manager approval for extensions up to 72 hours. ` +
      `Clamping safely to ${DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS}h to prevent duplicate charges upon replay.`
    );
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed: false,
      source: "fallback_unconfirmed",
    };
  }

  // Clamped to platform ceiling (72h)
  const finalHours = Math.min(parsedHours, MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS);
  return {
    retentionHours: finalHours,
    retentionMs: finalHours * 60 * 60 * 1000,
    isExtendedConfirmed,
    source: finalHours > DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS ? "configured_extended" : "configured_standard",
  };
}
```

---

### 2.2 Dynamic Expiry Check: [`src/app/api/paypal/orders/route.ts`](file:///c:/Users/moham/Desktop/milestone-ai/src/app/api/paypal/orders/route.ts)

When an uncertain attempt is evaluated during order creation reconciliation:

```typescript
// Check PayPal Idempotency Retention Window (Default: 6h; Extended: up to 72h with confirmed account)
const retentionConfig = getPayPalIdempotencyRetentionConfig();
const attemptCreatedAt = uncertain.createdAt ? new Date(uncertain.createdAt).getTime() : 0;
const attemptAgeMs = Date.now() - attemptCreatedAt;

if (attemptCreatedAt > 0 && attemptAgeMs > retentionConfig.retentionMs) {
  // RETENTION EXPIRED: Do NOT blindly replay!
  // PayPal purges idempotency keys after the retention window; replaying risks creating duplicate charges.
  await recordAuditLogInDb({
    actorId: user.id,
    projectId: milestone.projectId,
    milestoneId: milestone.id,
    action: "PAYPAL_ORDER_RECONCILIATION_EXPIRED",
    entityType: "payment",
    entityId: uncertain.id,
    newState: {
      paymentAttemptId: uncertain.paymentAttemptId,
      attemptAgeHours: (attemptAgeMs / (3600 * 1000)).toFixed(1),
      retentionLimitHours: retentionConfig.retentionHours,
      extendedConfirmed: retentionConfig.isExtendedConfirmed,
      configSource: retentionConfig.source,
      reason: "PayPal idempotency retention window expired; automated replay blocked to prevent duplicate orders.",
    },
  });

  return NextResponse.json(
    {
      success: false,
      outcome: "RECONCILIATION_EXPIRED",
      reconciliationPending: true,
      error: `The PayPal idempotency retention window (${retentionConfig.retentionHours} hours) for this uncertain attempt has expired (${(attemptAgeMs / (3600 * 1000)).toFixed(1)}h elapsed). Automated replay is disabled to prevent duplicate charges. Manual merchant reconciliation is required.`,
      paymentAttemptId: uncertain.paymentAttemptId,
      retentionLimitHours: retentionConfig.retentionHours,
      isExtendedConfirmed: retentionConfig.isExtendedConfirmed,
    },
    { status: 409 }
  );
}
```

---

### 2.3 Documentation & Setup Guide Updates

1. **[`PAYPAL_SANDBOX_SETUP.md`](file:///c:/Users/moham/Desktop/milestone-ai/PAYPAL_SANDBOX_SETUP.md):**
   - Added `PAYPAL_IDEMPOTENCY_RETENTION_HOURS=6` and `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=false` to Section 3.5.
   - Added **Section 6: PayPal Orders v2 Idempotency Retention & Account-Level Confirmation**:
     - Explains the 6-hour default policy vs. 72-hour extension.
     - Details the duplicate transaction hazard upon replay after key purge.
     - Documents the exact procedure for obtaining approval from a PayPal Account Manager or Partner Solutions Engineer before setting `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true`.

2. **[`.env.example`](file:///c:/Users/moham/Desktop/milestone-ai/.env.example):**
   - Added explicit configuration entries with cautionary commentary:
     ```bash
     # PayPal Orders v2 Idempotency Retention (Strict Server-Side Only)
     # Default is 6 hours per standard PayPal Orders v2 specification.
     # Extended retention (up to 72 hours) requires contractual enablement by a PayPal Account Manager.
     # Do NOT set PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true unless confirmed by PayPal.
     PAYPAL_IDEMPOTENCY_RETENTION_HOURS=6
     PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=false
     ```

---

## 3. Test Suite Verification & Results

### 3.1 Phase 8.5 Test Suite: [`test-phase8-5-idempotency-config.js`](file:///c:/Users/moham/Desktop/milestone-ai/test-phase8-5-idempotency-config.js)

The test suite covers:
1. **Pure Unit Resolution Matrix (9 checks):**
   - Default environment -> 6h unconfirmed (`default`).
   - Standard configured <= 6h (e.g. 3h) -> accepted (`configured_standard`).
   - Unconfirmed 72h -> safely clamped to 6h (`fallback_unconfirmed`).
   - Unconfirmed 24h -> safely clamped to 6h (`fallback_unconfirmed`).
   - Confirmed 72h -> 72h granted (`configured_extended`).
   - Confirmed flag alone -> 72h granted (`configured_extended`).
   - Confirmed custom hours (e.g. 36h) -> 36h granted (`configured_extended`).
   - Requested 120h -> clamped to 72h platform ceiling.
   - Negative / NaN / invalid input -> safely defaulted to 6h.

2. **Live HTTP Server & Database Tests (13 checks across 3 configurations):**
   - **Config A (Default 6-Hour Policy):**
     - Uncertain attempt at 8 hours -> HTTP 409 `RECONCILIATION_EXPIRED` (`retentionLimitHours: 6`).
     - Confirmed zero outgoing calls to PayPal.
     - Database record preserved in `status = CREATED`, `manual_reconciliation_required = true`, `order_id = null`.
     - Audit log `PAYPAL_ORDER_RECONCILIATION_EXPIRED` persisted with `retentionLimitHours: 6`.
     - Uncertain attempt at 2 hours (< 6h) -> successfully replayed and reconciled (HTTP 200) with original idempotency key reused.
   - **Config B (Unconfirmed 72-Hour Setting):**
     - Uncertain attempt at 8 hours -> safely clamped to 6h and rejected with HTTP 409 `RECONCILIATION_EXPIRED` (`retentionLimitHours: 6`, `isExtendedConfirmed: false`).
     - Confirmed zero outgoing calls to PayPal.
   - **Config C (Confirmed 72-Hour Extension):**
     - Uncertain attempt at 8 hours (< 72h) -> permitted and successfully reconciled (HTTP 200) with original idempotency key.
     - Uncertain attempt at 75 hours (> 72h ceiling) -> rejected with HTTP 409 `RECONCILIATION_EXPIRED` (`retentionLimitHours: 72`).
     - Confirmed zero outgoing calls to PayPal for 75h attempt.
     - Database record preserved in `status = CREATED` with `manual_reconciliation_required = true`.

**Execution Output:**
```
=============================================================================
MILESTONE AI — Phase 8.5: PayPal Idempotency Retention Configuration Tests
=============================================================================

--- 1. Testing Idempotency Retention Configuration Matrix ---
✓ [PASS] TEST 1.1: Default configuration resolves strictly to 6 hours (unconfirmed)
✓ [PASS] TEST 1.2: Explicit standard retention (3 hours) accepted without extended confirmation
✓ [PASS] TEST 1.3: Requested 72 hours without confirmation safely clamped/fallback to 6 hours
✓ [PASS] TEST 1.4: Requested 24 hours without confirmation safely clamped to 6 hours
✓ [PASS] TEST 1.5: Confirmed 72-hour extension granted when PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true
✓ [PASS] TEST 1.6: Confirmed flag alone resolves to 72 hours
✓ [PASS] TEST 1.7: Confirmed custom hours (36 hours) resolved accurately
✓ [PASS] TEST 1.8: Hours exceeding platform limit (120h) clamped to maximum 72 hours
✓ [PASS] TEST 1.9: Invalid/negative/NaN inputs fallback safely to 6 hours

--- 2. Setting Up Test Fixtures for API & Database Testing ---
✓ Mock PayPal Server running on port 9876
✓ Authenticated test client user: freelancer-test@milestoneai.dev (usr_freelancer_9a61***)
✓ Test project resolved: a4fa3ccf-ce87-4848-aaea-9cddd196a083

=== CONFIG A: Default 6-Hour Window (Unconfirmed) ===
--- 2A.1. Testing Default 6-Hour Policy: Attempt at 8h Expired ---
✓ [PASS] TEST 2A.1: Attempt older than 6 hours (8h) rejected with HTTP 409 RECONCILIATION_EXPIRED -> The PayPal idempotency retention window (6 hours) for this uncertain attempt has expired (8.0h elapsed). Automated replay is disabled to prevent duplicate charges. Manual merchant reconciliation is required.
✓ [PASS] TEST 2A.2: Zero PayPal calls dispatched for expired 8h attempt (safe blocking)
✓ [PASS] TEST 2A.3: Database record preserved in CREATED with manual_reconciliation_required=true
✓ [PASS] TEST 2A.4: Audit event PAYPAL_ORDER_RECONCILIATION_EXPIRED recorded with retentionLimitHours=6
--- 2A.5. Testing Default 6-Hour Policy: Attempt at 2h (< 6h) Reconciles ---
✓ [PASS] TEST 2A.5: Attempt within 6h window (2h) successfully reconciled via idempotent replay (HTTP 200)
✓ [PASS] TEST 2A.6: Verified original idempotency key reused during reconciliation replay -> ord_create_att_valid2h_9fcc7da34be24de6aba326a811dfde2d

=== CONFIG B: Unconfirmed 72-Hour Setting (Safety Fallback to 6h) ===
--- 2B.1. Testing Unconfirmed 72h: Attempt at 8h Must Be Rejected by 6h Fallback ---
✓ [PASS] TEST 2B.1: Server clamped unconfirmed 72h to 6h limit and rejected 8h attempt (HTTP 409 RECONCILIATION_EXPIRED)
✓ [PASS] TEST 2B.2: Zero calls dispatched to PayPal on unconfirmed fallback rejection

=== CONFIG C: Confirmed 72-Hour Extension Enabled ===
--- 2C.1. Testing Confirmed 72h: Attempt at 8h (< 72h) Successfully Reconciles ---
✓ [PASS] TEST 2C.1: Confirmed 72h configuration permits reconciliation replay at 8 hours (HTTP 200)
✓ [PASS] TEST 2C.2: Verified original idempotency key reused under confirmed 72h extension -> ord_create_att_conf8h_4668ed57eb4b4421af6e7b3a1b5c689f
--- 2C.3. Testing Confirmed 72h: Attempt at 75h (> 72h Ceiling) Expired ---
✓ [PASS] TEST 2C.3: Attempt past 72h (75h) rejected with HTTP 409 RECONCILIATION_EXPIRED (ceiling enforced)
✓ [PASS] TEST 2C.4: Confirmed ZERO outgoing PayPal calls dispatched for 75h expired attempt
✓ [PASS] TEST 2C.5: Database record remains in CREATED with manual_reconciliation_required=true after 75h expiry
✓ Mock PayPal Server stopped.
--- Cleaning up temporary test fixtures ---
✓ Baseline database state restored.
✓ Clean .env.local restored to safe baseline.

=============================================================================
TOTAL PASSED: 22
TOTAL FAILED: 0
=============================================================================
```

---

### 3.2 Phase 8.4 Regression Suite: [`test-phase8-4-distributed-recovery.js`](file:///c:/Users/moham/Desktop/milestone-ai/test-phase8-4-distributed-recovery.js)

Updated to run against the 6-hour baseline and verified full regression compatibility:
- Database-level unique constraint (`uq_active_milestone_payment_attempt`) permits exactly 1 row.
- Multi-process concurrent API requests safely handled (one 201 Created, one 409 Conflict).
- Attempt older than retention window rejected with HTTP 409 `RECONCILIATION_EXPIRED` (zero PayPal calls).
- Replay within active retention window reconciles with original idempotency key reused.
- Request body tampering during recovery is completely ignored in favor of immutable database amount ($75.00 USD).
- Stale CREATED attempt acts as a permanent barrier preventing second payment attempts.

**Execution Output:**
```
=============================================================================
TOTAL PASSED: 11
TOTAL FAILED: 0
=============================================================================
```

---

### 3.3 Security & Secret Audit: [`audit-secrets.js`](file:///c:/Users/moham/Desktop/milestone-ai/audit-secrets.js)

```
Scanning for exposure of sensitive variables: [ 'GEMINI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY' ]
✓ PASS: Zero hardcoded secrets found in tracked application files.
```

---

### 3.4 TypeScript & Production Build Verification

```
> npx tsc --noEmit
(Exited 0 with zero type errors)

> npm run build
▲ Next.js 16.4.5 (Turbopack)
✓ Compiled successfully in 798ms
  Running TypeScript ...
  Finished TypeScript in 2.6s ...
✓ Generating static pages using 7 workers (19/19) in 748ms
✓ Build finalized successfully
```

---

## 4. Phase Verification Matrix

| Check | Requirement | Result | Evidence / Details |
|---|---|---|---|
| **1** | Do not assume 72-hour extension | **PASS** | `DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 6` enforced when unconfirmed. |
| **2** | Server-only configurable retention duration | **PASS** | Evaluated via `PAYPAL_IDEMPOTENCY_RETENTION_HOURS` & `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED`. |
| **3** | Safe default to 6 hours unless extension confirmed | **PASS** | Clamping logic tested; setting 72h without confirmation falls back to 6h. |
| **4** | Automated tests for 6h and confirmed 72h | **PASS** | `test-phase8-5-idempotency-config.js` passed 22/22 tests covering both configs. |
| **5** | Zero automated replay of expired uncertain requests | **PASS** | HTTP 409 `RECONCILIATION_EXPIRED`, zero PayPal calls, DB record remains in `CREATED`. |
| **6** | Document account-level confirmation requirement | **PASS** | Added to `PAYPAL_SANDBOX_SETUP.md` (Section 6) and `.env.example`. |
| **7** | Regression test suite | **PASS** | `test-phase8-4-distributed-recovery.js` passed 11/11 tests cleanly. |
| **8** | TypeScript compilation | **PASS** | `npx tsc --noEmit` exited 0 with no errors. |
| **9** | Production build | **PASS** | `npm run build` compiled all 19 application routes cleanly. |
| **10** | Secret leak prevention | **PASS** | `audit-secrets.js` confirmed zero hardcoded secrets; `.env.local` clean. |

---

## 5. Next Steps

With Phase 8.5 complete, the server-side order creation and uncertain recovery architecture has complete financial integrity and adheres strictly to documented PayPal partner policies.

Per project guidelines:
- Buyer approval, payment authorization, capture, refunds, and payouts remain strictly deferred until subsequent phases.
- No real credentials were used or exposed.
- All testing was performed using the isolated local mock server and Supabase test fixtures.
