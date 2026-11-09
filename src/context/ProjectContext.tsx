"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Project,
  Milestone,
  Submission,
  TransactionRecord,
  UserRole,
  VerificationAuditReport,
} from "@/lib/types";
import { initialProjects, initialTransactions } from "@/lib/demo-data";

interface ProjectContextType {
  projects: Project[];
  transactions: TransactionRecord[];
  submissions: Submission[];
  activeAuditReport: VerificationAuditReport | null;
  activeRole: UserRole;
  isSupabaseSynced: boolean;
  isLoaded: boolean;
  refreshProjects: () => Promise<Project[]>;
  setActiveRole: (role: UserRole) => void;
  getProject: (id: string) => Project | undefined;
  addProject: (
    project: Omit<Project, "id" | "createdAt" | "milestones"> & {
      initialMilestones?: Omit<Milestone, "id" | "projectId" | "phase" | "totalPhases">[];
    }
  ) => Project;
  updateProjectBudget: (projectId: string, newBudget: number) => { success: boolean; error?: string };
  addMilestone: (
    projectId: string,
    milestone: Omit<Milestone, "id" | "projectId" | "phase" | "totalPhases">
  ) => { success: boolean; milestone?: Milestone; error?: string };
  updateMilestoneStatus: (
    projectId: string,
    milestoneId: string,
    status: Milestone["status"],
    paymentStatus?: Milestone["paymentStatus"]
  ) => void;
  addSubmission: (
    submission: Omit<Submission, "id" | "submittedAt" | "status"> & {
      status?: Submission["status"];
      auditReport?: VerificationAuditReport;
    }
  ) => Submission;
  saveAuditReport: (report: VerificationAuditReport) => void;
  updateAuditClientDecision: (
    reportId: string,
    decision: "approved" | "revisions_requested" | "rejected",
    notes?: string
  ) => void;
  getMilestoneSubmissions: (milestoneId: string) => Submission[];
  resetDemoData: () => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

const STORAGE_KEY = "milestone_ai_projects_v3";
const ROLE_STORAGE_KEY = "milestone_ai_role_v3";
const SUBMISSIONS_STORAGE_KEY = "milestone_ai_submissions_v3";
const AUDIT_STORAGE_KEY = "milestone_ai_audit_v3";

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [transactions] = useState<TransactionRecord[]>(initialTransactions);
  const [submissions, setSubmissions] = useState<Submission[]>([
    {
      id: "sub-1",
      projectId: "website-redesign",
      milestoneId: "ms-2",
      repoUrl: "https://github.com/agency/website-redesign/commit/4a89f2",
      stagingUrl: "https://staging.acmecorp-redesign.com",
      figmaUrl: "https://figma.com/file/acme-design-tokens-v2",
      notes: "Milestone 2 Completion: Responsive UI Components and Tailwind tokens deployed to staging.",
      files: [
        {
          id: "f1",
          name: "walkthrough-demo.mp4",
          size: "18.4 MB",
          type: "video/mp4",
          description: "Complete end-to-end user navigation record",
        },
        {
          id: "f2",
          name: "figma-design-tokens.json",
          size: "240 KB",
          type: "application/json",
          description: "Semantic spacing, typography & palette export",
        },
        {
          id: "f3",
          name: "lighthouse-audit.pdf",
          size: "1.2 MB",
          type: "application/pdf",
          description: "Desktop & Mobile Accessibility / Performance (98/100)",
        },
      ],
      submittedAt: "2026-11-12T14:30:00Z",
      status: "under_review",
      aiConfidence: 96,
    },
  ]);
  const [activeAuditReport, setActiveAuditReport] = useState<VerificationAuditReport | null>(null);
  const [activeRole, setActiveRoleState] = useState<UserRole>("client");
  const [isSupabaseSynced, setIsSupabaseSynced] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);

  const refreshProjects = async (): Promise<Project[]> => {
    try {
      const supabase = createClient();
      const headers: Record<string, string> = {};
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
      }

      const res = await fetch("/api/projects", { headers });
      const json = await res.json();
      if (json.success && Array.isArray(json.projects)) {
        setProjects(json.projects);
        setIsSupabaseSynced(true);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(json.projects));
        } catch {}
        return json.projects;
      }
    } catch (e) {
      console.warn("Failed to refresh projects from /api/projects:", e);
    }
    return projects;
  };

  // Load from Supabase API (authoritative source) or fallback to demo state
  useEffect(() => {
    async function loadData() {
      const supabase = createClient();
      let isAuthenticated = false;

      try {
        const headers: Record<string, string> = {};
        if (supabase) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.access_token) {
            headers["Authorization"] = `Bearer ${session.access_token}`;
            isAuthenticated = true;
          }
        }

        const res = await fetch("/api/projects", { headers });
        const json = await res.json();
        if (json.success && Array.isArray(json.projects)) {
          // If authenticated, respect the authoritative database project list (even if empty)
          if (isAuthenticated || json.projects.length > 0) {
            setProjects(json.projects);
            setIsSupabaseSynced(true);
            setIsLoaded(true);
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(json.projects));
            } catch {}
            return;
          }
        }
      } catch {
        // Fallback to local storage if network or Supabase not yet provisioned
      }

      try {
        const savedProjects = localStorage.getItem(STORAGE_KEY);
        if (savedProjects) {
          const parsed = JSON.parse(savedProjects);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setProjects(parsed);
          }
        }

        const savedRole = localStorage.getItem(ROLE_STORAGE_KEY);
        if (savedRole === "client" || savedRole === "freelancer") {
          setActiveRoleState(savedRole);
        }

        const savedSubmissions = localStorage.getItem(SUBMISSIONS_STORAGE_KEY);
        if (savedSubmissions) {
          const parsedSubs = JSON.parse(savedSubmissions);
          if (Array.isArray(parsedSubs) && parsedSubs.length > 0) {
            setSubmissions(parsedSubs);
          }
        }

        const savedAudit = localStorage.getItem(AUDIT_STORAGE_KEY);
        if (savedAudit) {
          setActiveAuditReport(JSON.parse(savedAudit));
        }
      } catch {
        // Fallback
      } finally {
        setIsLoaded(true);
      }
    }

    loadData();

    // Listen to Supabase auth state transitions to reload user-scoped projects
    const supabase = createClient();
    if (supabase) {
      const { data: authListener } = supabase.auth.onAuthStateChange(() => {
        loadData();
      });
      return () => {
        authListener.subscription.unsubscribe();
      };
    }
  }, []);

  const setActiveRole = (role: UserRole) => {
    setActiveRoleState(role);
    try {
      localStorage.setItem(ROLE_STORAGE_KEY, role);
    } catch {
      // Ignore write errors
    }
  };

  const saveProjects = (updatedProjects: Project[]) => {
    setProjects(updatedProjects);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedProjects));
    } catch {
      // Ignore write errors
    }
  };

  const saveSubmissions = (updatedSubmissions: Submission[]) => {
    setSubmissions(updatedSubmissions);
    try {
      localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updatedSubmissions));
    } catch {
      // Ignore write errors
    }
  };

  const saveAuditReport = (report: VerificationAuditReport) => {
    setActiveAuditReport(report);
    try {
      localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(report));
    } catch {
      // Ignore write errors
    }
  };

  const updateAuditClientDecision = (
    reportId: string,
    decision: "approved" | "revisions_requested" | "rejected",
    notes?: string
  ) => {
    if (activeAuditReport && activeAuditReport.id === reportId) {
      const updated = {
        ...activeAuditReport,
        clientReviewed: true,
        clientDecision: decision,
        clientNotes: notes,
      };
      saveAuditReport(updated);

      // If approved, update milestone status
      if (decision === "approved") {
        updateMilestoneStatus(
          activeAuditReport.projectId,
          activeAuditReport.milestoneId,
          "approved"
        );
      } else if (decision === "revisions_requested") {
        updateMilestoneStatus(
          activeAuditReport.projectId,
          activeAuditReport.milestoneId,
          "in_progress"
        );
      }
    }
  };

  const getProject = (id: string) => {
    return projects.find((p) => p.id === id);
  };

  const addProject = (
    data: Omit<Project, "id" | "createdAt" | "milestones"> & {
      initialMilestones?: Omit<Milestone, "id" | "projectId" | "phase" | "totalPhases">[];
    }
  ): Project => {
    const newId =
      data.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `project-${Date.now()}`;

    const createdMilestones: Milestone[] = (data.initialMilestones || []).map(
      (m, idx) => ({
        ...m,
        id: `ms-${Date.now()}-${idx + 1}`,
        projectId: newId,
        phase: idx + 1,
        totalPhases: data.initialMilestones?.length || 1,
      })
    );

    const newProject: Project = {
      ...data,
      id: newId,
      createdAt: new Date().toISOString(),
      milestones: createdMilestones,
    };

    const nextProjects = [newProject, ...projects];
    saveProjects(nextProjects);
    return newProject;
  };

  // Task 0: Explicit budget update action
  const updateProjectBudget = (projectId: string, newBudget: number) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return { success: false, error: "Project not found" };

    const totalAllocated = project.milestones.reduce((sum, m) => sum + m.amount, 0);
    if (newBudget < totalAllocated) {
      return {
        success: false,
        error: `New budget ($${newBudget}) cannot be lower than existing milestone allocations ($${totalAllocated}).`,
      };
    }

    const nextProjects = projects.map((p) =>
      p.id === projectId ? { ...p, budget: newBudget } : p
    );
    saveProjects(nextProjects);
    return { success: true };
  };

  // Task 0: Strict budget validation — NEVER increase project budget automatically
  const addMilestone = (
    projectId: string,
    data: Omit<Milestone, "id" | "projectId" | "phase" | "totalPhases">
  ): { success: boolean; milestone?: Milestone; error?: string } => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return { success: false, error: "Project not found." };

    const currentAllocated = project.milestones.reduce((sum, m) => sum + m.amount, 0);
    const newTotal = currentAllocated + data.amount;

    // Strict validation: Reject if total allocation exceeds agreed contract budget
    if (newTotal > project.budget) {
      const remaining = Math.max(0, project.budget - currentAllocated);
      return {
        success: false,
        error: `Cannot add milestone of $${data.amount.toFixed(2)}. Only $${remaining.toFixed(2)} remaining of the agreed $${project.budget.toFixed(2)} contract budget.`,
      };
    }

    const phaseIndex = project.milestones.length + 1;
    const newMilestone: Milestone = {
      ...data,
      id: `ms-${Date.now()}`,
      projectId,
      phase: phaseIndex,
      totalPhases: phaseIndex,
    };

    const nextProjects = projects.map((p) => {
      if (p.id !== projectId) return p;
      const updatedMilestones = [...p.milestones, newMilestone].map((m, _, arr) => ({
        ...m,
        totalPhases: arr.length,
      }));

      // Preserves project.budget! Never increases automatically
      return {
        ...p,
        milestones: updatedMilestones,
      };
    });

    saveProjects(nextProjects);
    return { success: true, milestone: newMilestone };
  };

  const updateMilestoneStatus = (
    projectId: string,
    milestoneId: string,
    status: Milestone["status"],
    paymentStatus?: Milestone["paymentStatus"]
  ) => {
    const nextProjects = projects.map((p) => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        milestones: p.milestones.map((m) => {
          if (m.id !== milestoneId) return m;
          return {
            ...m,
            status,
            ...(paymentStatus ? { paymentStatus } : {}),
          };
        }),
      };
    });

    saveProjects(nextProjects);
  };

  const addSubmission = (
    data: Omit<Submission, "id" | "submittedAt" | "status"> & {
      status?: Submission["status"];
      auditReport?: VerificationAuditReport;
    }
  ): Submission => {
    const newSubmission: Submission = {
      ...data,
      id: `sub-${Date.now()}`,
      submittedAt: new Date().toISOString(),
      status: data.status || "under_review",
      aiConfidence: data.auditReport?.overallScore || 96,
      auditReport: data.auditReport,
    };

    const nextSubs = [newSubmission, ...submissions];
    saveSubmissions(nextSubs);

    if (data.auditReport) {
      saveAuditReport(data.auditReport);
    }

    // Update corresponding milestone status to under_review
    updateMilestoneStatus(data.projectId, data.milestoneId, "under_review");

    return newSubmission;
  };

  const getMilestoneSubmissions = (milestoneId: string) => {
    return submissions.filter((s) => s.milestoneId === milestoneId);
  };

  const resetDemoData = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ROLE_STORAGE_KEY);
      localStorage.removeItem(SUBMISSIONS_STORAGE_KEY);
      localStorage.removeItem(AUDIT_STORAGE_KEY);
    } catch {
      // Ignore
    }
    setProjects(initialProjects);
    setActiveRoleState("client");
    setActiveAuditReport(null);
  };

  return (
    <ProjectContext.Provider
      value={{
        projects,
        transactions,
        submissions,
        activeAuditReport,
        activeRole,
        isSupabaseSynced,
        isLoaded,
        refreshProjects,
        setActiveRole,
        getProject,
        addProject,
        updateProjectBudget,
        addMilestone,
        updateMilestoneStatus,
        addSubmission,
        saveAuditReport,
        updateAuditClientDecision,
        getMilestoneSubmissions,
        resetDemoData,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjects() {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProjects must be used within a ProjectProvider");
  }
  return ctx;
}
