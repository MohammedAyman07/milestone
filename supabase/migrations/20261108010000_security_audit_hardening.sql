-- =============================================================================
-- MILESTONE AI — SECURITY AUDIT HARDENING MIGRATION
-- Phase 4.1: Access Control, Concurrency Locks, Immutability & Storage Isolation
-- =============================================================================

-- =============================================================================
-- 1. STORAGE SECURITY: RESTRICT TO ASSIGNED PARTICIPANTS & PREVENT TAMPERING
-- =============================================================================

-- Drop overly permissive placeholder storage policies
drop policy if exists "Evidence upload policy" on storage.objects;
drop policy if exists "Evidence read policy" on storage.objects;
drop policy if exists "Participants can read project evidence" on storage.objects;
drop policy if exists "Participants can upload project evidence" on storage.objects;

-- Storage path format: <project_id>/<milestone_id>/<filename>
-- Verify that the first path segment matches a project where auth.uid() is client or freelancer
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

-- Upload policy: Users can only upload to projects where they are assigned participants
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

-- Note: No UPDATE or DELETE policies are granted on storage.objects for milestone-evidence.
-- This guarantees that uploaded evidence is tamper-proof and cannot be replaced or deleted.


-- =============================================================================
-- 2. BUDGET CONCURRENCY: ROW-LEVEL LOCKING & REDUCTION PROTECTION
-- =============================================================================

-- 2A. Concurrency-safe milestone insert trigger with FOR UPDATE row lock
create or replace function public.check_milestone_budget_limit()
returns trigger as $$
declare
  total_allocated numeric(12,2);
  proj_budget numeric(12,2);
begin
  -- Acquire an exclusive row lock on the parent project row to serialize concurrent inserts
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

-- 2B. Prevent budget reduction below currently allocated milestones
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


-- =============================================================================
-- 3. VERIFICATION REPORT IMMUTABILITY & SEPARATION OF POWERS
-- =============================================================================

-- 3A. Enforce that clients can ONLY update decision and notes, never AI scores or results
create or replace function public.enforce_verification_report_immutability()
returns trigger as $$
begin
  -- Ensure AI findings have not been tampered with
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

  -- Ensure freelancer cannot self-approve
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

-- 3B. Revoke UPDATE and DELETE on individual criteria findings
revoke update, delete on public.verification_criteria_results from public, authenticated;


-- =============================================================================
-- 4. AUDIT LOG SECURITY: TRUSTED SERVER FUNCTION & ANTI-IMPERSONATION
-- =============================================================================

drop policy if exists "Authenticated users can append audit logs" on public.audit_logs;
drop policy if exists "Users can append own audit logs" on public.audit_logs;

-- Trusted server-side function to record audit events (derives actor from auth.uid())
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

  -- Verify actor is a participant in the project
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

-- Policy to prevent actor impersonation on direct table insert
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
-- 5. COMPLETE CHILD TABLE RLS POLICIES (Criteria, Files, Payments)
-- =============================================================================

-- Acceptance criteria policies
drop policy if exists "Participants can view acceptance criteria" on public.acceptance_criteria;
drop policy if exists "Clients can manage acceptance criteria" on public.acceptance_criteria;

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

-- Submission files policies
drop policy if exists "Participants can view submission files" on public.submission_files;
drop policy if exists "Freelancers can record submission files" on public.submission_files;

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

create policy "Freelancers can record submission files"
  on public.submission_files for insert
  with check (
    exists (
      select 1 from public.submissions s
      where s.id = submission_files.submission_id
        and s.submitter_id = auth.uid()
    )
  );

-- Verification criteria results policies
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

-- Payments: Explicitly revoke client INSERT, UPDATE, DELETE
revoke insert, update, delete on public.payments from public, authenticated;


-- =============================================================================
-- 6. PROFILE PRIVACY SHIELD
-- =============================================================================

drop policy if exists "Users can view all profiles" on public.profiles;
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
