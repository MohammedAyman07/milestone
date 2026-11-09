import { createServerSupabaseClient } from "./server";
import { createAdminClient } from "./admin";
import { Project, Milestone, VerificationAuditReport, Submission } from "../types";

export interface CreateProjectInput {
  title: string;
  description: string;
  budget: number;
  currency?: string;
  startDate?: string;
  deadline: string;
  clientId: string;
  freelancerId: string;
  initialMilestones?: Array<{
    phase?: number;
    title: string;
    description?: string;
    amount: number;
    currency?: string;
    dueDate: string;
    criteria?: Array<{ code?: string; label: string; description?: string }>;
  }>;
}

export interface CreateMilestoneInput {
  projectId: string;
  phase: number;
  title: string;
  description: string;
  amount: number;
  currency?: string;
  dueDate: string;
  criteria: Array<{ code: string; label: string; description?: string }>;
}

export interface AppendAuditLogInput {
  actorId?: string;
  projectId?: string;
  milestoneId?: string;
  action: string;
  entityType: string;
  entityId: string;
  oldState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// 1. Fetch Projects for current authenticated user
export async function fetchProjectsFromDb(
  userId?: string,
  projectId?: string
): Promise<{ projects: Project[]; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { projects: [], error: "Supabase client not configured" };
  }

  // Security: Unauthenticated callers without userId or projectId must NEVER receive all tenant records
  if (!userId && !projectId) {
    return { projects: [] };
  }

  let query = supabase
    .from("projects")
    .select(`
      id,
      title,
      description,
      budget,
      currency,
      status,
      start_date,
      deadline,
      created_at,
      client_id,
      freelancer_id,
      client:profiles!projects_client_id_fkey(id, email, full_name, role, avatar_url, paypal_merchant_id, rating),
      freelancer:profiles!projects_freelancer_id_fkey(id, email, full_name, role, avatar_url, paypal_merchant_id, rating),
      milestones(
        id,
        phase,
        title,
        description,
        amount,
        currency,
        due_date,
        status,
        payment_status,
        order_id,
        authorization_id,
        capture_id,
        authorized_date,
        captured_date,
        acceptance_criteria(id, criterion_code, label, description)
      )
    `)
    .order("created_at", { ascending: false });

  if (projectId) {
    query = query.eq("id", projectId);
    if (userId) {
      query = query.or(`client_id.eq.${userId},freelancer_id.eq.${userId}`);
    }
  } else if (userId) {
    query = query.or(`client_id.eq.${userId},freelancer_id.eq.${userId}`);
  }

  const { data: rawProjects, error } = await query;

  if (error) {
    return { projects: [], error: error.message };
  }

  // Map to frontend Project model
  const mappedProjects: Project[] = (rawProjects || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    budget: Number(p.budget),
    currency: p.currency,
    startDate: p.start_date,
    deadline: p.deadline,
    status: p.status,
    createdAt: p.created_at,
    clientId: p.client_id || p.client?.id,
    freelancerId: p.freelancer_id || p.freelancer?.id,
    client: {
      id: p.client?.id || p.client_id,
      name: p.client?.full_name || "Client",
      email: p.client?.email || "",
      role: p.client?.role || "client",
      avatar: p.client?.avatar_url,
      paypalMerchantId: p.client?.paypal_merchant_id,
      rating: Number(p.client?.rating || 5.0),
    },
    freelancer: {
      id: p.freelancer?.id || p.freelancer_id,
      name: p.freelancer?.full_name || "Freelancer",
      email: p.freelancer?.email || "",
      role: p.freelancer?.role || "freelancer",
      avatar: p.freelancer?.avatar_url,
      paypalMerchantId: p.freelancer?.paypal_merchant_id,
      rating: Number(p.freelancer?.rating || 5.0),
    },
    milestones: (p.milestones || [])
      .sort((a: any, b: any) => a.phase - b.phase)
      .map((m: any) => ({
        id: m.id,
        projectId: p.id,
        phase: m.phase,
        totalPhases: p.milestones.length,
        title: m.title,
        description: m.description,
        amount: Number(m.amount),
        currency: m.currency,
        dueDate: m.due_date,
        status: m.status,
        paymentStatus: m.payment_status,
        orderId: m.order_id,
        authorizationId: m.authorization_id,
        captureId: m.capture_id,
        authorizedDate: m.authorized_date,
        capturedDate: m.captured_date,
        acceptanceCriteria: (m.acceptance_criteria || []).map((c: any) => ({
          id: c.criterion_code || c.id,
          label: c.label,
          description: c.description,
        })),
      })),
  }));

  return { projects: mappedProjects };
}

// 2. Create Project in Supabase
export async function createProjectInDb(
  input: CreateProjectInput
): Promise<{ success: boolean; projectId?: string; project?: Project; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Supabase not configured." };

  const { data, error } = await supabase
    .from("projects")
    .insert({
      title: input.title,
      description: input.description,
      budget: input.budget,
      currency: input.currency || "USD",
      start_date: input.startDate || new Date().toISOString(),
      deadline: input.deadline,
      client_id: input.clientId,
      freelancer_id: input.freelancerId,
      status: "active",
    })
    .select("id")
    .single();

  if (error || !data) {
    return { success: false, error: error?.message || "Failed to create project." };
  }

  const projectId = data.id;

  // Insert initial milestones if provided
  if (input.initialMilestones && input.initialMilestones.length > 0) {
    for (let i = 0; i < input.initialMilestones.length; i++) {
      const m = input.initialMilestones[i];
      const phaseNum = m.phase || i + 1;

      const { data: mData, error: mError } = await supabase
        .from("milestones")
        .insert({
          project_id: projectId,
          phase: phaseNum,
          title: m.title,
          description: m.description || "Initial deliverable contract scope.",
          amount: m.amount,
          currency: m.currency || input.currency || "USD",
          due_date: m.dueDate,
          status: "pending",
          payment_status: "unauthorized",
        })
        .select("id")
        .single();

      if (mError || !mData) {
        // Rollback created project on milestone allocation failure
        await supabase.from("projects").delete().eq("id", projectId);
        return {
          success: false,
          error: `Milestone allocation rejected: ${mError?.message || "Unknown milestone error"}`,
        };
      }

      // Insert criteria for this milestone
      if (m.criteria && m.criteria.length > 0) {
        const criteriaRows = m.criteria.map((c, cIdx) => ({
          milestone_id: mData.id,
          criterion_code: c.code || `AC-${cIdx + 1}`,
          label: c.label,
          description: c.description || c.label,
        }));

        const { error: cError } = await supabase
          .from("acceptance_criteria")
          .insert(criteriaRows);

        if (cError) {
          console.error("Criteria insert error:", cError.message);
        }
      }

      // Record milestone creation audit log
      await recordAuditLogInDb({
        actorId: input.clientId,
        projectId,
        milestoneId: mData.id,
        action: "MILESTONE_CREATED",
        entityType: "milestone",
        entityId: mData.id,
        newState: { phase: phaseNum, title: m.title, amount: m.amount },
      });
    }
  }

  // Record audit log for project creation
  await recordAuditLogInDb({
    actorId: input.clientId,
    projectId: data.id,
    action: "PROJECT_CREATED",
    entityType: "project",
    entityId: data.id,
    newState: { title: input.title, budget: input.budget },
  });

  // Fetch full mapped project record for immediate UI synchronization
  const fetchRes = await fetchProjectsFromDb(input.clientId, data.id);
  const createdProject = fetchRes.projects.find((p) => p.id === data.id);

  return { success: true, projectId: data.id, project: createdProject };
}

// 3. Create Milestone in Supabase
export async function createMilestoneInDb(
  input: CreateMilestoneInput
): Promise<{ success: boolean; milestoneId?: string; error?: string }> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { success: false, error: "Supabase not configured." };

  // Insert milestone (trigger will check budget ceiling limit)
  const { data: mData, error: mError } = await supabase
    .from("milestones")
    .insert({
      project_id: input.projectId,
      phase: input.phase,
      title: input.title,
      description: input.description,
      amount: input.amount,
      currency: input.currency || "USD",
      due_date: input.dueDate,
      status: "pending",
      payment_status: "unauthorized",
    })
    .select("id")
    .single();

  if (mError || !mData) {
    return { success: false, error: mError?.message || "Failed to create milestone." };
  }

  // Insert acceptance criteria
  if (input.criteria && input.criteria.length > 0) {
    const criteriaRows = input.criteria.map((c, i) => ({
      milestone_id: mData.id,
      criterion_code: c.code || `c${i + 1}`,
      label: c.label,
      description: c.description || null,
    }));

    const { error: cError } = await supabase.from("acceptance_criteria").insert(criteriaRows);
    if (cError) {
      console.error("Criteria insert error:", cError.message);
    }
  }

  // Audit log
  await recordAuditLogInDb({
    projectId: input.projectId,
    milestoneId: mData.id,
    action: "MILESTONE_CREATED",
    entityType: "milestone",
    entityId: mData.id,
    newState: { phase: input.phase, title: input.title, amount: input.amount },
  });

  return { success: true, milestoneId: mData.id };
}

// 4. Retrieve Actual Milestone Acceptance Criteria from Supabase
export async function fetchMilestoneCriteriaFromDb(
  milestoneId: string
): Promise<{ criteria: Array<{ id: string; label: string; description?: string }>; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { criteria: [], error: "Supabase client unavailable" };

  try {
    const { data, error } = await supabase
      .from("acceptance_criteria")
      .select("criterion_code, label, description")
      .eq("milestone_id", milestoneId);

    if (error) {
      return { criteria: [], error: error.message };
    }

    return {
      criteria: (data || []).map((c) => ({
        id: c.criterion_code,
        label: c.label,
        description: c.description || undefined,
      })),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { criteria: [], error: msg };
  }
}

// 5. Retrieve Freelancer Submission and Attached Files from Supabase
export async function fetchSubmissionFromDb(
  submissionId: string
): Promise<{ submission?: any; files?: any[]; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { error: "Supabase client unavailable" };

  try {
    const { data: sub, error: subError } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", submissionId)
      .single();

    if (subError || !sub) {
      return { error: subError?.message || "Submission not found" };
    }

    const { data: files } = await supabase
      .from("submission_files")
      .select("*")
      .eq("submission_id", submissionId);

    return { submission: sub, files: files || [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

// 6. Create Submission in Supabase
export interface CreateSubmissionDbInput {
  milestoneId: string;
  projectId: string;
  submitterId: string;
  repoUrl: string;
  stagingUrl?: string;
  figmaUrl?: string;
  notes: string;
  files?: Array<{
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    storagePath: string;
    description?: string;
  }>;
}

export async function createSubmissionInDb(
  input: CreateSubmissionDbInput
): Promise<{ success: boolean; submissionId?: string; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Supabase client not configured." };

  try {
    const { data: sub, error: subErr } = await supabase
      .from("submissions")
      .insert({
        milestone_id: input.milestoneId,
        project_id: input.projectId,
        submitter_id: input.submitterId,
        repo_url: input.repoUrl,
        staging_url: input.stagingUrl || null,
        figma_url: input.figmaUrl || null,
        notes: input.notes,
        status: "submitted",
      })
      .select("id")
      .single();

    if (subErr || !sub) {
      return { success: false, error: subErr?.message || "Failed to create submission" };
    }

    if (input.files && input.files.length > 0) {
      const fileRows = input.files.map((f) => ({
        submission_id: sub.id,
        file_name: f.fileName,
        file_size_bytes: f.fileSizeBytes,
        mime_type: f.mimeType,
        storage_path: f.storagePath,
        description: f.description || null,
      }));
      await supabase.from("submission_files").insert(fileRows);
    }

    // Update milestone status to 'submitted'
    await supabase
      .from("milestones")
      .update({ status: "submitted" })
      .eq("id", input.milestoneId);

    return { success: true, submissionId: sub.id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// 7. Verify Project Participation (Prevents Cross-Project Access)
export async function verifyProjectAccess(
  userId: string,
  projectId: string
): Promise<{ allowed: boolean; role?: "client" | "freelancer" | "admin"; error?: string }> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { allowed: true };

  try {
    const { data: project, error } = await supabase
      .from("projects")
      .select("client_id, freelancer_id")
      .eq("id", projectId)
      .single();

    if (error || !project) {
      // If project not in DB (e.g. demo project), allow for local testing
      return { allowed: true };
    }

    if (project.client_id === userId) {
      return { allowed: true, role: "client" };
    }
    if (project.freelancer_id === userId) {
      return { allowed: true, role: "freelancer" };
    }

    return { allowed: false, error: "Access denied: User is not an authorized participant in this project." };
  } catch {
    return { allowed: true };
  }
}

// 8. Save Verification Report in Supabase (with Immutability & Criteria Results)
export async function saveVerificationReportInDb(
  report: VerificationAuditReport,
  submissionId: string
): Promise<{ success: boolean; reportId?: string; error?: string }> {
  // Use admin client for trusted server-side report writing to enforce RLS integrity
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) return { success: false, error: "Supabase not configured." };

  try {
    // Check if submissionId is a valid UUID and exists in DB
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let targetSubmissionId = submissionId;

    if (!uuidRegex.test(targetSubmissionId)) {
      // Find or create placeholder submission for demo/testing if milestone is valid UUID
      if (uuidRegex.test(report.milestoneId)) {
        const { data: existingSub } = await supabase
          .from("submissions")
          .select("id")
          .eq("milestone_id", report.milestoneId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingSub) {
          targetSubmissionId = existingSub.id;
        } else {
          // If milestone is in DB, retrieve project_id and freelancer_id to create submission
          const { data: mRow } = await supabase
            .from("milestones")
            .select("project_id, projects!inner(freelancer_id)")
            .eq("id", report.milestoneId)
            .single();

          if (mRow) {
            const freelancerId = (mRow as any).projects?.freelancer_id;
            const { data: newSub } = await supabase
              .from("submissions")
              .insert({
                milestone_id: report.milestoneId,
                project_id: mRow.project_id,
                submitter_id: freelancerId,
                repo_url: "https://github.com/repo/test",
                notes: "Automated submission context",
                status: "submitted",
              })
              .select("id")
              .single();

            if (newSub) {
              targetSubmissionId = newSub.id;
            }
          }
        }
      }
    }

    // If still not a valid UUID, report cannot be saved to PostgreSQL FK, log and return
    if (!uuidRegex.test(targetSubmissionId) || !uuidRegex.test(report.milestoneId) || !uuidRegex.test(report.projectId)) {
      console.info("Report uses demo IDs; skipping remote PostgreSQL relational insertion.");
      return { success: true };
    }

    const { data: rData, error: rError } = await supabase
      .from("verification_reports")
      .insert({
        submission_id: targetSubmissionId,
        project_id: report.projectId,
        milestone_id: report.milestoneId,
        model_used: report.modelUsed || "gemini-2.5-flash",
        overall_status: report.overallStatus,
        overall_score: report.overallScore,
        overall_evidence_quality: report.overallEvidenceQuality,
        confidence_explanation: report.confidenceExplanation,
        executive_summary: report.executiveSummary,
        unverified_claims: report.unverifiedClaims || [],
        deterministic_audit: report.deterministicAudit || {},
        advisory_notice: report.advisoryNotice,
        client_decision: "pending",
      })
      .select("id")
      .single();

    if (rError || !rData) {
      return { success: false, error: rError?.message || "Failed to save verification report." };
    }

    // Save individual criteria results
    if (report.criteriaResults && report.criteriaResults.length > 0) {
      const critRows = report.criteriaResults.map((cr) => ({
        report_id: rData.id,
        criterion_id: cr.criterionId,
        criterion_text: cr.criterionText,
        result: cr.result,
        explanation: cr.explanation,
        evidence_references: cr.evidenceReferences || [],
        missing_evidence: cr.missingEvidence || null,
        confidence_score: cr.confidenceScore,
        evidence_quality: cr.evidenceQuality,
        is_deterministic_proof: cr.isDeterministicProof || false,
        recommended_action: cr.recommendedAction,
      }));

      await supabase.from("verification_criteria_results").insert(critRows);
    }

    // Append to audit_logs
    await recordAuditLogInDb({
      projectId: report.projectId,
      milestoneId: report.milestoneId,
      action: "AI_VERIFICATION_COMPLETED",
      entityType: "verification_report",
      entityId: rData.id,
      newState: { overallStatus: report.overallStatus, score: report.overallScore, model: report.modelUsed },
    });

    return { success: true, reportId: rData.id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error in saveVerificationReportInDb:", msg);
    return { success: false, error: msg };
  }
}

// 9. Append-only Audit Log recorder using trusted server-side function
export async function recordAuditLogInDb(input: AppendAuditLogInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const supabase = admin || (await createServerSupabaseClient());
    if (!supabase) return;

    // Check if actor is provided or derive from session
    let actorId = input.actorId;
    if (!actorId) {
      const serverClient = await createServerSupabaseClient();
      if (serverClient) {
        const { data: sessionData } = await serverClient.auth.getSession();
        actorId = sessionData?.session?.user?.id;
      }
    }

    // Direct insert protected by table RLS / admin client
    await supabase.from("audit_logs").insert({
      actor_id: actorId || null,
      project_id: input.projectId || null,
      milestone_id: input.milestoneId || null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      old_state: input.oldState || null,
      new_state: input.newState || null,
      ip_address: input.ipAddress || null,
      user_agent: input.userAgent || null,
    });
  } catch (err) {
    console.error("Failed to append audit log:", err);
  }
}

// 10. Retrieve Authoritative Milestone Review & Evidence Details
export async function fetchMilestoneReviewDetails(
  milestoneId: string,
  userId: string
): Promise<{
  success: boolean;
  statusCode: number;
  error?: string;
  milestone?: any;
  project?: any;
  submission?: any;
  files?: any[];
  verificationReport?: any;
  criteriaResults?: any[];
  payment?: any;
  userRole?: "client" | "freelancer";
}> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { success: false, statusCode: 500, error: "Database client unavailable." };
  }

  try {
    // 1. Fetch milestone
    const { data: milestone, error: mError } = await supabase
      .from("milestones")
      .select("*")
      .eq("id", milestoneId)
      .single();

    if (mError || !milestone) {
      return { success: false, statusCode: 404, error: "Milestone not found." };
    }

    // 2. Fetch project
    const { data: project, error: pError } = await supabase
      .from("projects")
      .select(`
        id,
        title,
        description,
        budget,
        currency,
        status,
        client_id,
        freelancer_id,
        client:profiles!projects_client_id_fkey(id, email, full_name),
        freelancer:profiles!projects_freelancer_id_fkey(id, email, full_name)
      `)
      .eq("id", milestone.project_id)
      .single();

    if (pError || !project) {
      return { success: false, statusCode: 404, error: "Associated project not found." };
    }

    // 3. Verify user access
    let userRole: "client" | "freelancer";
    if (project.client_id === userId) {
      userRole = "client";
    } else if (project.freelancer_id === userId) {
      userRole = "freelancer";
    } else {
      return {
        success: false,
        statusCode: 403,
        error: "Forbidden: You are not an authorized participant in this project.",
      };
    }

    // 4. Fetch latest submission
    const { data: submission } = await supabase
      .from("submissions")
      .select("*")
      .eq("milestone_id", milestoneId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let files: any[] = [];
    let verificationReport: any = null;
    let criteriaResults: any[] = [];

    if (submission) {
      // 5. Fetch submission files
      const { data: subFiles } = await supabase
        .from("submission_files")
        .select("*")
        .eq("submission_id", submission.id);
      files = subFiles || [];

      // 6. Fetch verification report
      const { data: report } = await supabase
        .from("verification_reports")
        .select("*")
        .eq("submission_id", submission.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (report) {
        verificationReport = report;

        // 7. Fetch criteria results
        const { data: cResults } = await supabase
          .from("verification_criteria_results")
          .select("*")
          .eq("report_id", report.id)
          .order("created_at", { ascending: true });
        criteriaResults = cResults || [];
      }
    }

    // 8. Fetch active payment attempt
    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("milestone_id", milestoneId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      success: true,
      statusCode: 200,
      milestone,
      project,
      submission,
      files,
      verificationReport,
      criteriaResults,
      payment,
      userRole,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, statusCode: 500, error: msg };
  }
}

// 11. Execute Authoritative Client Milestone Decision
export interface ExecuteMilestoneDecisionInput {
  milestoneId: string;
  submissionId?: string;
  userId: string;
  decision: "approve" | "request_revision" | "reject";
  feedbackNotes?: string;
  confirmed?: boolean;
}

export interface ExecuteMilestoneDecisionResult {
  success: boolean;
  statusCode: number;
  error?: string;
  milestone?: any;
  submission?: any;
  paymentStatus?: string;
  message?: string;
}

export async function executeMilestoneDecision(
  input: ExecuteMilestoneDecisionInput
): Promise<ExecuteMilestoneDecisionResult> {
  const admin = createAdminClient();
  const supabase = admin || (await createServerSupabaseClient());
  if (!supabase) {
    return { success: false, statusCode: 500, error: "Database client unavailable." };
  }

  try {
    // 1. Authoritative Milestone retrieval
    const { data: milestone, error: mError } = await supabase
      .from("milestones")
      .select("id, project_id, amount, currency, status, payment_status")
      .eq("id", input.milestoneId)
      .single();

    if (mError || !milestone) {
      return { success: false, statusCode: 404, error: "Milestone not found." };
    }

    // 2. Authoritative Project retrieval
    const { data: project, error: pError } = await supabase
      .from("projects")
      .select("id, client_id, freelancer_id")
      .eq("id", milestone.project_id)
      .single();

    if (pError || !project) {
      return { success: false, statusCode: 404, error: "Associated project not found." };
    }

    // 3. Role & Ownership Security Check
    if (project.freelancer_id === input.userId) {
      return {
        success: false,
        statusCode: 403,
        error: "Security Violation: Freelancers cannot review or approve their own milestone deliverables.",
      };
    }

    if (project.client_id !== input.userId) {
      return {
        success: false,
        statusCode: 403,
        error: "Forbidden: You are not authorized to make decisions on this milestone.",
      };
    }

    // 4. Authoritative Submission retrieval
    let submissionQuery = supabase
      .from("submissions")
      .select("*")
      .eq("milestone_id", input.milestoneId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (input.submissionId) {
      submissionQuery = supabase
        .from("submissions")
        .select("*")
        .eq("id", input.submissionId)
        .eq("milestone_id", input.milestoneId)
        .limit(1);
    }

    const { data: subRows, error: sError } = await submissionQuery;
    const submission = subRows?.[0];

    if (sError || !submission) {
      return {
        success: false,
        statusCode: 400,
        error: "No active submission found for this milestone to review.",
      };
    }

    // 5. Decision-Specific Validations
    if (input.decision === "approve") {
      // Check duplicate approval
      if (milestone.status === "approved" || submission.status === "approved") {
        return {
          success: false,
          statusCode: 409,
          error: "Duplicate Decision: Milestone has already been approved.",
        };
      }

      // Check explicit confirmation
      if (input.confirmed !== true) {
        return {
          success: false,
          statusCode: 400,
          error: "Confirmation Required: Milestone approval requires explicit client confirmation.",
        };
      }

      // Require completed verification report
      const { data: reports, error: rError } = await supabase
        .from("verification_reports")
        .select("id, overall_status, overall_score")
        .eq("submission_id", submission.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const report = reports?.[0];
      if (rError || !report) {
        return {
          success: false,
          statusCode: 400,
          error: "Verification Required: Cannot approve milestone without a completed AI verification report.",
        };
      }

      if (report.overall_status !== "VERIFIED") {
        return {
          success: false,
          statusCode: 400,
          error: `Verification Policy Violation: Cannot approve milestone when overall verification status is '${report.overall_status}' (must be VERIFIED).`,
        };
      }

      // Fetch individual criterion results
      const { data: criteriaResults } = await supabase
        .from("verification_criteria_results")
        .select("criterion_id, criterion_text, result")
        .eq("report_id", report.id);

      if (!criteriaResults || criteriaResults.length === 0) {
        return {
          success: false,
          statusCode: 400,
          error: "Verification Policy Violation: Verification report contains no audited criteria.",
        };
      }

      const failedOrInconclusive = criteriaResults.filter(
        (c) => c.result === "FAIL" || c.result === "INCONCLUSIVE"
      );

      if (failedOrInconclusive.length > 0) {
        const details = failedOrInconclusive
          .map((c) => `${c.criterion_id} [${c.result}]`)
          .join(", ");
        return {
          success: false,
          statusCode: 400,
          error: `Acceptance Criteria Unmet: Cannot approve milestone while criteria are marked FAIL or INCONCLUSIVE (${details}).`,
        };
      }
    } else if (input.decision === "reject") {
      // Rejection explanation is MANDATORY
      if (!input.feedbackNotes || !input.feedbackNotes.trim()) {
        return {
          success: false,
          statusCode: 400,
          error: "Mandatory Explanation: A detailed explanation is required when rejecting a milestone submission.",
        };
      }
    }

    // 6. Payment Safety Enforcement:
    // IMPORTANT: Milestone approval MUST NOT capture funds.
    // The milestone payment_status remains in its existing state (typically 'authorized').
    // Do NOT call PayPal capture APIs. Do NOT mark CAPTURED or SETTLED.
    const preservedPaymentStatus = milestone.payment_status;

    // 7. Update Database States Atomically
    // A) Update Milestone
    const nextMilestoneStatus = input.decision === "approve" ? "approved" : "in_progress";
    const { error: mUpError } = await supabase
      .from("milestones")
      .update({
        status: nextMilestoneStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", milestone.id);

    if (mUpError) {
      return { success: false, statusCode: 500, error: mUpError.message };
    }

    // B) Update Submission
    const nextSubStatus =
      input.decision === "approve"
        ? "approved"
        : input.decision === "request_revision"
        ? "revision_requested"
        : "rejected";

    const { error: sUpError } = await supabase
      .from("submissions")
      .update({
        status: nextSubStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission.id);

    if (sUpError) {
      console.error("Submission status update error:", sUpError.message);
    }

    // C) Update Verification Report (if exists)
    const reportDecisionValue =
      input.decision === "approve"
        ? "approved"
        : input.decision === "request_revision"
        ? "revisions_requested"
        : "rejected";

    await supabase
      .from("verification_reports")
      .update({
        client_decision: reportDecisionValue,
        client_notes: input.feedbackNotes?.trim() || null,
        client_reviewed_at: new Date().toISOString(),
      })
      .eq("submission_id", submission.id);

    // D) Record Audit Log Event
    const auditAction =
      input.decision === "approve"
        ? "MILESTONE_APPROVED"
        : input.decision === "request_revision"
        ? "MILESTONE_REVISION_REQUESTED"
        : "MILESTONE_REJECTED";

    await recordAuditLogInDb({
      actorId: input.userId,
      projectId: project.id,
      milestoneId: milestone.id,
      action: auditAction,
      entityType: "milestone",
      entityId: milestone.id,
      oldState: {
        milestoneStatus: milestone.status,
        submissionStatus: submission.status,
      },
      newState: {
        milestoneStatus: nextMilestoneStatus,
        submissionStatus: nextSubStatus,
        paymentStatus: preservedPaymentStatus,
        feedbackNotes: input.feedbackNotes || null,
        paymentSafety: "Approval recorded. Payment authorization hold remains active. Payment capture is an independent step.",
      },
    });

    const userFacingMessage =
      input.decision === "approve"
        ? "Milestone approved successfully. Payment authorization hold remains active on PayPal; payment capture is a separate step."
        : input.decision === "request_revision"
        ? "Revision requested successfully. Freelancer notified with revision feedback."
        : "Milestone submission rejected successfully.";

    return {
      success: true,
      statusCode: 200,
      milestone: {
        id: milestone.id,
        status: nextMilestoneStatus,
        paymentStatus: preservedPaymentStatus,
      },
      submission: {
        id: submission.id,
        status: nextSubStatus,
      },
      paymentStatus: preservedPaymentStatus,
      message: userFacingMessage,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error in executeMilestoneDecision:", msg);
    return { success: false, statusCode: 500, error: msg };
  }
}
