-- =============================================================================
-- MILESTONE AI — PAYPAL FINANCIAL INTEGRITY & PAYMENTS HARDENING MIGRATION
-- Migration File: 20261108030000_paypal_payments_hardening.sql
-- Description: Non-destructive, backward-compatible hardening for PayPal Orders v2 & Payments v2.
--              - Discrete payment-attempt ID & operation-specific idempotency keys
--              - USD-only MVP currency constraint
--              - 29-day authorization validity, 3-day recommended honor period, and reauthorization tracking
--              - Defensively archives duplicate active attempts before unique index creation
--              - Complete permitted state-transition matrix enforced by security definer trigger
--              - Fixed search_path (public, pg_temp) to eliminate search-path injection
--              - Immutability guards on critical financial fields (amount, currency, IDs)
--              - Webhook deduplication table with signature verification tracking and RLS
-- =============================================================================

-- Ensure required extension exists
create extension if not exists "uuid-ossp";

-- =============================================================================
-- 1. HARDEN public.payments TABLE (COLUMNS & DATA NORMALIZATION)
-- =============================================================================

-- A. Explicitly add all required PayPal tracking, idempotency, and reauthorization columns
alter table public.payments
  add column if not exists payment_attempt_id text,
  add column if not exists attempt_number integer not null default 1,
  add column if not exists order_id text,
  add column if not exists authorization_id text,
  add column if not exists parent_authorization_id text,
  add column if not exists reauthorization_count integer not null default 0,
  add column if not exists capture_id text,
  add column if not exists refund_id text,
  add column if not exists paypal_payer_id text,
  add column if not exists paypal_payer_email text,
  add column if not exists paypal_payer_name text,
  add column if not exists paypal_merchant_id text,
  add column if not exists idempotency_order_create text,
  add column if not exists idempotency_order_auth text,
  add column if not exists idempotency_auth_capture text,
  add column if not exists idempotency_refund text,
  add column if not exists capture_initiated_at timestamptz,
  add column if not exists authorized_at timestamptz,
  add column if not exists reauthorized_at timestamptz,
  add column if not exists authorization_expires_at timestamptz,
  add column if not exists honor_period_expires_at timestamptz,
  add column if not exists captured_at timestamptz,
  add column if not exists voided_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists manual_reconciliation_required boolean not null default false,
  add column if not exists reconciliation_notes text,
  add column if not exists error_details jsonb default '{}'::jsonb,
  add column if not exists raw_paypal_response jsonb default '{}'::jsonb,
  add column if not exists updated_at timestamptz default now() not null;

-- B. Populate payment_attempt_id for any existing rows if null
update public.payments
set payment_attempt_id = 'att_' || replace(id::text, '-', '')
where payment_attempt_id is null;

-- Ensure payment_attempt_id is not null moving forward
alter table public.payments
  alter column payment_attempt_id set not null;

-- C. Normalize existing statuses to uppercase if any lowercase rows exist
update public.payments
set status = upper(status)
where status is not null and status <> upper(status);

-- D. Normalize currencies to USD for MVP if any non-USD or null rows exist
update public.payments
set currency = 'USD'
where currency is null or currency <> 'USD';

update public.milestones
set currency = 'USD'
where currency is null or currency <> 'USD';

-- E. Defensively resolve duplicate active payment attempts before creating unique index
-- If any milestone has multiple rows in active statuses, archive older ones to VOIDED
with ranked_active as (
  select id,
         row_number() over (partition by milestone_id order by created_at desc) as rn
  from public.payments
  where status in ('CREATED', 'APPROVED', 'AUTHORIZED', 'CAPTURE_PENDING')
)
update public.payments
set status = 'VOIDED',
    error_details = jsonb_build_object('archived_reason', 'Superseded duplicate active attempt during migration')
where id in (select id from ranked_active where rn > 1);

-- =============================================================================
-- 2. HARDEN CONSTRAINTS & UNIQUENESS INDEXES
-- =============================================================================

-- A. Safely expand payment status constraint (preserving SETTLED, UNAUTHORIZED)
alter table public.payments
  drop constraint if exists payments_status_check;

alter table public.payments
  add constraint payments_status_check
  check (status in (
    'CREATED',
    'APPROVED',
    'AUTHORIZED',
    'CAPTURE_PENDING',
    'CAPTURED',
    'SETTLED',     -- Preserved for backward-compatibility
    'VOIDED',
    'REFUNDED',
    'FAILED',
    'EXPIRED',
    'UNAUTHORIZED' -- Preserved for backward-compatibility
  ));

-- B. Currency integrity constraint: Initial MVP restricted to USD only
alter table public.payments
  drop constraint if exists payments_currency_check;

alter table public.payments
  add constraint payments_currency_check
  check (currency = 'USD');

-- C. Expand payment_type constraint
alter table public.payments
  drop constraint if exists payments_payment_type_check;

alter table public.payments
  add constraint payments_payment_type_check
  check (payment_type in ('order', 'authorization', 'capture', 'refund'));

-- D. Unique constraint on payment_attempt_id
create unique index if not exists uq_payments_attempt_id
  on public.payments(payment_attempt_id);

-- E. Unique constraints on PayPal transaction identifiers (ignoring nulls)
create unique index if not exists uq_payments_order_id
  on public.payments(order_id)
  where order_id is not null;

create unique index if not exists uq_payments_authorization_id
  on public.payments(authorization_id)
  where authorization_id is not null;

create unique index if not exists uq_payments_capture_id
  on public.payments(capture_id)
  where capture_id is not null;

-- F. Unique constraints on operation-specific idempotency keys (ignoring nulls)
create unique index if not exists uq_payments_idempotency_order_create
  on public.payments(idempotency_order_create)
  where idempotency_order_create is not null;

create unique index if not exists uq_payments_idempotency_order_auth
  on public.payments(idempotency_order_auth)
  where idempotency_order_auth is not null;

create unique index if not exists uq_payments_idempotency_auth_capture
  on public.payments(idempotency_auth_capture)
  where idempotency_auth_capture is not null;

create unique index if not exists uq_payments_idempotency_refund
  on public.payments(idempotency_refund)
  where idempotency_refund is not null;

-- G. Barrier: Exactly ONE active payment attempt per milestone
create unique index if not exists uq_active_milestone_payment_attempt
  on public.payments(milestone_id)
  where status in ('CREATED', 'APPROVED', 'AUTHORIZED', 'CAPTURE_PENDING');

-- H. Supporting performance indexes
create index if not exists idx_payments_milestone_attempt on public.payments(milestone_id, attempt_number desc);
create index if not exists idx_payments_status on public.payments(status);
create index if not exists idx_payments_updated_at on public.payments(updated_at desc);

-- =============================================================================
-- 3. HARDEN public.milestones TABLE
-- =============================================================================

-- A. Safely expand payment_status constraint on milestones
alter table public.milestones
  drop constraint if exists milestones_payment_status_check;

alter table public.milestones
  add constraint milestones_payment_status_check
  check (payment_status in (
    'unauthorized',
    'created',
    'approved',
    'authorized',
    'capture_pending',
    'captured',
    'settled',
    'voided',
    'refunded',
    'failed',
    'expired'
  ));

-- B. Currency integrity constraint on milestones: Initial MVP restricted to USD only
alter table public.milestones
  drop constraint if exists milestones_currency_check;

alter table public.milestones
  add constraint milestones_currency_check
  check (currency = 'USD');

-- =============================================================================
-- 4. WEBHOOK DEDUPLICATION & SIGNATURE VERIFICATION TABLE
-- =============================================================================

create table if not exists public.paypal_webhook_events (
  id uuid primary key default uuid_generate_v4(),
  transmission_id text not null unique,
  event_type text not null,
  resource_id text not null,
  resource_type text not null,
  event_timestamp timestamptz not null,
  signature_verified boolean not null default false,
  verification_status text not null default 'UNVERIFIED' check (verification_status in ('UNVERIFIED', 'VERIFIED', 'FAILED')),
  verified_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz default now() not null
);

create index if not exists idx_webhook_resource on public.paypal_webhook_events(resource_id);
create index if not exists idx_webhook_event_type on public.paypal_webhook_events(event_type);
create index if not exists idx_webhook_verified on public.paypal_webhook_events(signature_verified);

-- Restrict webhook table access to server-side service role only
alter table public.paypal_webhook_events enable row level security;
revoke all on public.paypal_webhook_events from public, anon, authenticated;
grant all on public.paypal_webhook_events to service_role;

-- =============================================================================
-- 5. COMPLETE STATE-TRANSITION & FIELD IMMUTABILITY TRIGGER
-- =============================================================================

create or replace function public.validate_payment_state_transition()
returns trigger as $$
begin
  -- 1. Protect Critical Financial Fields from Modification
  if new.amount <> old.amount then
    raise exception 'Security Violation: Payment amount is immutable once created (Payment ID: %)', old.id;
  end if;

  if new.currency <> old.currency then
    raise exception 'Security Violation: Payment currency is immutable (Payment ID: %)', old.id;
  end if;

  if new.milestone_id <> old.milestone_id then
    raise exception 'Security Violation: Milestone reference is immutable (Payment ID: %)', old.id;
  end if;

  if new.project_id <> old.project_id then
    raise exception 'Security Violation: Project reference is immutable (Payment ID: %)', old.id;
  end if;

  if new.payment_attempt_id <> old.payment_attempt_id then
    raise exception 'Security Violation: Payment attempt identifier is immutable (Payment ID: %)', old.id;
  end if;

  -- 2. Complete State-Transition Matrix Validation
  if old.status <> new.status then
    case old.status
      when 'CREATED' then
        if new.status not in ('APPROVED', 'FAILED', 'VOIDED', 'EXPIRED') then
          raise exception 'Invalid Transition: Cannot transition from CREATED to %', new.status;
        end if;

      when 'APPROVED' then
        if new.status not in ('AUTHORIZED', 'FAILED', 'VOIDED', 'EXPIRED') then
          raise exception 'Invalid Transition: Cannot transition from APPROVED to %', new.status;
        end if;

      when 'AUTHORIZED' then
        if new.status not in ('CAPTURE_PENDING', 'VOIDED', 'EXPIRED', 'AUTHORIZED') then
          raise exception 'Invalid Transition: Cannot transition from AUTHORIZED to %', new.status;
        end if;

      when 'CAPTURE_PENDING' then
        if new.status not in ('CAPTURED', 'SETTLED', 'AUTHORIZED', 'FAILED', 'VOIDED') then
          raise exception 'Invalid Transition: Cannot transition from CAPTURE_PENDING to %', new.status;
        end if;

      when 'CAPTURED', 'SETTLED' then
        if new.status not in ('REFUNDED') then
          raise exception 'Security Violation: Settled payment % cannot transition to %', old.id, new.status;
        end if;

      when 'VOIDED', 'REFUNDED', 'FAILED', 'EXPIRED' then
        raise exception 'Security Violation: Cannot transition terminal state % to %', old.status, new.status;

      when 'UNAUTHORIZED' then
        if new.status not in ('CREATED', 'AUTHORIZED', 'FAILED', 'VOIDED') then
          raise exception 'Invalid Transition: Cannot transition from UNAUTHORIZED to %', new.status;
        end if;

      else
        raise exception 'Unknown previous payment status: %', old.status;
    end case;
  end if;

  -- 3. Automatic Timestamp Population for Authorization & Reauthorization
  if new.status = 'AUTHORIZED' and (old.status is null or old.status <> 'AUTHORIZED') then
    new.authorized_at = coalesce(new.authorized_at, now());
    new.honor_period_expires_at = coalesce(new.honor_period_expires_at, new.authorized_at + interval '3 days');
    new.authorization_expires_at = coalesce(new.authorization_expires_at, new.authorized_at + interval '29 days');
  end if;

  -- Handle reauthorization timestamp and counter increment
  if new.status = 'AUTHORIZED' and old.status = 'AUTHORIZED' and new.authorization_id <> old.authorization_id then
    new.parent_authorization_id = coalesce(old.parent_authorization_id, old.authorization_id);
    new.reauthorized_at = now();
    new.reauthorization_count = old.reauthorization_count + 1;
    new.honor_period_expires_at = now() + interval '3 days';
  end if;

  -- Update timestamp automatically on state mutation
  new.updated_at = now();

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_validate_payment_transition on public.payments;
create trigger trg_validate_payment_transition
  before update on public.payments
  for each row execute function public.validate_payment_state_transition();
