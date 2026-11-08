# MILESTONE AI — Known Limitations & System Boundaries (Phase 5.1)

**Document Version**: 1.0  
**Phase**: Pre-PayPal Integration (Phase 5.1 Review)  
**System**: MILESTONE AI Institutional Milestone Verification Platform  

---

## 1. Architectural Boundaries & Intentional Scope Constraints

### 1.1 Payment Gateway Scope
- **Current State**: PayPal SDK, payment webhooks, and payment orders are **intentionally not implemented** in Phase 5.
- **Enforced Boundary**: The application and AI engine are strictly prohibited from disbursing funds or automatically capturing payments.
- **Target Resolution**: Phase 6 will implement the real PayPal Orders v2 and Authorizations API.

### 1.2 Frontend State Sync vs. Unauthenticated Demo Fallback
- **Current State**: When users access the UI without signing in, `ProjectContext.tsx` falls back to rich local demo state to allow previewing the Stitch-inspired dashboards and submission workflows without hard auth barriers.
- **Production Implication**: State created in local demo mode is not automatically written to PostgreSQL unless the user logs in through Supabase Auth.
- **Target Resolution**: A full database synchronization layer for the UI will seamlessly transition demo projects to remote PostgreSQL upon user login.

---

## 2. Technical Infrastructure Limitations

### 2.1 In-Memory Rate Limiting
- **Current State**: The rate limiter (`src/lib/rate-limiter.ts`) uses an in-memory sliding window `Map` with periodic TTL pruning.
- **Boundary**: In multi-instance serverless deployments (e.g. Vercel with multiple edge/lambda regions), rate limit counters are isolated to the specific process instance.
- **Recommended Production Hardening**: Deploy a distributed rate limiter (Upstash Redis / Supabase Edge KV) for clustered environments.

### 2.2 Deep Binary Evidence Inspection
- **Current State**: 
  - Text, JSON, XML, HTML, CSV, and Markdown files are directly inspectable.
  - Large binary evidence (such as MP4 video recordings, heavy PDF scans, or ZIP archives) is audited via deterministic metadata: file size bounds (max 10 MB per file, max 25 MB total), file format restrictions, and developer claim correlation.
- **Boundary**: The AI engine does not perform real-time video frame decoding or OCR on handwritten scanned images.
- **Recommended Hardening**: Integrate Google Cloud Video Intelligence or Document AI for automated OCR and video frame extraction in enterprise tiers.

### 2.3 Gemini Model High-Demand Fallback
- **Current State**: When `gemini-3.8-flash` experiences transient high-demand throttling (HTTP 503), the engine automatically falls back to `gemini-2.5-flash` with exponential backoff retries.
- **Boundary**: Verification reports reflect `modelUsed: "gemini-2.5-flash"` when the fallback model is engaged. Both models use the exact same Zod validation schema and deterministic scoring rules.

---

## 3. Security Hardening Recommendations for Live Supabase SQL Editor

The consolidated migration file (`supabase/migrations/20261108020000_milestone_ai_consolidated.sql`) has been updated with the hardened project creation policy.

If you have already executed the consolidated migration against your remote Supabase instance, you can run this single 8-line policy update in the **Supabase SQL Editor** to ensure that only users with `role in ('client', 'admin')` can create projects:

```sql
-- Security Hardening: Enforce client role on project creation
drop policy if exists "Clients can create projects" on public.projects;
create policy "Clients can create projects"
  on public.projects for insert to authenticated
  with check (
    auth.uid() = client_id
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('client', 'admin')
    )
  );
```

---

## 4. Verification Checkpoint

| Feature | Phase 5 Status | Phase 6 Readiness |
| :--- | :--- | :--- |
| **Supabase Database (10 Tables)** | 100% Operational | Ready |
| **Private Evidence Storage** | 100% Operational | Ready |
| **Gemini AI Verification Engine** | 100% Operational & Hardened | Ready |
| **Budget & Concurrency Triggers** | 100% Operational | Ready |
| **Audit Logs (Append-Only)** | 100% Operational | Ready |
| **PayPal Authorizations & Captures**| Omitted by design | Ready for implementation |
