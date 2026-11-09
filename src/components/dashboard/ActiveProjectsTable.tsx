"use client";

import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";

export default function ActiveProjectsTable() {
  const { projects, activeRole } = useProjects();
  const isClient = activeRole === "client";

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "in_progress":
      case "active":
        return { label: "In Progress", color: "bg-blue-50 text-blue-700" };
      case "completed":
        return { label: "Completed", color: "bg-emerald-50 text-emerald-700" };
      case "draft":
        return { label: "Draft", color: "bg-surface-container-high text-secondary" };
      default:
        return { label: "Pending", color: "bg-amber-50 text-amber-700" };
    }
  };

  const calculateProgress = (milestones: { status: string }[]) => {
    if (!milestones.length) return 0;
    const completed = milestones.filter(
      (m) => m.status === "completed" || m.status === "approved"
    ).length;
    return Math.round((completed / milestones.length) * 100);
  };

  return (
    <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/50 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-space-md">
        <div className="flex items-center gap-2">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            {isClient ? "Your Active Projects" : "Your Assigned Projects"}
          </h2>
          <span className="font-label-sm text-label-sm bg-surface-container px-2 py-0.5 rounded text-secondary font-mono">
            {projects.length} {projects.length === 1 ? "Project" : "Projects"}
          </span>
        </div>
        <div className="flex items-center gap-space-sm">
          {isClient && (
            <Link
              href="/projects/new"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-white hover:bg-primary/90 font-label-md text-label-md transition-colors font-medium shadow-xs"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              <span>New Project</span>
            </Link>
          )}
          <Link
            href="/projects"
            className="font-label-md text-label-md text-primary hover:text-on-primary-fixed-variant flex items-center gap-1 transition-colors"
          >
            <span>View All</span>
            <span className="material-symbols-outlined text-[16px]">
              arrow_forward
            </span>
          </Link>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="py-12 px-4 text-center flex flex-col items-center justify-center gap-2">
          <span className="material-symbols-outlined text-secondary text-[36px]">folder_open</span>
          <p className="font-title-md text-on-surface font-medium">No projects found</p>
          <p className="font-body-sm text-secondary max-w-sm">
            {isClient
              ? "Create your first project to define milestones and assign a registered freelancer."
              : "You do not have any assigned projects yet. When a client assigns you, projects will appear here."}
          </p>
          {isClient && (
            <Link
              href="/projects/new"
              className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white font-label-md font-semibold hover:bg-primary/90 transition-colors shadow-xs"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              <span>Create New Project</span>
            </Link>
          )}
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[580px] text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-low/70 rounded-lg">
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary rounded-l-lg">
                  Project
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary text-right">
                  Budget
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary">
                  Progress
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary">
                  Deadline
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary">
                  Status
                </th>
                <th className="py-2.5 px-2 font-label-md text-label-md text-secondary text-right rounded-r-lg"></th>
              </tr>
            </thead>
            <tbody className="divide-y-0">
              {projects.map((proj) => {
                const statusInfo = getStatusBadge(proj.status);
                const progressPct = calculateProgress(proj.milestones);

                return (
                  <tr
                    key={proj.id}
                    className="hover:bg-surface-container-low/50 transition-colors group"
                  >
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-surface-container-high overflow-hidden shrink-0 flex items-center justify-center shadow-xs">
                          {proj.image ? (
                            // eslint-disable-next-js/no-img-element
                            <img
                              className="w-full h-full object-cover"
                              alt={proj.title}
                              src={proj.image}
                            />
                          ) : (
                            <span className="material-symbols-outlined text-primary text-[20px]">
                              folder
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <Link
                            href={`/projects/${proj.id}`}
                            className="font-title-md text-title-md text-on-surface truncate hover:text-primary transition-colors max-w-[180px] sm:max-w-xs"
                          >
                            {proj.title}
                          </Link>
                          <span className="font-body-sm text-body-sm text-secondary truncate max-w-[180px] sm:max-w-xs">
                            {proj.description}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 font-body-md text-body-md text-on-surface text-right tabular-nums font-semibold">
                      ${proj.budget.toLocaleString()}
                    </td>
                    <td className="py-3 px-3 w-32 sm:w-36">
                      <div className="flex flex-col gap-1">
                        <span className="font-label-sm text-label-sm text-on-surface font-semibold tabular-nums">
                          {progressPct}%
                        </span>
                        <div className="w-full h-2 rounded-full bg-surface-container overflow-hidden">
                          <div
                            className="h-full bg-primary-container rounded-full transition-all duration-300"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 font-body-sm text-body-sm text-on-surface whitespace-nowrap">
                      {proj.deadline}
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-flex items-center font-label-sm text-label-sm font-semibold px-2.5 py-0.5 rounded-full ${statusInfo.color}`}
                      >
                        {statusInfo.label}
                      </span>
                    </td>
                    <td className="py-3 px-2 text-right">
                      <Link
                        href={`/projects/${proj.id}`}
                        className="inline-flex w-7 h-7 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container items-center justify-center transition-colors"
                        title="View Project"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          chevron_right
                        </span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
