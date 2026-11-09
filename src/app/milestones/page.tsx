"use client";

import { useState } from "react";
import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";

export default function MilestonesPage() {
  const { projects, activeRole } = useProjects();
  const [filter, setFilter] = useState<"all" | "in_progress" | "under_review" | "completed">("all");

  const allMilestones = projects.flatMap((p) =>
    (p.milestones || []).map((m) => ({
      ...m,
      projectTitle: p.title,
      projectCurrency: p.currency,
      freelancerName: p.freelancer?.name || "Freelancer",
      clientName: p.client?.name || "Client",
    }))
  );

  const filteredMilestones = allMilestones.filter((m) => {
    if (filter === "all") return true;
    if (filter === "in_progress") return m.status === "in_progress" || m.status === "pending";
    if (filter === "under_review") return m.status === "under_review" || m.status === "submitted";
    if (filter === "completed") return m.status === "completed" || m.status === "approved";
    return true;
  });

  return (
    <div className="flex flex-col gap-space-lg w-full">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
              Milestone Ledgers
            </h1>
            <span className="font-label-sm text-label-sm bg-surface-container px-2 py-0.5 rounded text-secondary font-mono">
              {filteredMilestones.length} {filteredMilestones.length === 1 ? "Milestone" : "Milestones"}
            </span>
          </div>
          <p className="font-body-md text-body-md text-secondary mt-1">
            Track deliverable phases, authorization holds, and verification sign-offs across all active scopes.
          </p>
        </div>

        <Link
          href="/submissions"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-container text-white rounded-lg font-label-md text-label-md hover:bg-primary transition-colors font-semibold shadow-xs self-start sm:self-auto"
        >
          <span className="material-symbols-outlined text-[18px]">upload</span>
          <span>Submit Deliverable</span>
        </Link>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-surface-container-high/60 pb-1">
        {(["all", "in_progress", "under_review", "completed"] as const).map((tab) => (
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
            {tab.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Milestones Cards Grid */}
      <div className="grid grid-cols-1 gap-space-md">
        {filteredMilestones.map((m) => {
          const isDone = m.status === "completed" || m.status === "approved";
          const isReview = m.status === "under_review" || m.status === "submitted";

          return (
            <div
              key={m.id}
              className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col sm:flex-row sm:items-center justify-between gap-space-md hover:shadow-md transition-shadow"
            >
              <div className="flex items-start gap-space-md">
                <div
                  className={`w-11 h-11 rounded-xl flex items-center justify-center font-bold text-label-md shrink-0 shadow-xs ${
                    isDone
                      ? "bg-emerald-50 text-emerald-700"
                      : isReview
                      ? "bg-amber-50 text-amber-700"
                      : "bg-surface-container-high text-primary"
                  }`}
                >
                  M{m.phase}
                </div>
                <div className="flex flex-col">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/projects/${m.projectId}`}
                      className="font-title-md text-title-md text-on-surface hover:text-primary transition-colors font-semibold"
                    >
                      {m.title}
                    </Link>
                    <span
                      className={`font-label-sm text-label-sm px-2.5 py-0.5 rounded-full font-semibold ${
                        isDone
                          ? "bg-emerald-50 text-emerald-700"
                          : isReview
                          ? "bg-amber-50 text-amber-700"
                          : "bg-blue-50 text-blue-700"
                      }`}
                    >
                      {isDone ? "Approved by Client" : isReview ? "Under AI Review" : "In Progress"}
                    </span>
                  </div>
                  <span className="font-body-sm text-body-sm text-secondary mt-0.5">
                    Project: <strong className="text-on-surface">{m.projectTitle}</strong> • Counterparty:{" "}
                    {activeRole === "client" ? m.freelancerName : m.clientName}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-space-lg shrink-0 justify-between sm:justify-end border-t sm:border-t-0 pt-2 sm:pt-0 border-surface-container-low">
                <div className="flex flex-col sm:items-end">
                  <span className="font-label-sm text-label-sm text-secondary uppercase">
                    Milestone Amount
                  </span>
                  <span className="font-metric-display text-[20px] leading-tight text-on-surface font-semibold tabular-nums">
                    ${m.amount.toFixed(2)} USD
                  </span>
                  <span className="font-label-sm text-label-sm text-secondary">
                    Due: {m.dueDate}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {isReview ? (
                    <Link
                      href="/verification"
                      className="px-3.5 py-2 bg-primary text-white rounded-lg font-label-md text-label-md hover:bg-primary/90 transition-colors flex items-center gap-1 font-semibold"
                    >
                      <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                      <span>Review Audit</span>
                    </Link>
                  ) : isDone ? (
                    <Link
                      href="/transactions"
                      className="px-3 py-2 bg-surface-container-low text-secondary rounded-lg font-label-md text-label-md flex items-center gap-1 hover:text-on-surface transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px]">receipt_long</span>
                      <span>Receipt</span>
                    </Link>
                  ) : (
                    <Link
                      href="/submissions"
                      className="px-3.5 py-2 bg-primary-container text-white rounded-lg font-label-md text-label-md hover:bg-primary transition-colors flex items-center gap-1 font-semibold"
                    >
                      <span className="material-symbols-outlined text-[16px]">upload</span>
                      <span>Submit</span>
                    </Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {filteredMilestones.length === 0 && (
          <div className="py-16 text-center bg-surface-container-lowest rounded-xl border border-surface-container-low flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined text-secondary text-[40px]">flag</span>
            <p className="font-title-md text-on-surface font-medium">No milestones found</p>
            <p className="font-body-sm text-secondary max-w-sm">
              No milestones have been defined yet. When projects with milestones are created, they will be listed here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
