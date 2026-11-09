"use client";

import { useState } from "react";
import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";

export default function ProjectsPage() {
  const { projects, activeRole, setActiveRole } = useProjects();
  const [filter, setFilter] = useState<"all" | "in_progress" | "completed">("all");

  const filteredProjects = projects.filter((p) => {
    if (filter === "all") return true;
    if (filter === "in_progress") return p.status === "in_progress" || p.status === "active";
    if (filter === "completed") return p.status === "completed";
    return true;
  });

  return (
    <div className="flex flex-col gap-space-lg w-full">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
              {activeRole === "client" ? "Managed Projects" : "Assigned Projects"}
            </h1>
            <span className="font-label-sm text-label-sm bg-surface-container px-2 py-0.5 rounded text-secondary font-mono">
              {filteredProjects.length} {filteredProjects.length === 1 ? "Project" : "Projects"}
            </span>
          </div>
          <p className="font-body-md text-body-md text-secondary mt-1">
            {activeRole === "client"
              ? "Oversee deliverable milestones, authorize PayPal holds, and approve releases."
              : "Track milestone deliverables, submit audit evidence, and review client approvals."}
          </p>
        </div>

        <div className="flex items-center gap-space-sm self-start sm:self-auto">
          {activeRole === "client" && (
            <Link
              href="/projects/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-lg font-label-md text-label-md hover:bg-primary/90 transition-all font-semibold shadow-xs"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              <span>Create Project</span>
            </Link>
          )}
        </div>
      </div>

      {/* Filter and Role Bar */}
      <div className="flex flex-wrap items-center justify-between gap-space-md pb-1 border-b border-surface-container-high/60">
        <div className="flex items-center gap-2">
          {(["all", "in_progress", "completed"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded-lg font-label-md text-label-md transition-colors capitalize ${
                filter === tab
                  ? "bg-surface-container-lowest text-primary shadow-xs font-semibold"
                  : "text-secondary hover:text-on-surface"
              }`}
            >
              {tab.replace("_", " ")} ({tab === "all" ? projects.length : projects.filter(p => tab === "in_progress" ? (p.status === "in_progress" || p.status === "active") : p.status === "completed").length})
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-label-sm font-label-sm text-secondary">
          <span>Workspace Role:</span>
          <span className="font-semibold text-on-surface flex items-center gap-1 bg-surface-container-low px-2.5 py-1 rounded-md">
            <span className="material-symbols-outlined text-[14px] text-primary">
              {activeRole === "client" ? "person" : "engineering"}
            </span>
            <span>{activeRole === "client" ? "Client" : "Freelancer"}</span>
          </span>
        </div>
      </div>

      {/* Project Cards Grid */}
      <div className="grid grid-cols-1 gap-space-lg">
        {filteredProjects.map((project) => {
          const milestones = project.milestones || [];
          const completedMilestones = milestones.filter(
            (m) => m.status === "completed" || m.status === "approved"
          ).length;
          const progress = Math.round(
            (completedMilestones / (milestones.length || 1)) * 100
          );

          return (
            <div
              key={project.id}
              className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md hover:shadow-md transition-shadow"
            >
              {/* Card Header */}
              <div className="flex flex-col md:flex-row md:items-start justify-between gap-space-md">
                <div className="flex items-start gap-space-md">
                  <div className="w-12 h-12 rounded-xl bg-surface-container-high overflow-hidden shrink-0 flex items-center justify-center shadow-xs">
                    {project.image ? (
                      // eslint-disable-next-js/no-img-element
                      <img
                        className="w-full h-full object-cover"
                        alt={project.title}
                        src={project.image}
                      />
                    ) : (
                      <span className="material-symbols-outlined text-primary text-[24px]">
                        folder
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/projects/${project.id}`}
                        className="font-title-md text-title-md text-on-surface hover:text-primary transition-colors font-semibold"
                      >
                        {project.title}
                      </Link>
                      <span className="inline-flex items-center font-label-sm text-label-sm font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                        {project.status === "in_progress" ? "In Progress" : project.status}
                      </span>
                    </div>
                    <p className="font-body-sm text-body-sm text-secondary mt-0.5 line-clamp-1 max-w-2xl">
                      {project.description}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-space-lg shrink-0">
                  <div className="flex flex-col sm:items-end">
                    <span className="font-label-sm text-label-sm text-secondary uppercase tracking-wider">
                      Total Budget
                    </span>
                    <span className="font-metric-display text-[22px] leading-tight text-on-surface font-semibold tabular-nums">
                      ${project.budget.toLocaleString()} {project.currency}
                    </span>
                  </div>
                  <Link
                    href={`/projects/${project.id}`}
                    className="px-3.5 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-label-md transition-colors flex items-center gap-1"
                  >
                    <span>View Project</span>
                    <span className="material-symbols-outlined text-[16px]">chevron_right</span>
                  </Link>
                </div>
              </div>

              {/* Counterparty & Metadata Pill */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md p-3 bg-surface-container-low/60 rounded-lg text-body-sm text-body-sm">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-[18px]">
                    {activeRole === "client" ? "badge" : "person"}
                  </span>
                  <div>
                    <span className="text-secondary text-label-sm block">
                      {activeRole === "client" ? "Assigned Freelancer" : "Project Client"}
                    </span>
                    <span className="font-medium text-on-surface">
                      {activeRole === "client" ? project.freelancer.name : project.client.name}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-[18px]">
                    calendar_today
                  </span>
                  <div>
                    <span className="text-secondary text-label-sm block">Deadline</span>
                    <span className="font-medium text-on-surface">{project.deadline}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-[18px]">
                    flag
                  </span>
                  <div>
                    <span className="text-secondary text-label-sm block">Milestones Completed</span>
                    <span className="font-medium text-on-surface">
                      {completedMilestones} of {milestones.length} ({progress}%)
                    </span>
                  </div>
                </div>
              </div>

              {/* Milestones Inline Strip */}
              <div className="flex flex-col gap-2 pt-1">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">
                  Milestone Breakdown
                </span>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {milestones.map((m) => {
                    const isReview = m.status === "under_review" || m.status === "submitted";
                    const isDone = m.status === "completed" || m.status === "approved";

                    return (
                      <div
                        key={m.id}
                        className="p-3 bg-surface-container-lowest border border-surface-container-low rounded-lg flex flex-col justify-between gap-2 hover:border-surface-container-high transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-label-md text-label-md text-on-surface font-semibold line-clamp-1">
                            {m.title}
                          </span>
                          <span
                            className={`font-label-sm text-label-sm px-2 py-0.5 rounded-full whitespace-nowrap ${
                              isDone
                                ? "bg-emerald-50 text-emerald-700"
                                : isReview
                                ? "bg-amber-50 text-amber-700 font-semibold"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            {isDone ? "Completed" : isReview ? "Under Review" : "In Progress"}
                          </span>
                        </div>

                        <div className="flex items-center justify-between font-body-sm text-body-sm pt-1 border-t border-surface-container-low">
                          <span className="font-semibold text-on-surface tabular-nums">
                            ${m.amount} USD
                          </span>
                          {activeRole === "freelancer" && m.status === "under_review" ? (
                            <Link
                              href="/submissions"
                              className="text-primary hover:underline font-label-sm text-label-sm font-medium flex items-center gap-0.5"
                            >
                              <span>Update Submission</span>
                              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                            </Link>
                          ) : activeRole === "client" && isReview ? (
                            <Link
                              href="/verification"
                              className="text-primary hover:underline font-label-sm text-label-sm font-medium flex items-center gap-0.5"
                            >
                              <span>Inspect AI Audit</span>
                              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                            </Link>
                          ) : (
                            <span className="text-secondary text-label-sm">{m.dueDate}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        {filteredProjects.length === 0 && (
          <div className="py-16 text-center bg-surface-container-lowest rounded-xl border border-surface-container-low flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined text-secondary text-[40px]">folder_open</span>
            <p className="font-title-md text-on-surface font-medium">No projects found</p>
            <p className="font-body-sm text-secondary max-w-sm">
              {activeRole === "client"
                ? "You haven't created any projects yet. Click 'Create Project' above to start your first project."
                : "No projects have been assigned to your freelancer account yet. When a client assigns you to a project, it will appear here."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
