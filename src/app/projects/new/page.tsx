"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";

export default function CreateProjectPage() {
  const router = useRouter();
  const { refreshProjects } = useProjects();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("1000");
  const [currency] = useState("USD");
  const [startDate, setStartDate] = useState("2026-11-10");
  const [deadline, setDeadline] = useState("2026-12-15");

  // Freelancer details
  const [freelancerName, setFreelancerName] = useState("Sarah Chen");
  const [freelancerEmail, setFreelancerEmail] = useState("sarah.chen@designstudio.io");
  const [freelancerRole, setFreelancerRole] = useState("Senior Frontend Engineer");

  // Initial milestone
  const [milestoneTitle, setMilestoneTitle] = useState("Phase 1: Architecture & UI Setup");
  const [milestoneAmount, setMilestoneAmount] = useState("500");
  const [milestoneDueDate, setMilestoneDueDate] = useState("2026-11-25");
  const [milestoneCriteria, setMilestoneCriteria] = useState(
    "Responsive components deployed to staging\nLighthouse score >= 90\nClean git commits"
  );

  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  const [aiAnalysisError, setAiAnalysisError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<{
    ambiguousRequirements: string[];
    missingInformation: string[];
    scopeContradictions: string[];
    deliverables: string[];
    suggestedMilestones: {
      title: string;
      description: string;
      suggestedAmount: number;
      suggestedDeadline?: string;
      acceptanceCriteria: string[];
    }[];
  } | null>(null);

  const handleRunAiAnalysis = async () => {
    setAiAnalysisError(null);
    if (!description.trim()) {
      setAiAnalysisError("Please write a project description before running AI Contract Analysis.");
      return;
    }

    setIsAiAnalyzing(true);
    try {
      const res = await fetch("/api/gemini/analyze-contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          totalBudget: parseFloat(budget) || 1000,
          deadline,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Analysis request failed");
      }

      setAiSuggestions(data.analysis);

      // Pre-fill initial milestone if suggestions exist
      if (data.analysis.suggestedMilestones && data.analysis.suggestedMilestones[0]) {
        const first = data.analysis.suggestedMilestones[0];
        setMilestoneTitle(first.title);
        setMilestoneAmount(first.suggestedAmount.toString());
        if (first.acceptanceCriteria && first.acceptanceCriteria.length > 0) {
          setMilestoneCriteria(first.acceptanceCriteria.join("\n"));
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "AI analysis error";
      setAiAnalysisError(msg);
    } finally {
      setIsAiAnalyzing(false);
    }
  };

  const validate = () => {
    const errs: { [key: string]: string } = {};

    if (!title.trim()) {
      errs.title = "Project title is required.";
    }

    if (!description.trim()) {
      errs.description = "Project description is required.";
    }

    const numBudget = parseFloat(budget);
    if (isNaN(numBudget) || numBudget <= 0) {
      errs.budget = "Total budget must be a positive number greater than 0.";
    }

    if (!deadline) {
      errs.deadline = "Target deadline is required.";
    } else if (startDate && new Date(deadline) < new Date(startDate)) {
      errs.deadline = "Deadline cannot be earlier than start date.";
    }

    if (!freelancerName.trim()) {
      errs.freelancerName = "Freelancer name is required.";
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!freelancerEmail.trim()) {
      errs.freelancerEmail = "Freelancer email is required.";
    } else if (!emailRegex.test(freelancerEmail.trim())) {
      errs.freelancerEmail = "Must be a valid email address.";
    }

    const numMilestoneAmount = parseFloat(milestoneAmount);
    if (isNaN(numMilestoneAmount) || numMilestoneAmount <= 0) {
      errs.milestoneAmount = "Milestone amount must be greater than 0.";
    } else if (!isNaN(numBudget) && numMilestoneAmount > numBudget) {
      errs.milestoneAmount = "Milestone amount cannot exceed total project budget.";
    }

    const parsedCriteria = milestoneCriteria
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);

    if (parsedCriteria.length === 0) {
      errs.milestoneCriteria = "At least one measurable acceptance criterion is required.";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;

    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const criteriaList = milestoneCriteria
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((label, idx) => ({
          code: `AC-${idx + 1}`,
          label,
          description: label,
        }));

      const numBudget = parseFloat(budget);
      const numMilestoneAmount = parseFloat(milestoneAmount);

      const payload = {
        action: "create_project",
        projectData: {
          title: title.trim(),
          description: description.trim(),
          budget: numBudget,
          currency,
          startDate,
          deadline,
          freelancerName: freelancerName.trim(),
          freelancerEmail: freelancerEmail.trim(),
          freelancerRole: freelancerRole.trim(),
          initialMilestones: [
            {
              phase: 1,
              title: milestoneTitle.trim(),
              description: "Initial deliverable contract scope.",
              amount: numMilestoneAmount,
              currency,
              dueDate: milestoneDueDate,
              criteria: criteriaList,
            },
          ],
        },
      };

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to create project in database.");
      }

      // Refresh project list from Supabase-backed API
      await refreshProjects();

      // Navigate to the newly created project only after confirmed database success
      router.push(`/projects/${data.projectId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred while saving the project.";
      setServerError(msg);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-space-lg max-w-4xl mx-auto w-full">
      {/* Header & Breadcrumbs */}
      <div className="flex flex-col gap-1">
        <nav className="flex items-center gap-2 text-on-surface-variant font-label-md text-label-md">
          <Link href="/projects" className="hover:text-primary transition-colors flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">folder_open</span>
            <span>My Projects</span>
          </Link>
          <span className="material-symbols-outlined text-[14px] text-outline-variant">chevron_right</span>
          <span className="text-primary font-semibold">Create Project</span>
        </nav>
        <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight mt-1">
          Create New Project Contract
        </h1>
        <p className="font-body-md text-body-md text-secondary">
          Define your project scope, contract budget, and initial verifiable milestone.
        </p>
      </div>

      {serverError && (
        <div className="p-space-md rounded-xl bg-error/10 border border-error/20 text-error flex items-start gap-space-sm shadow-xs">
          <span className="material-symbols-outlined text-error text-[20px] shrink-0 mt-0.5">
            error
          </span>
          <div className="flex flex-col">
            <span className="font-title-sm text-title-sm font-semibold">
              Project Creation Failed
            </span>
            <span className="font-body-sm text-body-sm mt-0.5">
              {serverError}
            </span>
          </div>
        </div>
      )}

      {Object.keys(errors).length > 0 && (
        <div className="p-space-md rounded-xl bg-error-container/30 border border-error/20 text-on-surface flex items-start gap-space-sm">
          <span className="material-symbols-outlined text-error text-[20px] shrink-0 mt-0.5">
            error
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="font-title-md text-title-md text-error font-semibold">
              Please correct the following errors:
            </span>
            <ul className="list-disc list-inside text-body-sm text-error/90 font-medium">
              {Object.values(errors).map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-space-lg">
        {/* Section 1: Project Overview */}
        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60 flex flex-col gap-space-md">
          <div className="flex items-center gap-2 pb-space-xs border-b border-surface-container-low">
            <span className="w-2.5 h-2.5 rounded-full bg-primary" />
            <h2 className="font-title-md text-title-md text-on-surface">1. Project Overview &amp; Budget</h2>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="project-title">
                Project Title <span className="text-error">*</span>
              </label>
              <input
                id="project-title"
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errors.title) setErrors((prev) => ({ ...prev, title: "" }));
                }}
                placeholder="e.g. Next.js Mobile Banking App"
                className={`w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                  errors.title ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                }`}
              />
              {errors.title && <p className="font-body-sm text-body-sm text-error mt-1">{errors.title}</p>}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block font-label-md text-label-md text-on-surface" htmlFor="project-desc">
                  Project Description <span className="text-error">*</span>
                </label>
                <button
                  type="button"
                  onClick={handleRunAiAnalysis}
                  disabled={isAiAnalyzing}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary-fixed text-on-primary-fixed hover:bg-primary-container hover:text-white font-label-sm text-label-sm font-semibold transition-all shadow-xs disabled:opacity-50"
                  title="Run Gemini 3.8 Flash contract scope & milestone analysis"
                >
                  <span className="material-symbols-outlined text-[15px]">
                    {isAiAnalyzing ? "progress_activity" : "auto_awesome"}
                  </span>
                  <span>{isAiAnalyzing ? "Gemini Analyzing..." : "AI Contract Analysis"}</span>
                </button>
              </div>
              <textarea
                id="project-desc"
                rows={3}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  if (errors.description) setErrors((prev) => ({ ...prev, description: "" }));
                }}
                placeholder="Describe project deliverables, expected outcomes, and technical stack..."
                className={`w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                  errors.description ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                }`}
              />
              {errors.description && <p className="font-body-sm text-body-sm text-error mt-1">{errors.description}</p>}
            </div>

            {aiAnalysisError && (
              <div className="p-3 rounded-lg bg-error-container/30 border border-error/20 text-error font-body-sm text-body-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">warning</span>
                <span>AI Analysis: {aiAnalysisError}</span>
              </div>
            )}

            {aiSuggestions && (
              <div className="p-space-md rounded-xl bg-blue-50/70 border border-blue-200/80 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-primary text-[20px]">psychology</span>
                    <span className="font-title-md text-title-md text-on-surface font-semibold">
                      Gemini Contract Analysis Suggestions
                    </span>
                  </div>
                  <span className="font-label-sm text-label-sm text-secondary bg-white px-2 py-0.5 rounded border border-blue-200">
                    AI-Assisted Guidance
                  </span>
                </div>

                {aiSuggestions.ambiguousRequirements.length > 0 && (
                  <div>
                    <span className="font-label-sm text-label-sm uppercase font-semibold text-amber-800 block">
                      Ambiguous Requirements To Clarify:
                    </span>
                    <ul className="list-disc list-inside text-body-sm text-amber-900 mt-0.5">
                      {aiSuggestions.ambiguousRequirements.map((amb, i) => (
                        <li key={i}>{amb}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {aiSuggestions.missingInformation.length > 0 && (
                  <div>
                    <span className="font-label-sm text-label-sm uppercase font-semibold text-secondary block">
                      Missing Information Needed:
                    </span>
                    <ul className="list-disc list-inside text-body-sm text-secondary mt-0.5">
                      {aiSuggestions.missingInformation.map((info, i) => (
                        <li key={i}>{info}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="font-label-sm text-label-sm text-secondary italic">
                  Suggested milestones have been prepared below. Review and adjust values before submitting.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="project-budget">
                  Total Budget ({currency}) <span className="text-error">*</span>
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-3 text-secondary font-mono">$</span>
                  <input
                    id="project-budget"
                    type="number"
                    value={budget}
                    onChange={(e) => {
                      setBudget(e.target.value);
                      if (errors.budget) setErrors((prev) => ({ ...prev, budget: "" }));
                    }}
                    placeholder="1000"
                    min="1"
                    className={`w-full h-11 pl-8 pr-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                      errors.budget ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                    }`}
                  />
                </div>
                {errors.budget && <p className="font-body-sm text-body-sm text-error mt-1">{errors.budget}</p>}
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="project-start">
                  Start Date
                </label>
                <input
                  id="project-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border border-surface-container-high/60"
                />
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="project-deadline">
                  Target Deadline <span className="text-error">*</span>
                </label>
                <input
                  id="project-deadline"
                  type="date"
                  value={deadline}
                  onChange={(e) => {
                    setDeadline(e.target.value);
                    if (errors.deadline) setErrors((prev) => ({ ...prev, deadline: "" }));
                  }}
                  className={`w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                    errors.deadline ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                  }`}
                />
                {errors.deadline && <p className="font-body-sm text-body-sm text-error mt-1">{errors.deadline}</p>}
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Assigned Freelancer */}
        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60 flex flex-col gap-space-md">
          <div className="flex items-center gap-2 pb-space-xs border-b border-surface-container-low">
            <span className="w-2.5 h-2.5 rounded-full bg-secondary-container" />
            <h2 className="font-title-md text-title-md text-on-surface">2. Counterparty &amp; Freelancer Assignment</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="freelancer-name">
                Freelancer Name <span className="text-error">*</span>
              </label>
              <input
                id="freelancer-name"
                type="text"
                value={freelancerName}
                onChange={(e) => {
                  setFreelancerName(e.target.value);
                  if (errors.freelancerName) setErrors((prev) => ({ ...prev, freelancerName: "" }));
                }}
                placeholder="Sarah Chen"
                className={`w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                  errors.freelancerName ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                }`}
              />
              {errors.freelancerName && <p className="font-body-sm text-body-sm text-error mt-1">{errors.freelancerName}</p>}
            </div>

            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="freelancer-email">
                Freelancer Email <span className="text-error">*</span>
              </label>
              <input
                id="freelancer-email"
                type="email"
                value={freelancerEmail}
                onChange={(e) => {
                  setFreelancerEmail(e.target.value);
                  if (errors.freelancerEmail) setErrors((prev) => ({ ...prev, freelancerEmail: "" }));
                }}
                placeholder="sarah.chen@designstudio.io"
                className={`w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                  errors.freelancerEmail ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                }`}
              />
              {errors.freelancerEmail && <p className="font-body-sm text-body-sm text-error mt-1">{errors.freelancerEmail}</p>}
            </div>

            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="freelancer-role">
                Specialization / Role
              </label>
              <input
                id="freelancer-role"
                type="text"
                value={freelancerRole}
                onChange={(e) => setFreelancerRole(e.target.value)}
                placeholder="Senior Frontend Engineer"
                className="w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border border-surface-container-high/60"
              />
            </div>
          </div>
        </div>

        {/* Section 3: Initial Milestone */}
        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60 flex flex-col gap-space-md">
          <div className="flex items-center justify-between pb-space-xs border-b border-surface-container-low">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-primary-fixed" />
              <h2 className="font-title-md text-title-md text-on-surface">3. Initial Verifiable Milestone (Phase 1)</h2>
            </div>
            <span className="font-label-sm text-label-sm bg-primary-fixed text-on-primary-fixed px-2 py-0.5 rounded-full font-semibold">
              First Payout Scope
            </span>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
              <div className="sm:col-span-2">
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="milestone-title">
                  Milestone Scope Title <span className="text-error">*</span>
                </label>
                <input
                  id="milestone-title"
                  type="text"
                  value={milestoneTitle}
                  onChange={(e) => setMilestoneTitle(e.target.value)}
                  className="w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border border-surface-container-high/60"
                  required
                />
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="milestone-amount">
                  Milestone Amount ($) <span className="text-error">*</span>
                </label>
                <input
                  id="milestone-amount"
                  type="number"
                  value={milestoneAmount}
                  onChange={(e) => {
                    setMilestoneAmount(e.target.value);
                    if (errors.milestoneAmount) setErrors((prev) => ({ ...prev, milestoneAmount: "" }));
                  }}
                  min="1"
                  className={`w-full h-11 px-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                    errors.milestoneAmount ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                  }`}
                />
                {errors.milestoneAmount && <p className="font-body-sm text-body-sm text-error mt-1">{errors.milestoneAmount}</p>}
              </div>
            </div>

            <div>
              <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="milestone-criteria">
                Measurable Acceptance Criteria (one per line) <span className="text-error">*</span>
              </label>
              <textarea
                id="milestone-criteria"
                rows={3}
                value={milestoneCriteria}
                onChange={(e) => {
                  setMilestoneCriteria(e.target.value);
                  if (errors.milestoneCriteria) setErrors((prev) => ({ ...prev, milestoneCriteria: "" }));
                }}
                placeholder="e.g. Responsive components deployed to staging..."
                className={`w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border font-mono text-sm ${
                  errors.milestoneCriteria ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                }`}
              />
              {errors.milestoneCriteria && <p className="font-body-sm text-body-sm text-error mt-1">{errors.milestoneCriteria}</p>}
              <p className="font-body-sm text-body-sm text-secondary mt-1">
                AI verification analyzes submitted deliverables against these explicit criteria before alerting the client.
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-space-sm">
          <Link
            href="/projects"
            className="px-5 py-2.5 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface font-body-md text-body-md transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-6 py-2.5 rounded-lg bg-primary text-white hover:bg-primary/90 font-title-md text-title-md font-semibold transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
                <span>Creating Project...</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[18px]">check</span>
                <span>Create Project Contract</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
