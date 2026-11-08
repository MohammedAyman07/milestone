# MILESTONE AI — PayPal Database Migration Plan (Phase 6.3)

**Document**: `PAYPAL_DATABASE_MIGRATION_PLAN.md`  
**Migration Target**: `supabase/migrations/20261108030000_paypal_payments_hardening.sql`  
**Target Database**: Supabase PostgreSQL (`https://jlvysdeixasxnoocoeac.supabase.co`)  
**Status**: AWAITING HUMAN APPROVAL (No automated execution)  

---

## 1. Live Database Audit & Inspection Report

A live audit was conducted directly against your remote Supabase instance (`https://jlvysdeixasxnoocoeac.supabase.co`) using authenticated service-role client credentials.

### Live Inspection Findings vs. Static Analysis
| Verification Point | Type | Result | Notes |
| :--- | :--- | :--- | :--- |
| **`public.payments` Table** | **LIVE DB CHECK** | **EXISTS (0 rows)** | Table confirmed live; 15 existing columns probed. |
| **`public.milestones` Table** | **LIVE DB CHECK** | **EXISTS (0 rows)** | Table confirmed live; 17 existing columns probed. |
| **Inspection Error Root Cause** | **DIAGNOSTIC** | **RESOLVED** | The previous command exited with code 1 due to PowerShell syntax parsing nested parentheses (`()`) in an inline one-liner string on Windows. Executing via a standalone script (`live-db-schema-audit.js`) completed with exit code 0. |
| **Existing Data Risk** | **LIVE DB CHECK** | **ZERO RISK** | Tables currently contain 0 live rows, guaranteeing that constraint updates will not break existing production records. |

---

## 2. Existing Payment Status Compatibility & Standardization

### 2.1 Backward-Compatible Status Matrix
Existing check constraints allowed `status in ('UNAUTHORIZED', 'AUTHORIZED', 'SETTLED', 'VOIDED', 'REFUNDED', 'FAILED')`.
To prevent schema regression or breaking historical queries:
1. `SETTLED` and `UNAUTHORIZED` are **retained** in the check constraint.
2. `SETTLED` is treated as a historical alias for `CAPTURED`. However, newly captured payments are strictly marked with canonical `status = 'CAPTURED'` **only** after PayPal's API response confirms `status == 'COMPLETED'`.
3. Casing is standardized across tables:
   - `public.payments.status`: **UPPERCASE** (`'CREATED'`, `'APPROVED'`, `'AUTHORIZED'`, `'CAPTURE_PENDING'`, `'CAPTURED'`, `'SETTLED'`, `'VOIDED'`, `'REFUNDED'`, `'FAILED'`, `'EXPIRED'`, `'UNAUTHORIZED'`).
   - `public.milestones.payment_status`: **lowercase** (`'unauthorized'`, `'created'`, `'approved'`, `'authorized'`, `'capture_pending'`, `'captured'`, `'settled'`, `'voided'`, `'refunded'`, `'failed'`, `'expired'`).

---

## 3. Discrete Payment Attempts & Separate Idempotency Keys

### 3.1 Unique Payment-Attempt ID
A milestone may undergo multiple payment attempts across its lifecycle (e.g., Attempt #1 is abandoned/voided by buyer; Attempt #2 is successfully authorized and captured).

To preserve the complete historical audit trail without overwriting previous attempts:
- Every payment attempt receives a globally unique `payment_attempt_id` (e.g. `att_a1b2c3d4...`).
- An integer `attempt_number` increments per milestone (`1, 2, 3...`).
- Old attempts retain their terminal statuses (`VOIDED`, `FAILED`, `EXPIRED`), PayPal IDs, and audit logs.

### 3.2 Discrete Idempotency Keys per Operation
Idempotency keys are deterministically seeded from the `payment_attempt_id`:
- `idempotency_order_create` = `ord_create_${payment_attempt_id}`
- `idempotency_order_auth` = `ord_auth_${payment_attempt_id}`
- `idempotency_auth_capture` = `auth_cap_${payment_attempt_id}`
- `idempotency_refund` = `refund_${payment_attempt_id}`

**Retry Rule**: Retries of the *same* operation on the *same* attempt reuse these exact keys. If an attempt is voided or fails, a *new* legitimate payment attempt receives a new `payment_attempt_id` and fresh idempotency keys.

### 3.3 Concurrency Barrier: Single Active Attempt & Reauthorization Tracking
- Reauthorizations preserve parent authorization history using `parent_authorization_id`, `reauthorized_at`, and `reauthorization_count`.
- Exactly one active attempt is permitted at any time:
```sql
create unique index if not exists uq_active_milestone_payment_attempt
  on public.payments(milestone_id)
  where status in ('CREATED', 'APPROVED', 'AUTHORIZED', 'CAPTURE_PENDING');
```
*Mathematically prevents a client from having two overlapping active authorizations or orders for the same milestone.*

---

## 4. Authorization Expiry & Honor Period Tracking

- `authorized_at`: Exact timestamp when buyer authorization was captured.
- `honor_period_expires_at`: `authorized_at + interval '3 days'`. PayPal recommends capturing within 3 business days for highest capture success; during this window funds are held on reserve.
- `authorization_expires_at`: `authorized_at + interval '29 days'`. Authorizations remain valid for capture through Day 29.
- **Never Auto-Expire on Day Four**: Authorizations remain in status `AUTHORIZED` through Day 29. They are never prematurely expired on Day 4. Expiration is only recorded if 29 days elapse without capture or if PayPal explicitly returns HTTP 422 `AUTHORIZATION_EXPIRED`.

---

## 5. Currency Integrity: USD Only

The initial MVP is strictly restricted to **USD**:
```sql
alter table public.payments
  add constraint payments_currency_check check (currency = 'USD');

alter table public.milestones
  add constraint milestones_currency_check check (currency = 'USD');
```

---

## 6. Database Trust Boundaries & Trigger Safeguards

### 6.1 Strict Trust Boundary Separation
- **Database Responsibilities**:
  1. Enforces structural invariants (foreign keys, NOT NULL, unique constraints).
  2. Enforces state machine transitions (prohibiting re-captures or terminal status reversals).
  3. Enforces append-only audit logging and auto-populates authorization timestamps.
- **Server Responsibilities**:
  1. Authenticates client session and verifies project role (`auth.uid() == project.client_id`).
  2. Dispatches outbound HTTPS requests to PayPal with `PayPal-Request-Id`.
  3. Validates PayPal API response payloads, HTTP codes, and cryptographic webhook signatures.
  4. Only after server verification does it issue trusted database mutations via service role.
- **Clarification**: Database triggers do *not* make external HTTP requests or verify PayPal signatures; they enforce PostgreSQL data invariants.

### 6.2 State Transition Trigger (`trg_validate_payment_transition`)
- Rejects any attempt to capture an already settled, voided, or refunded payment.
- Rejects any attempt to roll back a `CAPTURED` or `SETTLED` payment to pending/authorized.
- Automatically updates `updated_at = now()` on every state mutation.

---

## 7. Migration Execution & Rollback Plan

### 7.1 Manual Execution Steps in Supabase SQL Editor
1. Open **Supabase Dashboard** $\to$ **SQL Editor**:
   `https://supabase.com/dashboard/project/jlvysdeixasxnoocoeac`
2. Open a new query tab.
3. Paste the contents of [`supabase/migrations/20261108030000_paypal_payments_hardening.sql`](file:///c:/Users/moham/Desktop/milestone-ai/supabase/migrations/20261108030000_paypal_payments_hardening.sql).
4. Click **Run**.
5. Output will report: `Success. No rows returned`.

### 7.2 Rollback Script
In the event that a rollback is required, execute the following script in Supabase SQL Editor:

```sql
drop trigger if exists trg_validate_payment_transition on public.payments;
drop function if exists public.validate_payment_state_transition();

drop table if exists public.paypal_webhook_events;

drop index if exists public.uq_active_milestone_payment_attempt;
drop index if exists public.uq_payments_idempotency_order_create;
drop index if exists public.uq_payments_idempotency_order_auth;
drop index if exists public.uq_payments_idempotency_auth_capture;
drop index if exists public.uq_payments_idempotency_refund;
drop index if exists public.uq_payments_attempt_id;
drop index if exists public.uq_payments_order_id;
drop index if exists public.uq_payments_authorization_id;
drop index if exists public.uq_payments_capture_id;

alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check
  check (status in ('UNAUTHORIZED', 'AUTHORIZED', 'SETTLED', 'VOIDED', 'REFUNDED', 'FAILED'));

alter table public.payments drop constraint if exists payments_currency_check;
alter table public.payments add constraint payments_currency_check
  check (currency = 'USD');

alter table public.milestones drop constraint if exists milestones_payment_status_check;
alter table public.milestones add constraint milestones_payment_status_check
  check (payment_status in ('unauthorized', 'authorized', 'captured', 'voided', 'refunded', 'failed'));

alter table public.milestones drop constraint if exists milestones_currency_check;
alter table public.milestones add constraint milestones_currency_check
  check (currency = 'USD');
```
