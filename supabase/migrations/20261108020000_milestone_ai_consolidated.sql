-- =============================================================================
-- MILESTONE AI — CONSOLIDATED PRODUCTION DATABASE SCHEMA & MIGRATION
-- Single consolidated migration for fresh Supabase projects
-- =============================================================================

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- =============================================================================
-- 1. BASE TABLES DEFINITION (Dependency order: Parent -> Child)
-- =============================================================================

-- Table 1: Profiles (Linked to auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  role text not null check (role in ('client', 'freelancer', 'admin')),
  avatar_url text,
  paypal_merchant_id text,
  rating numeric(3,2) default 5.0 check (rating between 0 and 5),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index if not exists idx_profiles_role on public.profiles(role);

-- Table 2: Projects
create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  description text not null,
  budget numeric(12,2) not null check (budget > 0),
  currency text not null default 'USD',
  status text not null default 'active' check (status in ('draft', 'active', 'in_progress', 'completed', 'on_hold')),
  client_id uuid not null references public.profiles(id) on delete restrict,
  freelancer_id uuid not null references public.profiles(id) on delete restrict,
  start_date timestamptz default now() not null,
  deadline timestamptz not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index if not exists idx_projects_client on public.projects(client_id);
create index if not exists idx_projects_freelancer on public.projects(freelancer_id);
create index if not exists idx_projects_status on public.projects(status);

-- Table 3: Milestones
create table if not exists public.milestones (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  phase integer not null check (phase > 0),
  title text not null,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'USD',
  due_date timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'submitted', 'under_review', 'approved', 'completed')),
  payment_status text not null default 'unauthorized' check (payment_status in ('unauthorized', 'authorized', 'captured', 'voided', 'refunded', 'failed')),
  order_id text,
  authorization_id text,
  capture_id text,
  authorized_date timestamptz,
  captured_date timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint uq_project_phase unique (project_id, phase)
);

create index if not exists idx_milestones_project on public.milestones(project_id);
create index if not exists idx_milestones_status on public.milestones(status);

-- Table 4: Acceptance Criteria
create table if not exists public.acceptance_criteria (
  id uuid primary key default uuid_generate_v4(),
  milestone_id uuid not null references public.milestones(id) on delete cascade,
  criterion_code text not null,
  label text not null,
  description text,
  created_at timestamptz default now() not null
);

create index if not exists idx_criteria_milestone on public.acceptance_criteria(milestone_id);

-- Table 5: Submissions
create table if not exists public.submissions (
  id uuid primary key default uuid_generate_v4(),
  milestone_id uuid not null references public.milestones(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  submitter_id uuid not null references public.profiles(id),
  repo_url text not null,
  staging_url text,
  figma_url text,
  notes text not null,
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'approved', 'revision_requested', 'rejected')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index if not exists idx_submissions_milestone on public.submissions(milestone_id);
create index if not exists idx_submissions_project on public.submissions(project_id);

-- Table 6: Submission Files (Storage metadata)
create table if not exists public.submission_files (
  id uuid primary key default uuid_generate_v4(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  file_name text not null,
  file_size_bytes bigint not null check (file_size_bytes <= 10485760),
  mime_type text not null,
  storage_path text not null,
  description text,
  created_at timestamptz default now() not null
);

create index if not exists idx_sub_files_submission on public.submission_files(submission_id);

-- Table 7: Verification Reports
create table if not exists public.verification_reports (
  id uuid primary key default uuid_generate_v4(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  milestone_id uuid not null references public.milestones(id) on delete cascade,
  model_used text not null default 'gemini-2.5-flash',
  overall_status text not null check (overall_status in ('VERIFIED', 'FAILED', 'NEEDS_EVIDENCE')),
  overall_score integer not null check (overall_score between 0 and 100),
  overall_evidence_quality text not null check (overall_evidence_quality in ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT')),
  confidence_explanation text not null,
  executive_summary text not null,
  unverified_claims jsonb default '[]'::jsonb,
  deterministic_audit jsonb default '{}'::jsonb,
  advisory_notice text not null,
  client_decision text default 'pending' check (client_decision in ('pending', 'approved', 'revisions_requested', 'rejected')),
  client_notes text,
  client_reviewed_at timestamptz,
  created_at timestamptz default now() not null
);

create index if not exists idx_reports_milestone on public.verification_reports(milestone_id);
create index if not exists idx_reports_submission on public.verification_reports(submission_id);

-- Table 8: Verification Criteria Results
create table if not exists public.verification_criteria_results (
  id uuid primary key default uuid_generate_v4(),
  report_id uuid not null references public.verification_reports(id) on delete cascade,
  criterion_id text not null,
  criterion_text text not null,
  result text not null check (result in ('PASS', 'FAIL', 'INCONCLUSIVE')),
  explanation text not null,
  evidence_references jsonb default '[]'::jsonb,
  missing_evidence text,
  confidence_score integer not null check (confidence_score between 0 and 100),
  evidence_quality text not null check (evidence_quality in ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT')),
  is_deterministic_proof boolean default false,
  recommended_action text not null,
  created_at timestamptz default now() not null
);

create index if not exists idx_crit_results_report on public.verification_criteria_results(report_id);

-- Table 9: Payments
create table if not exists public.payments (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  milestone_id uuid not null references public.milestones(id) on delete cascade,
  payer_id uuid not null references public.profiles(id),
  payee_id uuid not null references public.profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'USD',
  payment_type text not null check (payment_type in ('authorization', 'capture', 'refund')),
  status text not null check (status in ('UNAUTHORIZED', 'AUTHORIZED', 'SETTLED', 'VOIDED', 'REFUNDED', 'FAILED')),
  order_id text,
  authorization_id text,
  capture_id text,
  payment_method text not null default 'PAYPAL',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now() not null
);

create index if not exists idx_payments_project on public.payments(project_id);
create index if not exists idx_payments_milestone on public.payments(milestone_id);

-- Table 10: Audit Logs (Append-Only)
create table if not exists public.audit_logs (
  id uuid primary key default uuid_generate_v4(),
  actor_id uuid references public.profiles(id),
  project_id uuid references public.projects(id) on delete cascade,
  milestone_id uuid references public.milestones(id) on delete cascade,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  old_state jsonb,
  new_state jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz default now() not null
);

create index if not exists idx_audit_project on public.audit_logs(project_id);
create index if not exists idx_audit_actor on public.audit_logs(actor_id);

-- Enforce append-only on audit_logs
revoke update, delete on public.audit_logs from public, authenticated;

-- Revoke browser mutations on payments and criteria results
revoke insert, update, delete on public.payments from public, authenticated;
revoke update, delete on public.verification_criteria_results from public, authenticated;


-- =============================================================================
-- 2. INTEGRITY & SECURITY TRIGGERS (Created after all tables exist)
-- =============================================================================

-- Trigger 1: Auto-create profile on auth.users signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'client')
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Trigger 2: Concurrency-safe milestone budget ceiling with FOR UPDATE row lock
create or replace function public.check_milestone_budget_limit()
returns trigger as $$
declare
  total_allocated numeric(12,2);
  proj_budget numeric(12,2);
begin
  -- Exclusively lock the parent project row to serialize concurrent allocations
  select budget into proj_budget 
  from public.projects 
  where id = new.project_id 
  for update;
  
  if proj_budget is null then
    raise exception 'Referenced project % does not exist', new.project_id;
  end if;

  select coalesce(sum(amount), 0) into total_allocated 
  from public.milestones 
  where project_id = new.project_id 
    and id != coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if (total_allocated + new.amount) > proj_budget then
    raise exception 'Concurrent allocation rejected: milestone amount ($%) exceeds remaining project budget ($%)', 
      new.amount, (proj_budget - total_allocated);
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_check_milestone_budget on public.milestones;
create trigger trg_check_milestone_budget
before insert or update on public.milestones
for each row execute function public.check_milestone_budget_limit();

-- Trigger 3: Prevent project budget reduction below existing allocated milestones
create or replace function public.check_project_budget_reduction()
returns trigger as $$
declare
  current_allocated numeric(12,2);
begin
  if new.budget < old.budget then
    select coalesce(sum(amount), 0) into current_allocated
    from public.milestones
    where project_id = new.id;

    if new.budget < current_allocated then
      raise exception 'Cannot reduce project budget to $%: existing milestone allocations total $%',
        new.budget, current_allocated;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_check_project_budget_reduction on public.projects;
create trigger trg_check_project_budget_reduction
before update on public.projects
for each row execute function public.check_project_budget_reduction();

-- Trigger 4: Verification report immutability (locks AI results; allows only client decision updates)
create or replace function public.enforce_verification_report_immutability()
returns trigger as $$
begin
  if (
    old.overall_status != new.overall_status or
    old.overall_score != new.overall_score or
    old.overall_evidence_quality != new.overall_evidence_quality or
    old.confidence_explanation != new.confidence_explanation or
    old.executive_summary != new.executive_summary or
    old.unverified_claims != new.unverified_claims or
    old.deterministic_audit != new.deterministic_audit or
    old.advisory_notice != new.advisory_notice or
    old.submission_id != new.submission_id or
    old.project_id != new.project_id or
    old.milestone_id != new.milestone_id or
    old.model_used != new.model_used
  ) then
    raise exception 'Security violation: AI verification audit results are immutable. Only client review decisions may be updated.';
  end if;

  if exists (
    select 1 from public.projects p
    where p.id = new.project_id and p.freelancer_id = auth.uid()
  ) then
    raise exception 'Security violation: Freelancers cannot review or approve their own milestone deliverables.';
  end if;

  new.client_reviewed_at = now();
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists trg_enforce_verification_immutability on public.verification_reports;
create trigger trg_enforce_verification_immutability
before update on public.verification_reports
for each row execute function public.enforce_verification_report_immutability();

-- Function 5: Trusted audit logging stored procedure
create or replace function public.record_audit_event(
  p_project_id uuid,
  p_milestone_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old_state jsonb default null,
  p_new_state jsonb default null
)
returns uuid as $$
declare
  v_actor_id uuid;
  v_log_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'Unauthenticated audit event attempt';
  end if;

  if p_project_id is not null and not exists (
    select 1 from public.projects p
    where p.id = p_project_id and (p.client_id = v_actor_id or p.freelancer_id = v_actor_id)
  ) then
    raise exception 'Unauthorized: User is not a participant in project %', p_project_id;
  end if;

  insert into public.audit_logs (
    actor_id,
    project_id,
    milestone_id,
    action,
    entity_type,
    entity_id,
    old_state,
    new_state
  )
  values (
    v_actor_id,
    p_project_id,
    p_milestone_id,
    p_action,
    p_entity_type,
    p_entity_id,
    p_old_state,
    p_new_state
  )
  returning id into v_log_id;

  return v_log_id;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;


-- =============================================================================
-- 3. ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.milestones enable row level security;
alter table public.acceptance_criteria enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_files enable row level security;
alter table public.verification_reports enable row level security;
alter table public.verification_criteria_results enable row level security;
alter table public.payments enable row level security;
alter table public.audit_logs enable row level security;

-- 1. Profiles Policies
drop policy if exists "Users can view participant profiles" on public.profiles;
create policy "Users can view participant profiles"
  on public.profiles for select
  using (
    auth.uid() = id
    or exists (
      select 1 from public.projects p
      where (p.client_id = auth.uid() and p.freelancer_id = profiles.id)
         or (p.freelancer_id = auth.uid() and p.client_id = profiles.id)
    )
  );

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- 2. Projects Policies
drop policy if exists "Participants can view their projects" on public.projects;
create policy "Participants can view their projects"
  on public.projects for select
  using (auth.uid() = client_id or auth.uid() = freelancer_id);

drop policy if exists "Clients can create projects" on public.projects;
create policy "Clients can create projects"
  on public.projects for insert
  with check (
    auth.uid() = client_id
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('client', 'admin')
    )
  );

drop policy if exists "Clients can update their projects" on public.projects;
create policy "Clients can update their projects"
  on public.projects for update
  using (auth.uid() = client_id);

-- 3. Milestones Policies
drop policy if exists "Participants can view milestones" on public.milestones;
create policy "Participants can view milestones"
  on public.milestones for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = milestones.project_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Clients can manage milestones" on public.milestones;
create policy "Clients can manage milestones"
  on public.milestones for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = milestones.project_id
        and p.client_id = auth.uid()
    )
  );

-- 4. Acceptance Criteria Policies
drop policy if exists "Participants can view acceptance criteria" on public.acceptance_criteria;
create policy "Participants can view acceptance criteria"
  on public.acceptance_criteria for select
  using (
    exists (
      select 1 from public.milestones m
      join public.projects p on p.id = m.project_id
      where m.id = acceptance_criteria.milestone_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Clients can manage acceptance criteria" on public.acceptance_criteria;
create policy "Clients can manage acceptance criteria"
  on public.acceptance_criteria for all
  using (
    exists (
      select 1 from public.milestones m
      join public.projects p on p.id = m.project_id
      where m.id = acceptance_criteria.milestone_id
        and p.client_id = auth.uid()
    )
  );

-- 5. Submissions Policies
drop policy if exists "Participants can view submissions" on public.submissions;
create policy "Participants can view submissions"
  on public.submissions for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = submissions.project_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Freelancers can create submissions" on public.submissions;
create policy "Freelancers can create submissions"
  on public.submissions for insert
  with check (auth.uid() = submitter_id);

-- 6. Submission Files Policies
drop policy if exists "Participants can view submission files" on public.submission_files;
create policy "Participants can view submission files"
  on public.submission_files for select
  using (
    exists (
      select 1 from public.submissions s
      join public.projects p on p.id = s.project_id
      where s.id = submission_files.submission_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Freelancers can record submission files" on public.submission_files;
create policy "Freelancers can record submission files"
  on public.submission_files for insert
  with check (
    exists (
      select 1 from public.submissions s
      where s.id = submission_files.submission_id
        and s.submitter_id = auth.uid()
    )
  );

-- 7. Verification Reports Policies
drop policy if exists "Participants can view verification reports" on public.verification_reports;
create policy "Participants can view verification reports"
  on public.verification_reports for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = verification_reports.project_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Clients can update review decisions" on public.verification_reports;
create policy "Clients can update review decisions"
  on public.verification_reports for update
  using (
    exists (
      select 1 from public.projects p
      where p.id = verification_reports.project_id
        and p.client_id = auth.uid()
    )
  );

-- 8. Verification Criteria Results Policies
drop policy if exists "Participants can view verification criteria results" on public.verification_criteria_results;
create policy "Participants can view verification criteria results"
  on public.verification_criteria_results for select
  using (
    exists (
      select 1 from public.verification_reports r
      join public.projects p on p.id = r.project_id
      where r.id = verification_criteria_results.report_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

-- 9. Payments Policies
drop policy if exists "Participants can view payments" on public.payments;
create policy "Participants can view payments"
  on public.payments for select
  using (auth.uid() = payer_id or auth.uid() = payee_id);

-- 10. Audit Logs Policies
drop policy if exists "Participants can view audit logs" on public.audit_logs;
create policy "Participants can view audit logs"
  on public.audit_logs for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = audit_logs.project_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Users can append own audit logs" on public.audit_logs;
create policy "Users can append own audit logs"
  on public.audit_logs for insert
  with check (
    auth.uid() is not null
    and actor_id = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = audit_logs.project_id
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );


-- =============================================================================
-- 4. PRIVATE EVIDENCE STORAGE BUCKET CONFIGURATION
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'milestone-evidence',
  'milestone-evidence',
  false,
  10485760, -- 10MB
  array[
    'application/pdf',
    'application/json',
    'text/plain',
    'text/markdown',
    'text/csv',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/svg+xml'
  ]
)
on conflict (id) do nothing;

drop policy if exists "Participants can read project evidence" on storage.objects;
create policy "Participants can read project evidence"
  on storage.objects for select
  using (
    bucket_id = 'milestone-evidence'
    and auth.role() = 'authenticated'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(name))[1]
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );

drop policy if exists "Participants can upload project evidence" on storage.objects;
create policy "Participants can upload project evidence"
  on storage.objects for insert
  with check (
    bucket_id = 'milestone-evidence'
    and auth.role() = 'authenticated'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(name))[1]
        and (p.client_id = auth.uid() or p.freelancer_id = auth.uid())
    )
  );
