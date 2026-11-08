# MILESTONE AI — Final PayPal Pre-Migration Approval Checklist (Phase 6.3)

**Author**: Antigravity AI Engineering & Security Team  
**Date**: November 8, 2026  
**Status**: AWAITING HUMAN APPROVAL (No migrations run, no live payments executed)  
**Companion Migration**: [`supabase/migrations/20261108030000_paypal_payments_hardening.sql`](file:///c:/Users/moham/Desktop/milestone-ai/supabase/migrations/20261108030000_paypal_payments_hardening.sql)  
**Database Plan**: [`PAYPAL_DATABASE_MIGRATION_PLAN.md`](file:///c:/Users/moham/Desktop/milestone-ai/PAYPAL_DATABASE_MIGRATION_PLAN.md)  
**Implementation Plan**: [`PAYPAL_IMPLEMENTATION_PLAN.md`](file:///c:/Users/moham/Desktop/milestone-ai/PAYPAL_IMPLEMENTATION_PLAN.md)  
**Failure Recovery Plan**: [`PAYPAL_FAILURE_RECOVERY_TEST_PLAN.md`](file:///c:/Users/moham/Desktop/milestone-ai/PAYPAL_FAILURE_RECOVERY_TEST_PLAN.md)  

---

## 1. Pre-Migration Verification Checklist

| Item | Description | Verification Status | Notes |
| :--- | :--- | :--- | :--- |
| **Live Schema Validation** | Verified SQL migration against live database structure | **VERIFIED** | Live audit confirmed 15 columns on `payments`, 17 on `milestones`, zero existing rows. |
| **Index Column Mapping** | Every index references an existing or newly added column | **VERIFIED** | All 11 new columns (`payment_attempt_id`, `order_id`, etc.) added via `ADD COLUMN IF NOT EXISTS` before index definitions. |
| **Constraint Integrity** | Strict lifecycle statuses and MVP currency bounds | **VERIFIED** | Enforces 11 status states; initial MVP currency restricted strictly to `USD`. |
| **Trigger Logic** | PostgreSQL state transition enforcement | **VERIFIED** | Prohibits re-capture of settled/voided payments; automatically computes 3-day honor & 29-day expiry timestamps. |
| **Trust Boundary Enforcement** | Server-side API validates PayPal; DB enforces invariants | **VERIFIED** | Database triggers do not perform network calls; all external responses validated server-side. |
| **RLS & Role Scoping** | Browser cannot directly mutate payments or webhooks | **VERIFIED** | `public.payments` mutations restricted to service role; `paypal_webhook_events` restricted strictly to `service_role`. |
| **Rollback Verification** | Reversible migration without breaking base schema | **VERIFIED** | Complete, clean rollback script provided in Section 5.2 of `PAYPAL_DATABASE_MIGRATION_PLAN.md`. |
| **Webhook Deduplication** | Idempotent webhook delivery tracking | **VERIFIED** | Table `paypal_webhook_events` enforces `UNIQUE(transmission_id)`. |

---

## 2. Correct Authorization Expiry & Honor Period Handling

### 2.1 The Two Expiry Windows
1. **3-Day Honor Period (`honor_period_expires_at = authorized_at + interval '3 days'`)**:
   - PayPal guarantees the authorized funds for the first 3 business days following authorization.
   - Captures executed within this 3-day window enjoy 100% funds availability guarantee.
2. **29-Day Maximum Validity (`authorization_expires_at = authorized_at + interval '29 days'`)**:
   - Authorizations remain technically valid and capturable on PayPal for up to 29 calendar days.
   - Captures between Day 4 and Day 29 can still succeed if buyer funds remain sufficient, but are no longer guaranteed against buyer insufficient funds.

### 2.2 System Invariant: Never Auto-Expire on Day Four
- **Critical Policy**: The system **never** automatically marks an authorization `EXPIRED` on Day 4.
- The authorization remains in status `AUTHORIZED` through Day 29.
- A payment is only transitioned to `EXPIRED` when:
  1. The 29-day validity window elapses without capture, OR
  2. PayPal explicitly returns HTTP 422 `AUTHORIZATION_EXPIRED` upon a capture attempt.

---

## 3. Strengthened Uncertain Capture Recovery Protocol

```
[Capture Request Dispatched] (with PayPal-Request-Id: idempotency_auth_capture)
        │
        ▼
   [Network Timeout / Connection Failure / 5xx Error]
        │
        ▼
[DO NOT RETRY SOLELY BECAUSE AUTHORIZATION IS 'AUTHORIZED']
        │
        ▼
[Query PayPal: GET /v2/payments/authorizations/{authorization_id}]
        │
        ├─── Step A: Inspect 'payments.captures' Array in Response
        │      │
        │      ├── Capture Exists for this Request?
        │      │     ├─ Yes & status == 'COMPLETED' ──► Reconcile and advance DB to 'CAPTURED'
        │      │     └─ Yes & status == 'PENDING'   ──► Record 'CAPTURE_PENDING'
        │      │
        │      └── No Capture Found in Array?
        │            │
        │            ▼
        │     Step B: Re-verify Authorization Status
        │            │
        │            ├── If 'AUTHORIZED' AND captures array is empty:
        │            │     └─ Safe to retry capture with SAME idempotency_auth_capture key
        │            │
        │            └── If 'VOIDED' or 'EXPIRED':
        │                  └─ Advance DB to 'VOIDED' or 'EXPIRED'
        │
        └─── Step C: PayPal API Unreachable After 3 Verification Retries
               │
               ▼
        [Retain 'CAPTURE_PENDING']
        [Set manual_reconciliation_required = true]
        [Log Ambiguous Capture Event in audit_logs for Human Review]
```

---

## 4. Payment Recipient Documentation & Visible Demo Limitation

### 4.1 Payment Recipient Identification
- **Merchant / Payee**:
  On every PayPal order, the payee is the **Platform PayPal Merchant Account** (configured via `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in `.env.local`).
- **Destination of Funds**:
  All captured funds settle directly into the **Platform Merchant PayPal Account**.

### 4.2 Freelancer Payout Boundary
- In standard PayPal Orders v2 / Payments v2, captured payments do **not** automatically route to separate freelancer PayPal accounts.
- Automated secondary disbursement to a freelancer requires approved **PayPal Commerce Platform for Marketplaces (Multiparty)** or **PayPal Payouts API** integration with verified recipient onboarding.
- **Visible Demo Limitation**:
  The application UI and documentation explicitly state:
  > *"Notice: In this PayPal Sandbox demonstration, milestone funds are authorized and captured into the Platform Merchant Account. Automated secondary disbursal to individual freelancer accounts requires PayPal Marketplace / Partner onboarding."*

---

## 5. Currency Specification: USD Only

- The initial MVP is restricted strictly to **USD (`USD`)**.
- Both `public.payments` and `public.milestones` enforce:
  ```sql
  check (currency = 'USD')
  ```
- All client request schemas and server-side validation schemas reject non-USD currencies. Multi-currency support will be introduced only after international settlement requirements are formally verified.

---

## 6. Pre-Migration Checklist Sign-Off

- [x] All 7 Phase 6.3 issues addressed across documentation and SQL.
- [x] Schema migration is non-destructive and backward-compatible.
- [x] TypeScript validation clean (`npx tsc --noEmit` exited 0).
- [x] No SQL migrations executed automatically.
- [x] No payment API routes created or executed.
- [x] No credentials hardcoded or requested.

**Status: Stopped for human review and approval.**
