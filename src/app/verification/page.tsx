"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useProjects } from "@/context/ProjectContext";
import { CriterionStatus, EvidenceQuality } from "@/lib/types";

function VerificationPageContent() {
  const searchParams = useSearchParams();
  const queryMilestoneId = searchParams.get("milestoneId");

  const {
    activeAuditReport,
    updateAuditClientDecision,
    activeRole,
    projects,
  } = useProjects();

  const [activeTab, setActiveTab] = useState<"repo" | "lighthouse" | "figma" | "tests">("repo");

  // Modals state
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);

  const [showCaptureModal, setShowCaptureModal] = useState(false);
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [revisionNotes, setRevisionNotes] = useState("");

  const [showRejectionModal, setShowRejectionModal] = useState(false);
  const [rejectionNotes, setRejectionNotes] = useState("");
  const [rejectionError, setRejectionError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Authoritative API Data State
  const [apiData, setApiData] = useState<{
    milestone?: any;
    project?: any;
    submission?: any;
    files?: any[];
    verificationReport?: any;
    criteriaResults?: any[];
    payment?: any;
    userRole?: "client" | "freelancer";
  } | null>(null);
  const [isLoadingApiData, setIsLoadingApiData] = useState(false);

  // Fetch authoritative review details if queryMilestoneId is provided
  useEffect(() => {
    if (!queryMilestoneId) return;

    let isMounted = true;
    async function loadAuthoritativeDetails() {
      setIsLoadingApiData(true);
      try {
        const res = await fetch(`/api/milestones/decision?milestoneId=${queryMilestoneId}`);
        const data = await res.json();
        if (isMounted && res.ok && data.success) {
          setApiData(data);
        }
      } catch (err) {
        console.error("Failed to load authoritative milestone review details:", err);
      } finally {
        if (isMounted) setIsLoadingApiData(false);
      }
    }

    loadAuthoritativeDetails();
    return () => {
      isMounted = false;
    };
  }, [queryMilestoneId]);

  // Fallbacks from context
  const defaultProject = apiData?.project || projects[0];
  const targetMilestone =
    apiData?.milestone ||
    defaultProject?.milestones?.find((m: { id: string }) => m.id === queryMilestoneId) ||
    defaultProject?.milestones?.[1] ||
    defaultProject?.milestones?.[0];

  const effectiveReport = apiData?.verificationReport || activeAuditReport;
  const overallStatus = effectiveReport?.overall_status || effectiveReport?.overallStatus || "NEEDS_EVIDENCE";
  const modelName = effectiveReport?.model_used || effectiveReport?.modelUsed || "gemini-2.5-flash";

  const effectiveCriteria: Array<{
    criterionId: string;
    criterionText: string;
    result: CriterionStatus;
    explanation: string;
    evidenceReferences: string[];
    missingEvidence?: string;
    demonstratedScenarios?: string[];
    unverifiedScenarios?: string[];
    failureType?: string;
    confidenceScore: number;
    evidenceQuality: EvidenceQuality;
    recommendedAction: string;
  }> =
    apiData?.criteriaResults && apiData.criteriaResults.length > 0
      ? apiData.criteriaResults.map((c: any) => ({
          criterionId: c.criterion_id,
          criterionText: c.criterion_text,
          result: c.result as CriterionStatus,
          explanation: c.explanation,
          evidenceReferences: c.evidence_references || [],
          missingEvidence: c.missing_evidence,
          demonstratedScenarios: c.demonstrated_scenarios || c.demonstratedScenarios || [],
          unverifiedScenarios: c.unverified_scenarios || c.unverifiedScenarios || [],
          failureType: c.failure_type || c.failureType || "NONE",
          confidenceScore: c.confidence_score,
          evidenceQuality: c.evidence_quality as EvidenceQuality,
          recommendedAction: c.recommended_action,
        }))
      : (activeAuditReport?.criteriaResults as any) || [];

  // Check if any criteria are FAIL or INCONCLUSIVE
  const unmetCriteria = effectiveCriteria.filter(
    (c) => c.result === "FAIL" || c.result === "INCONCLUSIVE"
  );
  const hasUnmetCriteria = unmetCriteria.length > 0;
  const isEligibleForApproval = !hasUnmetCriteria && overallStatus === "VERIFIED";

  // Decision Handler
  const handleDecision = async (
    decision: "approve" | "request_revision" | "reject",
    notes?: string
  ) => {
    setIsSubmitting(true);
    setActionFeedback(null);

    const milestoneId = targetMilestone?.id || queryMilestoneId;
    const submissionId = apiData?.submission?.id;

    try {
      // 1. Submit to authoritative server-side API route
      if (milestoneId) {
        const response = await fetch("/api/milestones/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            milestoneId,
            submissionId,
            decision,
            feedbackNotes: notes,
            confirmed: decision === "approve" ? approvalConfirmed : undefined,
          }),
        });

        const result = await response.json();

        if (!response.ok) {
          setActionFeedback({
            type: "error",
            message: result.error || "Failed to submit decision.",
          });
          setIsSubmitting(false);
          return;
        }

        setActionFeedback({
          type: "success",
          message:
            result.message ||
            (decision === "approve"
              ? "Milestone approved! Payment authorization hold remains active on PayPal; payment capture is a separate step."
              : decision === "request_revision"
              ? "Revision request sent to freelancer."
              : "Submission rejected with explanation."),
        });
      }

      // 2. Also update local context for instantaneous UI reaction
      if (activeAuditReport) {
        updateAuditClientDecision(
          activeAuditReport.id,
          decision === "approve"
            ? "approved"
            : decision === "request_revision"
            ? "revisions_requested"
            : "rejected",
          notes
        );
      }

      // Close all modals
      setShowApprovalModal(false);
      setShowRevisionModal(false);
      setShowRejectionModal(false);
      setApprovalConfirmed(false);
      setRejectionNotes("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionFeedback({
        type: "error",
        message: `Network error: ${msg}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Capture Handler: Executes POST /api/paypal/capture
  const handleCapture = async () => {
    setIsCapturing(true);
    setActionFeedback(null);

    const paymentAttemptId = apiData?.payment?.payment_attempt_id;
    const milestoneId = targetMilestone?.id || queryMilestoneId;

    if (!paymentAttemptId) {
      setActionFeedback({
        type: "error",
        message: "No active payment authorization found for this milestone to capture.",
      });
      setIsCapturing(false);
      return;
    }

    try {
      const response = await fetch("/api/paypal/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentAttemptId,
          milestoneId,
          confirmed: captureConfirmed,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        setActionFeedback({
          type: "error",
          message: result.error || "Capture request failed.",
        });
        setIsCapturing(false);
        return;
      }

      setActionFeedback({
        type: "success",
        message:
          result.message ||
          `Payment of $${Number(milestoneAmount).toFixed(2)} USD successfully captured! Standard PayPal merchant capture pays the merchant account.`,
      });

      setShowCaptureModal(false);
      setCaptureConfirmed(false);

      // Refresh data
      if (queryMilestoneId) {
        const refreshRes = await fetch(`/api/milestones/decision?milestoneId=${queryMilestoneId}`);
        const refreshData = await refreshRes.json();
        if (refreshRes.ok && refreshData.success) {
          setApiData(refreshData);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionFeedback({
        type: "error",
        message: `Capture network error: ${msg}`,
      });
    } finally {
      setIsCapturing(false);
    }
  };

  const currentRole = apiData?.userRole || activeRole;
  const milestoneAmount = targetMilestone?.amount || 500;
  const milestoneCurrency = targetMilestone?.currency || "USD";

  const isApproved =
    targetMilestone?.status === "approved" ||
    targetMilestone?.status === "completed" ||
    effectiveReport?.clientDecision === "approved";

  const paymentStatus =
    apiData?.payment?.status ||
    targetMilestone?.paymentStatus ||
    targetMilestone?.payment_status ||
    "authorized";

  const isCaptured =
    paymentStatus === "CAPTURED" ||
    paymentStatus === "captured" ||
    paymentStatus === "SETTLED";

  const isCapturePending =
    paymentStatus === "CAPTURE_PENDING" ||
    paymentStatus === "capture_pending";

  const isAuthorized =
    paymentStatus === "AUTHORIZED" ||
    paymentStatus === "authorized";

  const requiresReconciliation = apiData?.payment?.manual_reconciliation_required === true;

  if (!targetMilestone && !isLoadingApiData) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 bg-surface-container-lowest rounded-xl border border-surface-container-low text-center">
        <span className="material-symbols-outlined text-secondary text-[40px]">fact_check</span>
        <h2 className="font-headline-sm text-headline-sm text-on-surface">No Milestone Selected for Review</h2>
        <p className="font-body-md text-secondary max-w-md">
          Select a submitted milestone from your project to inspect its automated criteria audit report and approve release.
        </p>
        <Link
          href="/projects"
          className="px-4 py-2 bg-primary text-white rounded-lg font-label-md font-semibold hover:bg-primary/90 transition-colors shadow-xs"
        >
          View Projects
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-lg w-full">
      {/* Top Utility Context & Breadcrumbs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm">
        <div className="flex items-center gap-2">
          <Link
            href="/projects"
            className="font-body-sm text-body-sm text-secondary hover:text-on-surface transition-colors"
          >
            Projects
          </Link>
          <span className="material-symbols-outlined text-[14px] text-outline-variant">
            chevron_right
          </span>
          <Link
            href={`/projects/${defaultProject?.id}`}
            className="font-body-sm text-body-sm text-secondary hover:text-on-surface transition-colors"
          >
            {defaultProject?.title || "Project"}
          </Link>
          <span className="material-symbols-outlined text-[14px] text-outline-variant">
            chevron_right
          </span>
          <span className="font-body-sm text-body-sm text-on-surface font-semibold">
            Milestone Review Console
          </span>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-secondary-container text-on-secondary-container ml-1">
            {modelName}
          </span>
        </div>

        <div className="flex items-center gap-space-sm">
          <span className="font-label-sm text-label-sm text-secondary">
            Authorized Hold:
          </span>
          <span className="font-label-md text-label-md text-on-surface font-semibold tabular-nums">
            ${Number(milestoneAmount).toFixed(2)} {milestoneCurrency}
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-outline-variant" />
          <span className="font-label-sm text-label-sm text-secondary">
            Due: {targetMilestone?.dueDate || "Nov 20, 2026"}
          </span>
        </div>
      </div>

      {/* Action Feedback Banner */}
      {actionFeedback && (
        <div
          className={`p-space-md rounded-xl border font-body-sm text-body-sm flex items-center justify-between animate-fade-in ${
            actionFeedback.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : actionFeedback.type === "error"
              ? "bg-error/10 border-error/20 text-error"
              : "bg-blue-50 border-blue-200 text-blue-800"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px]">
              {actionFeedback.type === "success"
                ? "check_circle"
                : actionFeedback.type === "error"
                ? "error"
                : "info"}
            </span>
            <span>{actionFeedback.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            className="hover:opacity-75"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Header Banner & Legal Notice */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col lg:flex-row lg:items-center justify-between gap-space-md">
        <div className="flex flex-col gap-1 max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-headline-md text-headline-md text-on-surface tracking-tight">
              Milestone Deliverable Review
            </h1>

            {/* Standardized Report-Level Status */}
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-label-md font-label-md font-semibold ${
                overallStatus === "VERIFIED"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : overallStatus === "FAILED"
                  ? "bg-error/10 text-error border border-error/20"
                  : "bg-amber-50 text-amber-700 border border-amber-200"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  overallStatus === "VERIFIED"
                    ? "bg-emerald-600"
                    : overallStatus === "FAILED"
                    ? "bg-error"
                    : "bg-amber-600 animate-pulse"
                }`}
              />
              {overallStatus === "VERIFIED"
                ? "VERIFIED • ALL CRITERIA PASSED"
                : overallStatus === "FAILED"
                ? "FAILED • CRITERIA UNMET"
                : "NEEDS EVIDENCE • INCONCLUSIVE"}
            </span>

            {effectiveReport?.overall_evidence_quality && (
              <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-surface-container text-on-surface-variant border border-surface-container-high/60">
                Evidence Quality: {effectiveReport.overall_evidence_quality}
              </span>
            )}
          </div>
          <p className="font-body-md text-body-md text-on-surface-variant">
            {effectiveReport?.executive_summary ||
              effectiveReport?.executiveSummary ||
              "Multi-modal AI audit evaluated submitted deliverables against agreed contract acceptance criteria."}
          </p>
        </div>

        {/* Institutional Advisory Notice */}
        <div className="bg-surface-container-low rounded-lg p-space-sm pl-space-md flex items-start gap-space-sm max-w-md border border-surface-container-high/60">
          <span className="material-symbols-outlined text-primary text-[22px] mt-0.5">
            shield_person
          </span>
          <div className="flex flex-col">
            <span className="font-label-md text-label-md text-on-surface font-semibold">
              Payment Safety Notice
            </span>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Approval records deliverable acceptance. Approval does <strong>NOT</strong> capture funds. The payment authorization hold remains active on PayPal; payment capture is an independent step.
            </p>
          </div>
        </div>
      </div>

      {/* Main 2-Column Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
        {/* LEFT COLUMN: Acceptance Criteria Audit (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-space-md">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-space-xs">
              <span className="material-symbols-outlined text-primary text-[20px]">
                fact_check
              </span>
              <h2 className="font-title-md text-title-md text-on-surface font-semibold">
                Acceptance Criteria Audit
              </h2>
              <span className="ml-2 font-label-sm text-label-sm bg-surface-container px-2 py-0.5 rounded text-on-surface-variant font-medium">
                {effectiveCriteria.filter((c) => c.result === "PASS").length} of{" "}
                {effectiveCriteria.length} Passed
              </span>
            </div>
            {hasUnmetCriteria && (
              <span className="font-label-sm text-label-sm text-error font-semibold flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">warning</span>
                Approval Blocked
              </span>
            )}
          </div>

          {/* Criteria Cards */}
          <div className="flex flex-col gap-space-sm">
            {effectiveCriteria.map((crit, idx) => {
              const isPass = crit.result === "PASS";
              const isFail = crit.result === "FAIL";

              return (
                <div
                  key={crit.criterionId || idx}
                  className={`bg-surface-container-lowest rounded-xl p-space-md shadow-sm border transition-all ${
                    isPass
                      ? "border-surface-container-low/70"
                      : isFail
                      ? "border-error/30 bg-error/5"
                      : "border-amber-200 bg-amber-50/20"
                  }`}
                >
                  <div className="flex items-start justify-between gap-space-sm">
                    <div className="flex items-start gap-space-sm">
                      <div className="w-8 h-8 rounded-lg bg-surface-container-low flex items-center justify-center shrink-0 mt-0.5 text-primary">
                        <span className="material-symbols-outlined text-[18px]">
                          {idx === 0 ? "palette" : idx === 1 ? "speed" : idx === 2 ? "devices" : "code"}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-secondary font-semibold">
                            {crit.criterionId.toUpperCase()}
                          </span>
                          <span className="font-body-md text-body-md text-on-surface font-semibold">
                            {crit.criterionText}
                          </span>
                        </div>
                        <p className="font-body-sm text-body-sm text-on-surface-variant mt-1 leading-relaxed">
                          {crit.explanation}
                        </p>

                        {/* Missing evidence warning if present */}
                        {crit.missingEvidence && (
                          <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[16px] text-amber-600">
                              info
                            </span>
                            <span>
                              <strong>Missing Evidence:</strong> {crit.missingEvidence}
                            </span>
                          </div>
                        )}

                        {/* Multi-Scenario Breakdown */}
                        {crit.demonstratedScenarios && crit.demonstratedScenarios.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            <span className="text-[11px] text-emerald-800 font-medium">Demonstrated:</span>
                            {crit.demonstratedScenarios.map((sc, sIdx) => (
                              <span
                                key={sIdx}
                                className="px-2 py-0.5 bg-emerald-50 text-emerald-800 rounded text-[11px] border border-emerald-200"
                              >
                                ✓ {sc}
                              </span>
                            ))}
                          </div>
                        )}

                        {crit.unverifiedScenarios && crit.unverifiedScenarios.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                            <span className="text-[11px] text-amber-800 font-medium">Unverified:</span>
                            {crit.unverifiedScenarios.map((sc, sIdx) => (
                              <span
                                key={sIdx}
                                className="px-2 py-0.5 bg-amber-50 text-amber-800 rounded text-[11px] border border-amber-200"
                              >
                                ? {sc}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Evidence References */}
                        {crit.evidenceReferences && crit.evidenceReferences.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            <span className="text-[11px] text-secondary font-medium">
                              Evidence:
                            </span>
                            {crit.evidenceReferences.map((ref, rIdx) => (
                              <span
                                key={rIdx}
                                className="px-2 py-0.5 bg-surface-container-low text-secondary rounded text-[11px] font-mono border border-surface-container-high/40"
                              >
                                {ref}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          isPass
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : isFail
                            ? "bg-error/10 text-error border border-error/20"
                            : "bg-amber-50 text-amber-700 border border-amber-200"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {isPass ? "check_circle" : isFail ? "cancel" : "help"}
                        </span>
                        {crit.result}
                      </span>
                      <span className="text-[11px] text-secondary font-mono">
                        {crit.confidenceScore}% confidence
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT COLUMN: Submitted Evidence & Decision Gate (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-space-md">
          {/* Freelancer Submitted Evidence Panel */}
          <div className="bg-surface-container-lowest rounded-xl p-space-md shadow-sm border border-surface-container-low/70 flex flex-col gap-space-sm">
            <div className="flex items-center justify-between pb-2 border-b border-surface-container-low">
              <span className="font-label-md text-label-md font-semibold text-on-surface flex items-center gap-1.5">
                <span className="material-symbols-outlined text-primary text-[18px]">
                  folder_open
                </span>
                Freelancer Deliverables
              </span>
              <span className="text-secondary text-[11px]">
                {apiData?.files?.length || 3} files attached
              </span>
            </div>

            {/* Navigation tabs */}
            <div className="flex bg-surface-container-low p-1 rounded-lg">
              <button
                type="button"
                onClick={() => setActiveTab("repo")}
                className={`flex-1 py-1 px-2 rounded-md font-label-md text-label-md transition-all ${
                  activeTab === "repo"
                    ? "bg-surface-container-lowest text-primary font-semibold shadow-xs"
                    : "text-secondary hover:text-on-surface"
                }`}
              >
                GitHub
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("lighthouse")}
                className={`flex-1 py-1 px-2 rounded-md font-label-md text-label-md transition-all ${
                  activeTab === "lighthouse"
                    ? "bg-surface-container-lowest text-primary font-semibold shadow-xs"
                    : "text-secondary hover:text-on-surface"
                }`}
              >
                Lighthouse
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("figma")}
                className={`flex-1 py-1 px-2 rounded-md font-label-md text-label-md transition-all ${
                  activeTab === "figma"
                    ? "bg-surface-container-lowest text-primary font-semibold shadow-xs"
                    : "text-secondary hover:text-on-surface"
                }`}
              >
                Figma Map
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("tests")}
                className={`flex-1 py-1 px-2 rounded-md font-label-md text-label-md transition-all ${
                  activeTab === "tests"
                    ? "bg-surface-container-lowest text-primary font-semibold shadow-xs"
                    : "text-secondary hover:text-on-surface"
                }`}
              >
                Tests
              </button>
            </div>

            {/* Tab Panels */}
            <div className="bg-surface-container-low/70 rounded-lg p-3 font-mono text-body-sm text-on-surface border border-surface-container-high/50 min-h-[160px] overflow-x-auto">
              {activeTab === "repo" && (
                <div>
                  <div className="text-secondary text-[12px] pb-1 border-b border-surface-container-high">
                    commit 4a89f28d • author: Sarah Chen &lt;sarah.chen@designstudio.io&gt;
                  </div>
                  <pre className="text-[12px] leading-relaxed pt-2 text-on-surface">
{`+ // Tailwind CSS Fluid Token Configuration
+ @theme {
+   --color-primary: #0058b2;
+   --color-surface-container: #e8edff;
+ }
+ export function ResponsiveShell({ children }) {
+   return <div className="max-w-7xl mx-auto px-4">{children}</div>;
+ }`}
                  </pre>
                </div>
              )}

              {activeTab === "lighthouse" && (
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-emerald-700 font-semibold text-[13px]">
                    <span>Performance: 98/100</span>
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  </div>
                  <div className="flex justify-between items-center text-emerald-700 font-semibold text-[13px]">
                    <span>Accessibility: 100/100</span>
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  </div>
                  <div className="flex justify-between items-center text-emerald-700 font-semibold text-[13px]">
                    <span>Best Practices: 96/100</span>
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  </div>
                  <div className="text-[11px] text-secondary pt-1 border-t border-surface-container-high">
                    Audit target: https://staging.acmecorp-redesign.com (Mobile &amp; Desktop)
                  </div>
                </div>
              )}

              {activeTab === "figma" && (
                <div className="text-[12px] space-y-1">
                  <span className="text-secondary block">Variable Sets Validated (Acme V3):</span>
                  <div className="text-emerald-700 font-semibold">✓ 18 Spacing Tokens Matched</div>
                  <div className="text-emerald-700 font-semibold">✓ 24 Color Semantic Aliases Resolved</div>
                  <div className="text-emerald-700 font-semibold">✓ 0 Unlinked References</div>
                </div>
              )}

              {activeTab === "tests" && (
                <div className="text-[12px] space-y-1">
                  <div className="text-emerald-700 font-semibold">PASS src/components/ResponsiveGrid.test.tsx (24 passed)</div>
                  <div className="text-emerald-700 font-semibold">PASS src/components/Navigation.test.tsx (12 passed)</div>
                  <div className="text-secondary text-[11px] pt-1">Test Suites: 2 passed, 2 total • 36 tests passing</div>
                </div>
              )}
            </div>
          </div>

          {/* Client Action Card */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
            <div>
              <div className="flex items-center justify-between">
                <span className="font-label-md text-label-md uppercase tracking-wider text-secondary font-semibold">
                  Client Decision Gate
                </span>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                  Hold Active: ${Number(milestoneAmount).toFixed(2)} USD
                </span>
              </div>
              <h3 className="font-headline-sm text-headline-sm text-on-surface mt-1">
                Milestone Acceptance &amp; Sign-Off
              </h3>
              <p className="font-body-sm text-body-sm text-secondary mt-1">
                Approving this deliverable confirms acceptance of the completed milestone scope. Funds remain in PayPal authorization hold and are NOT captured automatically.
              </p>
            </div>

            {hasUnmetCriteria && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-body-sm flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] text-amber-600 mt-0.5">
                  warning
                </span>
                <span>
                  Approval is blocked because one or more criteria are <strong>FAIL</strong> or <strong>INCONCLUSIVE</strong>. You may request revisions or reject the submission.
                </span>
              </div>
            )}

            {currentRole === "client" ? (
              <div className="flex flex-col gap-3">
                {isApproved ? (
                  // MILESTONE IS APPROVED: SHOW PAYMENT CAPTURE LIFECYCLE
                  isCaptured ? (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-emerald-900 flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-emerald-600 text-[20px]">task_alt</span>
                          Payment Captured
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-200 text-emerald-800">
                          ${Number(milestoneAmount).toFixed(2)} {milestoneCurrency}
                        </span>
                      </div>
                      <p className="text-xs text-emerald-800 leading-relaxed">
                        Payment has been successfully captured via PayPal Payments v2. Standard PayPal merchant capture pays the receiving merchant account.
                      </p>
                      {apiData?.payment?.capture_id && (
                        <span className="text-[11px] font-mono text-emerald-700">
                          Capture ID: {apiData.payment.capture_id}
                        </span>
                      )}
                    </div>
                  ) : isCapturePending ? (
                    <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-amber-900 flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-amber-600 text-[20px]">refresh</span>
                          Capture Pending
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-200 text-amber-800">
                          ${Number(milestoneAmount).toFixed(2)} {milestoneCurrency}
                        </span>
                      </div>
                      <p className="text-xs text-amber-800 leading-relaxed">
                        PayPal capture has been initiated and is awaiting settlement or reconciliation. You can click below to reconcile status.
                      </p>
                      <button
                        type="button"
                        disabled={isCapturing}
                        onClick={() => handleCapture()}
                        className="w-full py-2.5 px-3 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-1.5"
                      >
                        <span className="material-symbols-outlined text-[18px]">sync</span>
                        <span>{isCapturing ? "Reconciling..." : "Reconcile / Retry Capture"}</span>
                      </button>
                    </div>
                  ) : (
                    // AUTHORIZED HOLD READY FOR CAPTURE
                    <div className="flex flex-col gap-2.5">
                      <div className="p-3 bg-emerald-50/70 border border-emerald-200/70 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
                        <span className="material-symbols-outlined text-emerald-600 text-[18px]">verified</span>
                        <span>Milestone deliverables approved. Payment authorization hold is ready for capture.</span>
                      </div>

                      <button
                        type="button"
                        disabled={isCapturing}
                        onClick={() => {
                          setCaptureConfirmed(false);
                          setShowCaptureModal(true);
                        }}
                        className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-title-md text-title-md font-semibold rounded-lg transition-all shadow-sm flex items-center justify-center gap-2"
                      >
                        <span className="material-symbols-outlined text-[20px]">payments</span>
                        <span>Capture Payment (${Number(milestoneAmount).toFixed(2)} {milestoneCurrency})</span>
                      </button>
                    </div>
                  )
                ) : (
                  // MILESTONE PENDING APPROVAL: SHOW REVIEW DECISION BUTTONS
                  <div className="flex flex-col gap-2">
                    {/* 1. APPROVE BUTTON */}
                    <button
                      type="button"
                      disabled={!isEligibleForApproval || isSubmitting}
                      onClick={() => setShowApprovalModal(true)}
                      className={`w-full py-3 px-4 font-title-md text-title-md font-semibold rounded-lg transition-all shadow-sm flex items-center justify-center gap-2 ${
                        isEligibleForApproval && !isSubmitting
                          ? "bg-primary text-white hover:bg-primary/90"
                          : "bg-surface-container-high text-secondary cursor-not-allowed"
                      }`}
                    >
                      <span className="material-symbols-outlined text-[20px]">check_circle</span>
                      <span>Approve Milestone</span>
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      {/* 2. REQUEST REVISIONS BUTTON */}
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => setShowRevisionModal(true)}
                        className="py-2.5 px-3 bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-label-md rounded-lg transition-colors text-center font-medium"
                      >
                        Request Revisions
                      </button>

                      {/* 3. REJECT SUBMISSION BUTTON */}
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => {
                          setRejectionError(null);
                          setShowRejectionModal(true);
                        }}
                        className="py-2.5 px-3 bg-error/10 hover:bg-error/20 text-error font-label-md text-label-md rounded-lg transition-colors text-center font-semibold"
                      >
                        Reject Submission
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-3 bg-surface-container-low rounded-lg text-body-sm text-secondary">
                You are currently viewing as <strong>Freelancer</strong>. Payment capture and milestone review actions are restricted to the project owner client.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODAL 1: EXPLICIT APPROVAL CONFIRMATION MODAL */}
      {showApprovalModal && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl max-w-lg w-full p-space-lg shadow-xl border border-surface-container-high flex flex-col gap-space-md animate-scale-in">
            <div className="flex items-center justify-between pb-2 border-b border-surface-container-low">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-600 text-[24px]">
                  verified
                </span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                  Confirm Milestone Approval
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowApprovalModal(false);
                  setApprovalConfirmed(false);
                }}
                className="text-secondary hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div className="flex flex-col gap-3 text-body-sm text-on-surface">
              <p>
                You are about to approve <strong>{targetMilestone?.title || "Milestone Deliverables"}</strong> for the project <strong>{defaultProject?.title}</strong>.
              </p>

              <div className="p-3 bg-surface-container-low rounded-xl border border-surface-container-high/60 flex flex-col gap-1.5">
                <div className="flex justify-between text-xs text-secondary">
                  <span>Milestone Amount:</span>
                  <span className="font-bold text-on-surface tabular-nums">
                    ${Number(milestoneAmount).toFixed(2)} {milestoneCurrency}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-secondary">
                  <span>AI Verification Result:</span>
                  <span className="font-bold text-emerald-700">VERIFIED (All criteria passed)</span>
                </div>
                <div className="flex justify-between text-xs text-secondary">
                  <span>PayPal Status:</span>
                  <span className="font-bold text-blue-700">AUTHORIZATION HOLD ACTIVE</span>
                </div>
              </div>

              {/* Explicit Payment Safety Callout */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-blue-900 text-xs flex items-start gap-2">
                <span className="material-symbols-outlined text-primary text-[18px] shrink-0 mt-0.5">
                  info
                </span>
                <div>
                  <strong>Important Payment Safety Policy:</strong>
                  <p className="mt-0.5 text-blue-800">
                    Approving this milestone records deliverable acceptance. It does <strong>NOT</strong> capture funds. The payment authorization hold ($ {Number(milestoneAmount).toFixed(2)} {milestoneCurrency}) remains held in PayPal until a separate capture step is authorized.
                  </p>
                </div>
              </div>

              {/* Explicit Confirmation Checkbox */}
              <label className="flex items-start gap-2.5 p-2 rounded-lg bg-surface-container-low cursor-pointer hover:bg-surface-container transition-colors">
                <input
                  type="checkbox"
                  checked={approvalConfirmed}
                  onChange={(e) => setApprovalConfirmed(e.target.checked)}
                  className="mt-1 w-4 h-4 text-primary rounded border-outline focus:ring-primary"
                />
                <span className="text-xs text-on-surface font-medium leading-relaxed">
                  I explicitly confirm that I have reviewed the submitted code, files, and AI audit report, and accept the deliverables for this milestone.
                </span>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-surface-container-low">
              <button
                type="button"
                onClick={() => {
                  setShowApprovalModal(false);
                  setApprovalConfirmed(false);
                }}
                className="px-4 py-2 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md hover:bg-surface-container transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!approvalConfirmed || isSubmitting}
                onClick={() => handleDecision("approve")}
                className={`px-4 py-2 rounded-lg font-title-md text-title-md font-semibold transition-all ${
                  approvalConfirmed && !isSubmitting
                    ? "bg-primary text-white hover:bg-primary/90"
                    : "bg-surface-container-high text-secondary cursor-not-allowed"
                }`}
              >
                {isSubmitting ? "Processing..." : "Confirm & Approve Deliverables"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 1B: EXPLICIT PAYMENT CAPTURE CONFIRMATION MODAL */}
      {showCaptureModal && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl max-w-lg w-full p-space-lg shadow-xl border border-surface-container-high flex flex-col gap-space-md animate-scale-in">
            <div className="flex items-center justify-between pb-2 border-b border-surface-container-low">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-600 text-[24px]">
                  payments
                </span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                  Confirm Payment Capture
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCaptureModal(false);
                  setCaptureConfirmed(false);
                }}
                className="text-secondary hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div className="flex flex-col gap-3 text-body-sm text-on-surface">
              <p>
                You are executing a PayPal payment capture for the approved milestone: <strong>{targetMilestone?.title || "Deliverables"}</strong>.
              </p>

              <div className="p-3 bg-surface-container-low rounded-xl border border-surface-container-high/60 flex flex-col gap-1.5">
                <div className="flex justify-between text-xs text-secondary">
                  <span>Authoritative Amount:</span>
                  <span className="font-bold text-on-surface tabular-nums">
                    ${Number(milestoneAmount).toFixed(2)} {milestoneCurrency}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-secondary">
                  <span>PayPal Method:</span>
                  <span className="font-mono text-[11px] text-on-surface">POST /v2/payments/authorizations/&#123;id&#125;/capture</span>
                </div>
                <div className="flex justify-between text-xs text-secondary">
                  <span>Milestone Acceptance Status:</span>
                  <span className="font-bold text-emerald-700">APPROVED BY CLIENT</span>
                </div>
              </div>

              {/* Standard Merchant Capture Disclaimer */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-blue-900 text-xs flex items-start gap-2">
                <span className="material-symbols-outlined text-primary text-[18px] shrink-0 mt-0.5">
                  info
                </span>
                <div>
                  <strong>Merchant Capture Notice:</strong>
                  <p className="mt-0.5 text-blue-800 leading-relaxed">
                    Standard PayPal merchant capture requests capture of the existing authorization hold and pays the merchant receiving the transaction. Capture does not automatically pay the freelancer or provide an escrow service.
                  </p>
                </div>
              </div>

              {/* Explicit Confirmation Checkbox */}
              <label className="flex items-start gap-2.5 p-2 rounded-lg bg-surface-container-low cursor-pointer hover:bg-surface-container transition-colors">
                <input
                  type="checkbox"
                  checked={captureConfirmed}
                  onChange={(e) => setCaptureConfirmed(e.target.checked)}
                  className="mt-1 w-4 h-4 text-primary rounded border-outline focus:ring-primary"
                />
                <span className="text-xs text-on-surface font-medium leading-relaxed">
                  I explicitly confirm and authorize capture of ${Number(milestoneAmount).toFixed(2)} {milestoneCurrency} against the PayPal payment authorization.
                </span>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-surface-container-low">
              <button
                type="button"
                onClick={() => {
                  setShowCaptureModal(false);
                  setCaptureConfirmed(false);
                }}
                className="px-4 py-2 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md hover:bg-surface-container transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!captureConfirmed || isCapturing}
                onClick={() => handleCapture()}
                className={`px-4 py-2 rounded-lg font-title-md text-title-md font-semibold transition-all ${
                  captureConfirmed && !isCapturing
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-surface-container-high text-secondary cursor-not-allowed"
                }`}
              >
                {isCapturing ? "Capturing..." : "Confirm & Capture Payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: REQUEST REVISIONS MODAL */}
      {showRevisionModal && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl max-w-md w-full p-space-lg shadow-xl border border-surface-container-high flex flex-col gap-space-md animate-scale-in">
            <div className="flex items-center justify-between pb-2 border-b border-surface-container-low">
              <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                Request Revisions
              </h3>
              <button
                type="button"
                onClick={() => setShowRevisionModal(false)}
                className="text-secondary hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1">
                Feedback Notes for Freelancer
              </label>
              <textarea
                rows={4}
                value={revisionNotes}
                onChange={(e) => setRevisionNotes(e.target.value)}
                placeholder="Specify which criteria need additional work or what missing evidence is required..."
                className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none border border-surface-container-high/60"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRevisionModal(false)}
                className="px-4 py-2 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md hover:bg-surface-container"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleDecision("request_revision", revisionNotes)}
                className="px-4 py-2 rounded-lg bg-primary text-white font-title-md text-title-md font-semibold hover:bg-primary/90"
              >
                {isSubmitting ? "Sending..." : "Send Revision Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: REJECT SUBMISSION MODAL (MANDATORY EXPLANATION) */}
      {showRejectionModal && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl max-w-md w-full p-space-lg shadow-xl border border-surface-container-high flex flex-col gap-space-md animate-scale-in">
            <div className="flex items-center justify-between pb-2 border-b border-surface-container-low">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-error text-[22px]">
                  gavel
                </span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                  Reject Deliverable Package
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowRejectionModal(false)}
                className="text-secondary hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1">
                Mandatory Explanation <span className="text-error">*</span>
              </label>
              <textarea
                rows={4}
                value={rejectionNotes}
                onChange={(e) => {
                  setRejectionNotes(e.target.value);
                  if (rejectionError && e.target.value.trim()) {
                    setRejectionError(null);
                  }
                }}
                placeholder="Explain the specific reasons for rejecting this deliverable package (mandatory)..."
                className={`w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:outline-none border ${
                  rejectionError
                    ? "border-error focus:ring-error"
                    : "border-surface-container-high/60 focus:ring-primary"
                }`}
              />
              {rejectionError && (
                <span className="text-error text-xs mt-1 block">
                  {rejectionError}
                </span>
              )}
            </div>

            <p className="text-xs text-secondary leading-relaxed">
              Rejecting this submission closes the current deliverable package. The freelancer will be notified with your mandatory explanation.
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRejectionModal(false)}
                className="px-4 py-2 rounded-lg bg-surface-container-low text-on-surface font-body-md text-body-md hover:bg-surface-container"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  if (!rejectionNotes.trim()) {
                    setRejectionError("A detailed explanation is required to reject a submission.");
                    return;
                  }
                  handleDecision("reject", rejectionNotes.trim());
                }}
                className="px-4 py-2 rounded-lg bg-error text-white font-title-md text-title-md font-semibold hover:bg-error/90"
              >
                {isSubmitting ? "Rejecting..." : "Confirm Rejection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VerificationPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-secondary">Loading verification console...</div>}>
      <VerificationPageContent />
    </Suspense>
  );
}
