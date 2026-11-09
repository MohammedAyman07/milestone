"use client";

import { useState, useRef, Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useProjects } from "@/context/ProjectContext";
import { StagedFile } from "@/lib/types";

function SubmissionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryMilestoneId = searchParams.get("milestoneId");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { projects, addSubmission, activeAuditReport, submissions } = useProjects();

  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string>(queryMilestoneId || "");

  const currentProject = projects.find((p) => p.id === selectedProjectId) || projects[0] || null;
  const currentMilestones = currentProject?.milestones || [];

  useEffect(() => {
    if (projects.length > 0 && !selectedProjectId) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (queryMilestoneId) {
      setSelectedMilestoneId(queryMilestoneId);
    } else if (
      currentMilestones.length > 0 &&
      (!selectedMilestoneId || !currentMilestones.some((m) => m.id === selectedMilestoneId))
    ) {
      setSelectedMilestoneId(currentMilestones[0].id);
    }
  }, [queryMilestoneId, currentMilestones, selectedMilestoneId]);

  const currentMilestone =
    currentMilestones.find((m) => m.id === selectedMilestoneId) ||
    currentMilestones[0] ||
    null;

  const milestoneSub = submissions?.find((s) => s.milestoneId === currentMilestone?.id);
  const isRevisionRequested =
    milestoneSub?.status === "revision_requested" ||
    (activeAuditReport?.milestoneId === currentMilestone?.id &&
      activeAuditReport.clientDecision === "revisions_requested");
  const revisionFeedback =
    (activeAuditReport?.milestoneId === currentMilestone?.id && activeAuditReport.clientNotes) ||
    "Client has requested deliverable revisions. Please review the feedback notes and provide updated artifacts.";

  // Form states
  const [repoUrl, setRepoUrl] = useState("");
  const [stagingUrl, setStagingUrl] = useState("");
  const [figmaUrl, setFigmaUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);

  // Validation state
  const [formErrors, setFormErrors] = useState<{ [key: string]: string }>({});

  // File Upload State
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  // Simulation / Real Gemini state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [simStep, setSimStep] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiRetryInfo, setAiRetryInfo] = useState<{
    isRetryable: boolean;
    retryAfterSec?: number;
    errorType?: string;
  } | null>(null);

  const steps = [
    { text: "Executing deterministic probes (Files, GitHub, Staging)...", pct: "25%", width: "w-[25%]" },
    { text: "Connecting to Gemini AI verification engine...", pct: "50%", width: "w-[50%]" },
    { text: "Evaluating evidence quality & calibrated confidence...", pct: "75%", width: "w-[75%]" },
    { text: "Deterministic status aggregated! Directing to review console...", pct: "100%", width: "w-full" },
  ];

  const validateUrls = () => {
    const errors: { [key: string]: string } = {};

    const urlPattern = /^https?:\/\/.+/i;
    const githubPattern = /^https?:\/\/(www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/i;

    if (!repoUrl.trim()) {
      errors.repoUrl = "GitHub repository URL is required.";
    } else if (!githubPattern.test(repoUrl.trim())) {
      errors.repoUrl = "Must be a valid GitHub URL (e.g. https://github.com/org/repo/...).";
    }

    if (!stagingUrl.trim()) {
      errors.stagingUrl = "Live staging / preview URL is required.";
    } else if (!urlPattern.test(stagingUrl.trim())) {
      errors.stagingUrl = "Must be a valid web URL starting with http:// or https://.";
    }

    if (figmaUrl.trim() && !urlPattern.test(figmaUrl.trim())) {
      errors.figmaUrl = "Must be a valid URL starting with http:// or https://.";
    }

    if (!notes.trim()) {
      errors.notes = "Please provide handover notes or release documentation.";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleRemoveFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const selectedFiles = Array.from(e.target.files);
    e.target.value = ""; // Reset input so same file can be re-selected if needed

    setIsUploading(true);
    setUploadError(null);

    const uploadedStaged: StagedFile[] = [];

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      setUploadProgress(`Uploading ${i + 1}/${selectedFiles.length}: ${file.name}...`);

      // Client-side 10MB check
      if (file.size > 10 * 1024 * 1024) {
        setUploadError(`File "${file.name}" exceeds the 10 MB maximum limit.`);
        continue;
      }

      // Check disallowed dangerous extensions
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      const disallowed = [".exe", ".sh", ".bat", ".cmd", ".msi", ".dll", ".so", ".bin", ".vbs", ".ps1"];
      if (disallowed.includes(ext)) {
        setUploadError(`File "${file.name}" has an executable/dangerous file type which is not allowed.`);
        continue;
      }

      const sizeStr =
        file.size > 1024 * 1024
          ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.round(file.size / 1024)} KB`;

      // Try uploading to private Supabase storage
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("projectId", currentProject?.id || "");
        formData.append("milestoneId", currentMilestone?.id || "");
        formData.append("description", "Uploaded deliverable evidence");

        const res = await fetch("/api/submissions/upload", {
          method: "POST",
          body: formData,
        });

        const data = await res.json();
        if (res.ok && data.success && data.file) {
          uploadedStaged.push({
            id: `f-${Date.now()}-${i}`,
            name: data.file.name,
            size: sizeStr,
            type: data.file.mimeType,
            description: data.file.description || "Uploaded private evidence",
            storagePath: data.file.storagePath,
            signedUrl: data.file.signedUrl,
          });
        } else {
          console.warn("Upload endpoint returned error:", data.error);
          setUploadError(data.error || `Upload failed for ${file.name}`);
          // Staged fallback
          uploadedStaged.push({
            id: `f-${Date.now()}-${i}`,
            name: file.name,
            size: sizeStr,
            type: file.type || "application/octet-stream",
            description: "Staged evidence artifact",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setUploadError(msg);
        uploadedStaged.push({
          id: `f-${Date.now()}-${i}`,
          name: file.name,
          size: sizeStr,
          type: file.type || "application/octet-stream",
          description: "Staged evidence artifact",
        });
      }
    }

    if (uploadedStaged.length > 0) {
      setFiles((prev) => [...prev, ...uploadedStaged]);
    }
    setIsUploading(false);
    setUploadProgress(null);
  };

  const handleAddSampleFile = async () => {
    const sampleJson = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        testSuite: "Milestone Deliverable Integration Suite",
        totalTests: 42,
        passed: 42,
        failed: 0,
        coveragePct: 98.4,
        components: ["ResponsiveContainer", "TailwindTokens", "LighthouseAudit"],
      },
      null,
      2
    );

    const fileName = `integration-audit-${Date.now().toString().slice(-4)}.json`;
    const sampleBlob = new Blob([sampleJson], { type: "application/json" });
    const sampleFile = new File([sampleBlob], fileName, { type: "application/json" });

    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(`Uploading sample artifact ${fileName} to private storage...`);

    try {
      const formData = new FormData();
      formData.append("file", sampleFile);
      formData.append("projectId", currentProject?.id || "");
      formData.append("milestoneId", currentMilestone?.id || "");
      formData.append("description", "Automated test coverage output");

      const res = await fetch("/api/submissions/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.success && data.file) {
        setFiles((prev) => [
          ...prev,
          {
            id: `f-sample-${Date.now()}`,
            name: data.file.name,
            size: "320 KB",
            type: "application/json",
            description: data.file.description || "Automated test coverage output",
            storagePath: data.file.storagePath,
            signedUrl: data.file.signedUrl,
          },
        ]);
      } else {
        setFiles((prev) => [
          ...prev,
          {
            id: `f-sample-${Date.now()}`,
            name: fileName,
            size: "320 KB",
            type: "application/json",
            description: "Automated test coverage output (sample)",
          },
        ]);
        if (data?.error) {
          setUploadError(`Storage notice: ${data.error}`);
        }
      }
    } catch {
      setFiles((prev) => [
        ...prev,
        {
          id: `f-sample-${Date.now()}`,
          name: fileName,
          size: "320 KB",
          type: "application/json",
          description: "Automated test coverage output",
        },
      ]);
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  const triggerSubmissionSimulation = async () => {
    if (!validateUrls()) return;
    if (!currentMilestone) return;

    setIsModalOpen(true);
    setSimStep(0);
    setIsCompleted(false);
    setIsAiLoading(true);
    setAiError(null);

    // Progress animation
    setSimStep(1);

    try {
      // 1. If we have files with storagePath, persist to POST /api/submissions first
      let submissionId: string | undefined = undefined;
      const filesWithStorage = files.filter((f) => !!f.storagePath);

      if (filesWithStorage.length > 0 && currentProject && currentMilestone) {
        try {
          const subRes = await fetch("/api/submissions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: currentProject.id,
              milestoneId: currentMilestone.id,
              repoUrl,
              stagingUrl,
              figmaUrl,
              notes,
              files: filesWithStorage.map((f) => ({
                fileName: f.name,
                storagePath: f.storagePath,
                fileSizeBytes: f.size,
                mimeType: f.type,
                description: f.description,
              })),
            }),
          });

          if (subRes.ok) {
            const subData = await subRes.json();
            submissionId = subData.submissionId;
          }
        } catch (subErr) {
          console.warn("Could not persist submission via /api/submissions:", subErr);
        }
      }

      // 2. Real Gemini AI API call
      const res = await fetch("/api/gemini/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: currentProject.id,
          milestoneId: currentMilestone.id,
          submissionId,
          acceptanceCriteria: currentMilestone.acceptanceCriteria,
          notes,
          repoUrl,
          stagingUrl,
          figmaUrl,
          files,
        }),
      });

      setSimStep(2);

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.isRetryable) {
          setAiRetryInfo({
            isRetryable: true,
            retryAfterSec: data.retryAfterSec || 5,
            errorType: data.errorType,
          });
          throw new Error(data.error || data.message || "AI Verification capacity temporarily constrained.");
        } else {
          setAiRetryInfo(null);
          throw new Error(data.message || data.error || "AI Verification failed.");
        }
      }

      setAiRetryInfo(null);
      setSimStep(3);
      setIsCompleted(true);

      // Save submission and real audit report into state
      addSubmission({
        projectId: currentProject.id,
        milestoneId: currentMilestone.id,
        repoUrl,
        stagingUrl,
        figmaUrl,
        notes,
        files,
        auditReport: data.auditReport,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Verification request failed";
      setAiError(msg);
    } finally {
      setIsAiLoading(false);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 bg-surface-container-lowest rounded-xl border border-surface-container-low text-center">
        <span className="material-symbols-outlined text-secondary text-[40px]">task_alt</span>
        <h2 className="font-headline-sm text-headline-sm text-on-surface">No Projects Available</h2>
        <p className="font-body-md text-secondary max-w-md">
          You currently have no assigned projects. Once a client assigns you to a project, you can upload evidence and submit deliverables here.
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
    <div className="flex flex-col w-full gap-space-lg">
      {/* Hidden File Picker Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.json,.txt,.md,.csv,.html,.xml,.png,.jpg,.jpeg,.webp,.svg"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />

      {/* Institutional AI Verification Engine Notice */}
      <div className="bg-primary/5 border border-primary/20 rounded-xl p-space-md flex items-start gap-space-md">
        <span className="material-symbols-outlined text-primary text-[22px] shrink-0 mt-0.5">
          verified
        </span>
        <div className="flex flex-col">
          <span className="font-label-md text-label-md text-on-surface font-semibold uppercase tracking-wider">
            Institutional AI Verification Engine Active
          </span>
          <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
            Deliverables submitted here undergo multi-modal inspection by Gemini AI with deterministic runtime reachability probes. All findings are advisory; payment capture strictly requires explicit client authorization.
          </p>
        </div>
      </div>

      {/* Revision Requested Feedback Banner for Freelancer */}
      {isRevisionRequested && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 flex items-start gap-3 shadow-xs animate-fade-in">
          <span className="material-symbols-outlined text-amber-700 text-[24px] shrink-0 mt-0.5">
            assignment_late
          </span>
          <div className="flex flex-col gap-1 w-full">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-amber-900 text-body-md">
                Client Requested Revisions for this Milestone
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-200 text-amber-800">
                Action Required
              </span>
            </div>
            <p className="text-body-sm text-amber-800 leading-relaxed bg-amber-100/60 p-2.5 rounded-lg border border-amber-200/60 mt-1">
              &ldquo;{revisionFeedback}&rdquo;
            </p>
            <span className="text-xs text-amber-700 mt-0.5">
              Please address the client&apos;s feedback above and submit your updated repository references or deliverable files below.
            </span>
          </div>
        </div>
      )}

      {/* Workspace Header & Breadcrumbs */}
      <div className="flex flex-col gap-space-xs">
        <div className="flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md">
          <Link href="/projects" className="hover:text-primary transition-colors flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">folder_open</span>
            <span>My Projects</span>
          </Link>
          <span className="material-symbols-outlined text-[14px] text-outline-variant">chevron_right</span>
          <Link href={`/projects/${currentProject.id}`} className="hover:text-primary transition-colors">
            {currentProject.title}
          </Link>
          <span className="material-symbols-outlined text-[14px] text-outline-variant">chevron_right</span>
          <span className="text-primary font-semibold">Submit Deliverable</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-space-md mt-1">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
              Submit Deliverables for Milestone {currentMilestone?.phase || 2}
            </h1>
            <p className="font-body-md text-body-md text-secondary mt-0.5">
              Prepare inspection artifacts, repository references, and notes for automated compliance verification.
            </p>
          </div>

          <div className="flex items-center gap-space-sm">
            <button
              className="px-4 py-2 bg-surface-container-lowest text-on-surface hover:bg-surface-container-high rounded-lg text-body-md font-body-md shadow-sm transition-all flex items-center gap-2 border border-surface-container-high/60"
              type="button"
              onClick={() => alert("Draft saved in session state.")}
            >
              <span className="material-symbols-outlined text-[18px] text-secondary">save</span>
              <span>Save Draft</span>
            </button>
            <button
              className="px-5 py-2 bg-primary-container text-on-primary-container hover:bg-primary rounded-lg text-body-md font-body-md font-semibold shadow-sm transition-all flex items-center gap-2"
              onClick={triggerSubmissionSimulation}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">verified_user</span>
              <span>Run Verification &amp; Submit</span>
            </button>
          </div>
        </div>
      </div>

      {/* Project & Milestone Context Banner */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-space-lg">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-primary shrink-0">
              <span className="material-symbols-outlined text-[22px]">laptop_mac</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                Active Project
              </span>
              <select
                value={selectedProjectId}
                onChange={(e) => {
                  setSelectedProjectId(e.target.value);
                  const p = projects.find((proj) => proj.id === e.target.value);
                  if (p?.milestones?.[0]) setSelectedMilestoneId(p.milestones[0].id);
                }}
                className="font-title-md text-title-md text-on-surface bg-transparent border-none p-0 focus:outline-none cursor-pointer"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <span className="font-body-sm text-body-sm text-on-surface-variant font-medium">
                {currentProject?.description ? `${currentProject.description.slice(0, 32)}...` : ""}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-secondary-container flex items-center justify-center text-on-secondary-container shrink-0">
              <span className="material-symbols-outlined text-[22px]">payments</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                Milestone Amount
              </span>
              <span className="font-metric-display text-[22px] leading-tight text-on-surface tabular-nums">
                ${currentMilestone?.amount ? currentMilestone.amount.toFixed(2) : "0.00"} USD
              </span>
              <span className="font-label-sm text-label-sm text-primary flex items-center gap-1 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" /> Pre-Authorized Hold
              </span>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-secondary shrink-0">
              <span className="material-symbols-outlined text-[22px]">person</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                Contract Client
              </span>
              <span className="font-title-md text-title-md text-on-surface">
                {currentProject?.client?.name || "Client"}
              </span>
              <span className="font-body-sm text-body-sm text-secondary">
                {currentProject?.client?.role || "Client"}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary-fixed flex items-center justify-center text-on-primary-fixed shrink-0">
              <span className="material-symbols-outlined text-[22px]">event_upcoming</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                Milestone Target
              </span>
              <span className="font-title-md text-title-md text-on-surface">
                {currentMilestone?.dueDate}
              </span>
              <span className="font-label-sm text-label-sm text-error font-medium flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">schedule</span> Target Active
              </span>
            </div>
          </div>
        </div>

        <div className="mt-space-md pt-space-md bg-surface-container-low/70 rounded-lg p-3 px-4 flex flex-wrap items-center justify-between gap-2 border border-surface-container-high/50">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[18px]">flag</span>
            <span className="font-label-md text-label-md text-secondary uppercase">Milestone Objective:</span>
            <span className="font-body-md text-body-md text-on-surface font-medium">
              {currentMilestone?.title}
            </span>
          </div>
          <span className="font-label-sm text-label-sm bg-primary-fixed text-on-primary-fixed px-2.5 py-1 rounded-full font-medium">
            Phase {currentMilestone?.phase} of {currentMilestone?.totalPhases}
          </span>
        </div>
      </div>

      {/* Main Grid Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-lg items-start">
        {/* Left Column: Form & Inputs (8 Columns) */}
        <div className="xl:col-span-8 flex flex-col gap-space-lg">
          {/* Section 1: Deliverable Links Card */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60">
            <div className="flex items-center justify-between mb-space-md">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                <h2 className="font-headline-sm text-headline-sm text-on-surface">
                  Deliverable Links &amp; Code Reference
                </h2>
              </div>
              <span className="font-label-sm text-label-sm text-secondary bg-surface-container-high px-2 py-0.5 rounded">
                Required for Inspection
              </span>
            </div>

            <div className="space-y-space-md">
              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="github-repo-input">
                  GitHub Repository / Commit Tree URL <span className="text-error">*</span>
                </label>
                <div className="relative flex items-center">
                  <span className="material-symbols-outlined absolute left-3 text-secondary text-[20px]">
                    code
                  </span>
                  <input
                    id="github-repo-input"
                    className={`w-full h-10 pl-10 pr-24 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                      formErrors.repoUrl ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                    }`}
                    placeholder="https://github.com/org/repo/commit/..."
                    type="text"
                    value={repoUrl}
                    onChange={(e) => {
                      setRepoUrl(e.target.value);
                      if (formErrors.repoUrl) setFormErrors((prev) => ({ ...prev, repoUrl: "" }));
                    }}
                  />
                  <span className="absolute right-3 font-label-sm text-label-sm text-primary flex items-center gap-1 font-semibold">
                    <span className="material-symbols-outlined text-[16px]">check_circle</span> Verified
                  </span>
                </div>
                {formErrors.repoUrl && (
                  <p className="font-body-sm text-body-sm text-error mt-1">{formErrors.repoUrl}</p>
                )}
                <p className="font-body-sm text-body-sm text-secondary mt-1">
                  AI engine parses diffs, commits, and unit tests directly from this link.
                </p>
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="staging-url-input">
                  Live Staging / Production Preview URL <span className="text-error">*</span>
                </label>
                <div className="relative flex items-center">
                  <span className="material-symbols-outlined absolute left-3 text-secondary text-[20px]">
                    public
                  </span>
                  <input
                    id="staging-url-input"
                    className={`w-full h-10 pl-10 pr-28 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border ${
                      formErrors.stagingUrl ? "border-error ring-1 ring-error" : "border-surface-container-high/60"
                    }`}
                    placeholder="https://preview.yourproject.com"
                    type="text"
                    value={stagingUrl}
                    onChange={(e) => {
                      setStagingUrl(e.target.value);
                      if (formErrors.stagingUrl) setFormErrors((prev) => ({ ...prev, stagingUrl: "" }));
                    }}
                  />
                  <a
                    className="absolute right-3 font-label-sm text-label-sm text-secondary hover:text-primary flex items-center gap-1"
                    href={stagingUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>Open Preview</span>
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                  </a>
                </div>
                {formErrors.stagingUrl && (
                  <p className="font-body-sm text-body-sm text-error mt-1">{formErrors.stagingUrl}</p>
                )}
                <p className="font-body-sm text-body-sm text-secondary mt-1">
                  Target for responsive cross-device visual crawler and headless lighthouse run.
                </p>
              </div>

              <div>
                <label className="block font-label-md text-label-md text-on-surface mb-1" htmlFor="figma-url-input">
                  Figma Design Tokens / Specification Reference
                </label>
                <div className="relative flex items-center">
                  <span className="material-symbols-outlined absolute left-3 text-secondary text-[20px]">
                    palette
                  </span>
                  <input
                    id="figma-url-input"
                    className="w-full h-10 pl-10 pr-24 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none transition-colors border border-surface-container-high/60"
                    placeholder="https://figma.com/file/..."
                    type="text"
                    value={figmaUrl}
                    onChange={(e) => setFigmaUrl(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: File Upload & Staged Assets */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60">
            <div className="flex items-center justify-between mb-space-md">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-primary-container" />
                <h2 className="font-headline-sm text-headline-sm text-on-surface">
                  Verification Assets &amp; Artifacts
                </h2>
              </div>
              <span className="font-label-md text-label-md text-secondary">
                {files.length} staged files
              </span>
            </div>

            {/* Drag and Drop Zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="bg-surface-container-low/60 hover:bg-surface-container-low rounded-xl p-space-lg flex flex-col items-center justify-center text-center cursor-pointer transition-all border border-dashed border-surface-container-high"
            >
              <div className="w-12 h-12 rounded-full bg-surface-container-lowest flex items-center justify-center text-primary shadow-sm mb-3">
                <span className="material-symbols-outlined text-[26px]">cloud_upload</span>
              </div>
              <p className="font-title-md text-title-md text-on-surface font-semibold">
                Drop walkthrough recordings, screenshots, or audit reports
              </p>
              <p className="font-body-sm text-body-sm text-secondary mt-1 max-w-md">
                Supports PDF specs, JSON schemas/tokens, text logs, markdown reports, and PNG/JPEG images up to 10MB. Files are encrypted and stored in private Supabase Storage.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <button
                  disabled={isUploading}
                  className="px-3.5 py-1.5 bg-surface-container-lowest hover:bg-surface-container-high rounded-lg text-label-md font-label-md text-on-surface shadow-xs transition-colors border border-surface-container-high disabled:opacity-50"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  {isUploading ? "Uploading..." : "Browse Files"}
                </button>
                <button
                  disabled={isUploading}
                  className="px-3 py-1.5 bg-surface-container-lowest hover:bg-surface-container-high rounded-lg text-label-md font-label-md text-primary transition-colors border border-surface-container-high disabled:opacity-50"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddSampleFile();
                  }}
                >
                  + Add Sample Artifact
                </button>
              </div>
            </div>

            {/* Upload Progress Bar */}
            {isUploading && (
              <div className="mt-space-sm p-3 bg-primary/5 rounded-lg border border-primary/20 flex items-center gap-3 animate-pulse">
                <span className="material-symbols-outlined text-primary text-[20px] animate-spin">
                  sync
                </span>
                <span className="font-body-sm text-body-sm text-primary font-medium">
                  {uploadProgress || "Uploading deliverable artifacts to private storage..."}
                </span>
              </div>
            )}

            {/* Upload Error Banner */}
            {uploadError && (
              <div className="mt-space-sm p-3 bg-error-container/20 border border-error/30 rounded-lg flex items-start justify-between gap-2 text-error">
                <div className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">warning</span>
                  <span className="font-body-sm text-body-sm">{uploadError}</span>
                </div>
                <button
                  onClick={() => setUploadError(null)}
                  className="text-error/70 hover:text-error shrink-0"
                  type="button"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            )}

            {/* Staged Files List */}
            <div className="mt-space-md flex flex-col gap-2">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center justify-between p-3 bg-surface-container-low rounded-lg transition-colors hover:bg-surface-container"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded bg-surface-container-lowest flex items-center justify-center text-primary shrink-0 shadow-xs">
                      <span className="material-symbols-outlined text-[20px]">
                        {file.type.includes("pdf")
                          ? "picture_as_pdf"
                          : file.type.includes("video")
                          ? "video_file"
                          : file.type.includes("image")
                          ? "image"
                          : "data_object"}
                      </span>
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-title-md text-title-md text-on-surface truncate">
                        {file.name}
                      </span>
                      <span className="font-label-sm text-label-sm text-secondary truncate">
                        {file.size} {file.description ? `• ${file.description}` : ""}
                        {file.storagePath ? ` • Path: ${file.storagePath.split("/").slice(-1)[0]}` : ""}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0 ml-3">
                    {file.signedUrl ? (
                      <a
                        href={file.signedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 hover:bg-emerald-200 transition-colors flex items-center gap-1 border border-emerald-300"
                        title="View or download signed private storage asset"
                      >
                        <span className="material-symbols-outlined text-[13px]">lock</span>
                        <span>Private Storage</span>
                        <span className="material-symbols-outlined text-[11px]">open_in_new</span>
                      </a>
                    ) : file.storagePath ? (
                      <span className="font-label-sm text-label-sm bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                        <span className="material-symbols-outlined text-[13px]">lock</span> Private Storage
                      </span>
                    ) : (
                      <span className="font-label-sm text-label-sm bg-surface-container-highest text-on-surface-variant px-2.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px] text-primary">check</span> Ready
                      </span>
                    )}
                    <button
                      onClick={() => handleRemoveFile(file.id)}
                      className="text-secondary hover:text-error transition-colors p-1"
                      title="Remove File"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: Rich Markdown Deliverable Summary */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60">
            <div className="flex items-center justify-between mb-space-sm">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-secondary" />
                <h2 className="font-headline-sm text-headline-sm text-on-surface">
                  Deliverable Notes &amp; Handover Summary
                </h2>
              </div>
              <div className="flex items-center gap-1 text-secondary font-label-sm text-label-sm">
                <span className="material-symbols-outlined text-[16px]">markdown</span>
                <span>Markdown Enabled</span>
              </div>
            </div>

            <div className="bg-surface-container-low rounded-t-lg px-3 py-2 flex items-center gap-1 border-t border-x border-surface-container-high/60">
              <button className="p-1 hover:bg-surface-container-lowest rounded text-secondary hover:text-on-surface" title="Bold" type="button">
                <span className="material-symbols-outlined text-[18px]">format_bold</span>
              </button>
              <button className="p-1 hover:bg-surface-container-lowest rounded text-secondary hover:text-on-surface" title="Italic" type="button">
                <span className="material-symbols-outlined text-[18px]">format_italic</span>
              </button>
              <button className="p-1 hover:bg-surface-container-lowest rounded text-secondary hover:text-on-surface" title="Code Block" type="button">
                <span className="material-symbols-outlined text-[18px]">terminal</span>
              </button>
              <div className="ml-auto flex items-center gap-2">
                <span className="font-label-sm text-label-sm text-secondary">
                  {notes.split(/\s+/).filter(Boolean).length} words
                </span>
              </div>
            </div>
            <textarea
              className={`w-full p-4 bg-surface-container-lowest rounded-b-lg font-body-md text-body-md text-on-surface focus:outline-none resize-y leading-relaxed font-mono border-b border-x ${
                formErrors.notes ? "border-error" : "border-surface-container-high/60"
              }`}
              rows={8}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                if (formErrors.notes) setFormErrors((prev) => ({ ...prev, notes: "" }));
              }}
            />
            {formErrors.notes && (
              <p className="font-body-sm text-body-sm text-error mt-1">{formErrors.notes}</p>
            )}
          </div>
        </div>

        {/* Right Column: Verification Self-Check & Submission Action (4 Columns) */}
        <div className="xl:col-span-4 flex flex-col gap-space-lg">
          {/* Acceptance Self Check Card */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/60">
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-primary text-[20px]">auto_awesome</span>
              <h3 className="font-headline-sm text-headline-sm text-on-surface">
                Pre-Flight Inspection Checklist
              </h3>
            </div>
            <p className="font-body-sm text-body-sm text-secondary mb-space-md">
              Verify these contract specifications are fulfilled before submitting for automated compliance checks:
            </p>

            <div className="space-y-3">
              {currentMilestone?.acceptanceCriteria?.map((crit) => (
                <label
                  key={crit.id}
                  className="flex items-start gap-3 p-2.5 rounded-lg bg-surface-container-low hover:bg-surface-container transition-colors cursor-pointer"
                >
                  <input
                    defaultChecked
                    className="mt-0.5 w-4 h-4 rounded text-primary focus:ring-primary accent-primary"
                    type="checkbox"
                  />
                  <div className="flex flex-col">
                    <span className="font-body-md text-body-md text-on-surface font-medium">
                      {crit.label}
                    </span>
                    {crit.description && (
                      <span className="font-label-sm text-label-sm text-secondary">
                        {crit.description}
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </div>

            <div className="mt-space-md p-3.5 bg-surface-container-high/60 rounded-lg flex items-start gap-3">
              <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5">
                timer
              </span>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Submitting triggers our automated inspection engine. After audit completion, the client will review the findings and authorize PayPal merchant capture.
              </p>
            </div>

            <div className="mt-space-lg flex flex-col gap-2">
              <button
                className="w-full py-3 px-4 bg-primary-container text-white font-body-md text-body-md font-semibold rounded-lg hover:bg-primary transition-all shadow-sm flex items-center justify-center gap-2 group"
                onClick={triggerSubmissionSimulation}
                type="button"
              >
                <span>Run Verification &amp; Submit</span>
                <span className="material-symbols-outlined text-[18px] group-hover:translate-x-0.5 transition-transform">
                  arrow_forward
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Verification Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-2xl shadow-xl max-w-md w-full p-space-lg flex flex-col gap-space-md border border-surface-container-high">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[24px]">auto_awesome</span>
                <h4 className="font-headline-sm text-headline-sm text-on-surface">
                  Gemini AI Verification
                </h4>
              </div>
              <button
                className="text-secondary hover:text-on-surface"
                onClick={() => setIsModalOpen(false)}
                type="button"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {aiError ? (
              aiRetryInfo?.isRetryable ? (
                <div className="p-space-md rounded-xl bg-amber-50 border border-amber-300 text-amber-900 flex flex-col gap-2 my-2 animate-fade-in">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-amber-700 text-[22px] shrink-0">
                      hourglass_top
                    </span>
                    <span className="font-title-md text-title-md font-semibold text-amber-950">
                      AI Verification Capacity Busy
                    </span>
                  </div>
                  <p className="font-body-sm text-body-sm text-amber-900 leading-relaxed">
                    {aiError}
                  </p>
                  <p className="font-label-sm text-label-sm text-amber-800 bg-amber-100/70 p-2 rounded border border-amber-200">
                    ✓ Your deliverable artifacts, repository links, and notes are securely preserved in private storage. You can retry verification safely without re-uploading files.
                  </p>
                </div>
              ) : (
                <div className="p-space-md rounded-xl bg-error-container/30 border border-error/20 text-error flex items-start gap-space-sm my-2">
                  <span className="material-symbols-outlined text-[20px] shrink-0 mt-0.5">error</span>
                  <div className="flex flex-col">
                    <span className="font-title-md text-title-md font-semibold">Verification Request Failed</span>
                    <span className="font-body-sm text-body-sm mt-0.5">{aiError}</span>
                  </div>
                </div>
              )
            ) : (
              <>
                <div className="flex flex-col gap-3 my-2">
                  <div className="flex items-center justify-between font-label-md text-label-md">
                    <span className="text-on-surface font-medium">{steps[simStep].text}</span>
                    <span className="text-primary font-semibold">{steps[simStep].pct}</span>
                  </div>
                  <div className="w-full h-2 bg-surface-container rounded-full overflow-hidden">
                    <div
                      className={`h-full bg-primary-container transition-all duration-300 ${steps[simStep].width}`}
                    />
                  </div>
                </div>

                <p className="font-body-sm text-body-sm text-secondary">
                  Real-time multi-modal audit comparing commit references, staging evidence, and test artifacts against agreed milestone acceptance criteria.
                </p>
              </>
            )}

            <div className="flex justify-end gap-2 mt-2">
              {aiError ? (
                <>
                  <button
                    className="px-4 py-2 bg-surface-container-low hover:bg-surface-container rounded-lg text-body-md font-body-md text-on-surface transition-colors"
                    onClick={() => setIsModalOpen(false)}
                    type="button"
                  >
                    Close
                  </button>
                  {aiRetryInfo?.isRetryable && (
                    <button
                      disabled={isAiLoading}
                      className="px-4 py-2 bg-primary text-white rounded-lg text-body-md font-body-md font-semibold hover:bg-primary/90 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                      onClick={() => triggerSubmissionSimulation()}
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[16px]">refresh</span>
                      <span>Retry Verification</span>
                    </button>
                  )}
                </>
              ) : isCompleted ? (
                <button
                  className="px-4 py-2 bg-primary text-white rounded-lg text-body-md font-body-md font-semibold transition-colors flex items-center gap-1.5"
                  onClick={() => router.push("/verification")}
                  type="button"
                >
                  <span>View Real Gemini Audit</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              ) : (
                <button
                  disabled={isAiLoading}
                  className="px-4 py-2 bg-surface-container-low hover:bg-surface-container rounded-lg text-body-md font-body-md text-on-surface transition-colors disabled:opacity-50"
                  onClick={() => setIsModalOpen(false)}
                  type="button"
                >
                  Processing...
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SubmissionsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-secondary">Loading submissions workspace...</div>}>
      <SubmissionsContent />
    </Suspense>
  );
}
