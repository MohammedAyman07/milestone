"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useProjects } from "@/context/ProjectContext";
import { Project, Milestone } from "@/lib/types";
import { PayPalAuthorizeButton } from "@/components/PayPalAuthorizeButton";

export default function ProjectDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const {
    getProject,
    addMilestone,
    updateProjectBudget,
    activeRole,
    submissions,
    activeAuditReport,
    isLoaded,
  } = useProjects();
  const contextProject = getProject(id);
  const [remoteProject, setRemoteProject] = useState<Project | null>(null);
  const [isLoadingRemote, setIsLoadingRemote] = useState(!contextProject);
  const [notFoundState, setNotFoundState] = useState(false);

  useEffect(() => {
    if (!contextProject) {
      setIsLoadingRemote(true);
      fetch(`/api/projects?id=${id}`)
        .then((res) => res.json())
        .then((json) => {
          if (json.success && json.project) {
            setRemoteProject(json.project);
          } else {
            setNotFoundState(true);
          }
        })
        .catch(() => setNotFoundState(true))
        .finally(() => setIsLoadingRemote(false));
    }
  }, [id, contextProject]);

  const project: Project | undefined = contextProject || (remoteProject || undefined);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditBudgetOpen, setIsEditBudgetOpen] = useState(false);
  const [editBudgetValue, setEditBudgetValue] = useState("");
  const [editBudgetError, setEditBudgetError] = useState<string | null>(null);

  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAmount, setNewAmount] = useState("500");
  const [newDueDate, setNewDueDate] = useState("2026-12-10");
  const [newCriteria, setNewCriteria] = useState(
    "Component visual inspection passed\nDocumentation complete"
  );
  const [modalError, setModalError] = useState<string | null>(null);

  if (isLoadingRemote && !project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <span className="material-symbols-outlined text-[36px] animate-spin text-primary">progress_activity</span>
        <p className="font-body-md text-secondary">Loading project deliverables from database...</p>
      </div>
    );
  }

  if (!project && (notFoundState || isLoaded)) {
    notFound();
  }

  if (!project) {
    return null;
  }

  const completedMilestones = project.milestones.filter(
    (m) => m.status === "completed" || m.status === "approved"
  ).length;
  const progressPct = Math.round(
    (completedMilestones / (project.milestones.length || 1)) * 100
  );

  const totalAllocated = project.milestones.reduce((acc, m) => acc + m.amount, 0);

  const handleCreateMilestone = (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);

    if (!newTitle.trim()) {
      setModalError("Milestone title is required.");
      return;
    }

    const amountNum = parseFloat(newAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setModalError("Milestone amount must be a positive number.");
      return;
    }

    if (!newDueDate) {
      setModalError("Milestone target due date is required.");
      return;
    }

    const criteriaList = newCriteria
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((label, idx) => ({
        id: `crit-new-${Date.now()}-${idx}`,
        label,
        isPassed: false,
      }));

    if (criteriaList.length === 0) {
      setModalError("At least one measurable acceptance criterion is required.");
      return;
    }

    const result = addMilestone(project.id, {
      title: newTitle.trim(),
      description: newDesc.trim() || "Custom deliverable scope.",
      amount: amountNum,
      currency: project.currency,
      dueDate: newDueDate,
      status: "pending",
      paymentStatus: "unauthorized",
      acceptanceCriteria: criteriaList,
    });

    if (!result.success) {
      setModalError(result.error || "Failed to add milestone.");
      return;
    }

    setIsModalOpen(false);
    setNewTitle("");
    setNewDesc("");
    setModalError(null);
  };

  return (
    <div className="flex flex-col gap-space-lg w-full">
      {/* Breadcrumbs & Navigation */}
      <div className="flex flex-col gap-1">
        <nav className="flex items-center gap-2 text-on-surface-variant font-label-md text-label-md">
          <Link
            href="/projects"
            className="hover:text-primary transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[16px]">folder_open</span>
            <span>My Projects</span>
          </Link>
          <span className="material-symbols-outlined text-[14px] text-outline-variant">
            chevron_right
          </span>
          <span className="text-on-surface font-semibold truncate max-w-sm">
            {project.title}
          </span>
        </nav>
      </div>

      {/* Project Overview Banner Card */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60 flex flex-col gap-space-md">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-space-md">
          <div className="flex items-start gap-space-md">
            <div className="w-14 h-14 rounded-xl bg-surface-container-high overflow-hidden shrink-0 flex items-center justify-center shadow-xs">
              {project.image ? (
                // eslint-disable-next-js/no-img-element
                <img
                  className="w-full h-full object-cover"
                  alt={project.title}
                  src={project.image}
                />
              ) : (
                <span className="material-symbols-outlined text-primary text-[28px]">
                  folder
                </span>
              )}
            </div>
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-headline-md text-headline-md text-on-surface tracking-tight">
                  {project.title}
                </h1>
                <span className="px-2.5 py-0.5 rounded-full font-label-sm text-label-sm font-semibold bg-blue-50 text-blue-700">
                  {project.status === "in_progress" ? "In Progress" : project.status}
                </span>
                <span className="font-label-sm text-label-sm bg-surface-container-low px-2 py-0.5 rounded text-secondary font-mono">
                  Contract #{project.id.toUpperCase().slice(0, 10)}
                </span>
              </div>
              <p className="font-body-md text-body-md text-secondary mt-1 max-w-3xl">
                {project.description}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0 self-start lg:self-auto">
            {activeRole === "client" && (
              <button
                type="button"
                onClick={() => {
                  setModalError(null);
                  setIsModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-lg font-label-md text-label-md hover:bg-primary/90 transition-colors font-semibold shadow-xs"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Add Milestone</span>
              </button>
            )}
            <Link
              href="/submissions"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-surface-container-low hover:bg-surface-container rounded-lg font-label-md text-label-md text-on-surface transition-colors font-semibold"
            >
              <span className="material-symbols-outlined text-[18px]">upload</span>
              <span>Submit Deliverables</span>
            </Link>
          </div>
        </div>

        {/* 4 Metadata Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md pt-space-xs">
          <div className="p-space-md bg-surface-container-low rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-container-lowest flex items-center justify-center text-primary shadow-xs">
              <span className="material-symbols-outlined text-[22px]">payments</span>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                  Total Budget
                </span>
                {activeRole === "client" && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditBudgetValue(project.budget.toString());
                      setEditBudgetError(null);
                      setIsEditBudgetOpen(true);
                    }}
                    className="text-primary hover:underline text-[11px] font-medium"
                    title="Edit contract budget"
                  >
                    Edit
                  </button>
                )}
              </div>
              <span className="font-metric-display text-[22px] leading-tight text-on-surface font-semibold tabular-nums">
                ${project.budget.toLocaleString()} {project.currency}
              </span>
              <span className="font-label-sm text-label-sm text-secondary">
                ${totalAllocated.toLocaleString()} allocated ({Math.max(0, project.budget - totalAllocated).toLocaleString()} remaining)
              </span>
            </div>
          </div>

          <div className="p-space-md bg-surface-container-low rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-container-lowest flex items-center justify-center text-secondary shadow-xs">
              <span className="material-symbols-outlined text-[22px]">event</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                Target Deadline
              </span>
              <span className="font-title-md text-title-md text-on-surface font-semibold">
                {project.deadline}
              </span>
              <span className="font-label-sm text-label-sm text-secondary">
                Started {project.startDate}
              </span>
            </div>
          </div>

          <div className="p-space-md bg-surface-container-low rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-container-lowest flex items-center justify-center text-primary shadow-xs">
              <span className="material-symbols-outlined text-[22px]">person</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                Counterparty
              </span>
              <span className="font-title-md text-title-md text-on-surface font-semibold">
                {activeRole === "client" ? project.freelancer.name : project.client.name}
              </span>
              <span className="font-label-sm text-label-sm text-secondary truncate max-w-[150px]">
                {activeRole === "client" ? project.freelancer.role : project.client.role}
              </span>
            </div>
          </div>

          <div className="p-space-md bg-surface-container-low rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-container-lowest flex items-center justify-center text-emerald-600 shadow-xs">
              <span className="material-symbols-outlined text-[22px]">check_circle</span>
            </div>
            <div className="flex flex-col w-full">
              <div className="flex items-center justify-between">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                  Completion
                </span>
                <span className="font-label-sm text-label-sm text-on-surface font-semibold">
                  {progressPct}%
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-surface-container mt-1 overflow-hidden">
                <div
                  className="h-full bg-primary-container rounded-full"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Milestones List Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[22px]">flag</span>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            Contract Milestones ({project.milestones.length})
          </h2>
        </div>
        {activeRole === "client" && (
          <button
            type="button"
            onClick={() => {
              setModalError(null);
              setIsModalOpen(true);
            }}
            className="text-primary hover:underline font-label-md text-label-md flex items-center gap-1 font-medium"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>Create Milestone</span>
          </button>
        )}
      </div>

      {/* Milestones List Cards */}
      <div className="flex flex-col gap-space-md">
        {project.milestones.map((milestone) => {
          const isDone = milestone.status === "completed" || milestone.status === "approved";
          const milestoneSub = submissions?.find((s) => s.milestoneId === milestone.id);
          const isRevisionRequested =
            milestoneSub?.status === "revision_requested" ||
            (activeAuditReport?.milestoneId === milestone.id &&
              activeAuditReport?.clientDecision === "revisions_requested");
          const revisionFeedback =
            (activeAuditReport?.milestoneId === milestone.id && activeAuditReport?.clientNotes) ||
            "Please review the acceptance criteria feedback and submit updated deliverables.";

          const isReview =
            !isDone &&
            !isRevisionRequested &&
            (milestone.status === "under_review" ||
              milestone.status === "submitted" ||
              milestoneSub?.status === "submitted" ||
              milestoneSub?.status === "under_review");

          return (
            <div
              key={milestone.id}
              className={`bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border flex flex-col gap-space-md ${
                isRevisionRequested
                  ? "border-amber-300/80 bg-amber-50/10"
                  : isDone
                  ? "border-emerald-200/80"
                  : "border-surface-container-low/70"
              }`}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-md pb-space-xs border-b border-surface-container-low">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-label-md ${
                      isDone
                        ? "bg-emerald-50 text-emerald-700"
                        : isRevisionRequested
                        ? "bg-amber-100 text-amber-800"
                        : isReview
                        ? "bg-amber-50 text-amber-700"
                        : "bg-surface-container-high text-primary"
                    }`}
                  >
                    M{milestone.phase}
                  </div>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <h3 className="font-title-md text-title-md text-on-surface">
                        {milestone.title}
                      </h3>
                      <span
                        className={`font-label-sm text-label-sm px-2.5 py-0.5 rounded-full font-semibold ${
                          isDone
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : isRevisionRequested
                            ? "bg-amber-100 text-amber-800 border border-amber-300"
                            : isReview
                            ? "bg-amber-50 text-amber-700 border border-amber-200"
                            : "bg-blue-50 text-blue-700"
                        }`}
                      >
                        {isDone
                          ? "Approved by Client"
                          : isRevisionRequested
                          ? "Revision Requested"
                          : isReview
                          ? "Under AI Review"
                          : "In Progress"}
                      </span>
                    </div>
                    <span className="font-body-sm text-body-sm text-secondary">
                      {milestone.description}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-space-lg shrink-0">
                  <div className="flex flex-col md:items-end">
                    <span className="font-label-sm text-label-sm text-secondary uppercase">
                      Payout Value
                    </span>
                    <span className="font-metric-display text-[22px] leading-tight text-on-surface font-semibold tabular-nums">
                      ${milestone.amount.toFixed(2)} USD
                    </span>
                    <span className="font-label-sm text-label-sm text-secondary">
                      Due: {milestone.dueDate}
                    </span>
                  </div>

                  {/* Contextual Actions */}
                  <div className="flex items-center gap-2">
                    {isRevisionRequested ? (
                      <Link
                        href={`/submissions?milestoneId=${milestone.id}`}
                        className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-label-md text-label-md transition-colors flex items-center gap-1 font-semibold shadow-xs"
                      >
                        <span className="material-symbols-outlined text-[16px]">refresh</span>
                        <span>Re-submit Deliverables</span>
                      </Link>
                    ) : isReview ? (
                      <Link
                        href={`/verification?milestoneId=${milestone.id}`}
                        className="px-3.5 py-2 bg-primary text-white rounded-lg font-label-md text-label-md hover:bg-primary/90 transition-colors flex items-center gap-1 font-semibold shadow-xs"
                      >
                        <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                        <span>Inspect Review</span>
                      </Link>
                    ) : isDone ? (
                      <Link
                        href={`/verification?milestoneId=${milestone.id}`}
                        className="px-3.5 py-2 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg font-label-md text-label-md flex items-center gap-1 hover:bg-emerald-100 font-semibold"
                      >
                        <span className="material-symbols-outlined text-[16px]">verified</span>
                        <span>View Approval</span>
                      </Link>
                    ) : activeRole === "freelancer" ? (
                      <Link
                        href="/submissions"
                        className="px-3.5 py-2 bg-primary-container text-white rounded-lg font-label-md text-label-md hover:bg-primary transition-colors flex items-center gap-1 font-semibold"
                      >
                        <span className="material-symbols-outlined text-[16px]">upload</span>
                        <span>Submit Work</span>
                      </Link>
                    ) : milestone.paymentStatus === "authorized" ? (
                      <div className="px-3.5 py-2 bg-blue-50 border border-blue-200 text-primary rounded-lg font-label-md text-label-md flex items-center gap-1.5 font-semibold">
                        <span className="material-symbols-outlined text-[16px]">lock</span>
                        <span>Authorized Hold</span>
                      </div>
                    ) : (
                      <PayPalAuthorizeButton
                        milestoneId={milestone.id}
                        projectId={project.id}
                        amount={milestone.amount}
                        currency={project.currency}
                      />
                    )}
                  </div>
                </div>
              </div>

              {/* Revision Requested Feedback Callout */}
              {isRevisionRequested && (
                <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-body-sm flex items-start gap-2.5">
                  <span className="material-symbols-outlined text-amber-700 text-[20px] shrink-0 mt-0.5">
                    assignment_late
                  </span>
                  <div className="flex flex-col gap-1">
                    <span className="font-semibold text-amber-900">
                      Client Revision Instructions:
                    </span>
                    <p className="text-amber-800 text-xs leading-relaxed">
                      {revisionFeedback}
                    </p>
                  </div>
                </div>
              )}

              {/* Approved by Client Notice */}
              {isDone && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900 text-body-sm flex items-start gap-2.5">
                  <span className="material-symbols-outlined text-emerald-700 text-[20px] shrink-0 mt-0.5">
                    task_alt
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-emerald-900">
                      Approved by Client
                    </span>
                    <p className="text-emerald-800 text-xs leading-relaxed">
                      Deliverables verified and accepted. Payment authorization hold (${milestone.amount.toFixed(2)} USD) remains securely active on PayPal. Payment capture is pending final release.
                    </p>
                  </div>
                </div>
              )}

              {/* Acceptance Criteria Sub-checklist */}
              <div className="flex flex-col gap-2 pt-1">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                  Measurable Acceptance Criteria
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {milestone.acceptanceCriteria.map((c) => (
                    <div
                      key={c.id}
                      className="p-2.5 bg-surface-container-low/60 rounded-lg flex items-start gap-2 border border-surface-container-high/40"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] shrink-0 mt-0.5 ${
                          c.isPassed ? "text-emerald-600" : "text-outline"
                        }`}
                      >
                        {c.isPassed ? "check_circle" : "radio_button_unchecked"}
                      </span>
                      <div className="flex flex-col">
                        <span className="font-body-sm text-body-sm text-on-surface font-medium">
                          {c.label}
                        </span>
                        {c.description && (
                          <span className="font-label-sm text-label-sm text-secondary">
                            {c.description}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Milestone Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl max-w-lg w-full p-space-lg shadow-xl border border-surface-container-high flex flex-col gap-space-md animate-fade-in">
            <div className="flex items-center justify-between pb-space-xs border-b border-surface-container-low">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[22px]">add_circle</span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface">
                  Create New Milestone Scope
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-secondary hover:text-on-surface p-1"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {modalError && (
              <div className="p-3 rounded-lg bg-error-container/30 border border-error/20 text-error font-body-sm text-body-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">error</span>
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateMilestone} className="flex flex-col gap-4">
              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1">
                  Milestone Scope Title <span className="text-error">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Phase 4: Security Audit & Penetration Testing"
                  className="w-full h-10 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none border border-surface-container-high/60"
                />
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Briefly describe the deliverables for this milestone..."
                  className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none border border-surface-container-high/60"
                />
              </div>

              <div className="grid grid-cols-2 gap-space-md">
                <div>
                  <label className="block font-label-md text-label-md text-on-surface mb-1">
                    Amount ($ USD) <span className="text-error">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    className="w-full h-10 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none border border-surface-container-high/60"
                  />
                </div>

                <div>
                  <label className="block font-label-md text-label-md text-on-surface mb-1">
                    Due Date <span className="text-error">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={newDueDate}
                    onChange={(e) => setNewDueDate(e.target.value)}
                    className="w-full h-10 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none border border-surface-container-high/60"
                  />
                </div>
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1">
                  Acceptance Criteria (one per line) <span className="text-error">*</span>
                </label>
                <textarea
                  rows={3}
                  value={newCriteria}
                  onChange={(e) => setNewCriteria(e.target.value)}
                  placeholder="e.g. Unit tests pass with 90% coverage..."
                  className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none font-mono text-sm border border-surface-container-high/60"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-surface-container-low">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface font-body-md text-body-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 font-title-md text-title-md font-semibold"
                >
                  Save Milestone
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Budget Modal */}
      {isEditBudgetOpen && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl max-w-sm w-full p-space-lg shadow-xl border border-surface-container-high flex flex-col gap-space-md animate-fade-in">
            <div className="flex items-center justify-between pb-space-xs border-b border-surface-container-low">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[22px]">payments</span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface">
                  Edit Contract Budget
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsEditBudgetOpen(false)}
                className="text-secondary hover:text-on-surface p-1"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {editBudgetError && (
              <div className="p-3 rounded-lg bg-error-container/30 border border-error/20 text-error font-body-sm text-body-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">error</span>
                <span>{editBudgetError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const val = parseFloat(editBudgetValue);
                if (isNaN(val) || val <= 0) {
                  setEditBudgetError("Budget must be a positive number.");
                  return;
                }
                const res = updateProjectBudget(project.id, val);
                if (!res.success) {
                  setEditBudgetError(res.error || "Cannot update budget.");
                  return;
                }
                setIsEditBudgetOpen(false);
              }}
              className="flex flex-col gap-4"
            >
              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1">
                  Agreed Project Budget ($ USD)
                </label>
                <input
                  type="number"
                  min="1"
                  required
                  value={editBudgetValue}
                  onChange={(e) => setEditBudgetValue(e.target.value)}
                  className="w-full h-10 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none border border-surface-container-high/60"
                />
                <span className="text-secondary text-[11px] mt-1 block">
                  Must be at least ${totalAllocated.toLocaleString()} to cover existing milestones.
                </span>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-surface-container-low">
                <button
                  type="button"
                  onClick={() => setIsEditBudgetOpen(false)}
                  className="px-4 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface font-body-md text-body-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 font-title-md text-title-md font-semibold"
                >
                  Update Budget
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
