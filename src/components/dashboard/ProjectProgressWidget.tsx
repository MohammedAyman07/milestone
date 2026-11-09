"use client";

import { useProjects } from "@/context/ProjectContext";

export default function ProjectProgressWidget() {
  const { projects } = useProjects();

  const totalMilestones = projects.reduce((acc, p) => acc + (p.milestones || []).length, 0);
  const completedMilestones = projects.reduce(
    (acc, p) =>
      acc +
      (p.milestones || []).filter(
        (m) => m.status === "completed" || m.status === "approved" || m.paymentStatus === "captured"
      ).length,
    0
  );

  const pct = totalMilestones > 0 ? Math.round((completedMilestones / totalMilestones) * 100) : 0;
  const dashOffset = Math.round(314 - (314 * pct) / 100);

  const steps = [
    { title: "Contract Setup", status: projects.length > 0 ? "completed" : "current" },
    {
      title: "Milestone Scoping",
      status: totalMilestones > 0 ? "completed" : projects.length > 0 ? "current" : "upcoming",
    },
    {
      title: "Payment Pre-Authorized",
      status: projects.some((p) =>
        (p.milestones || []).some((m) => m.paymentStatus === "authorized" || m.paymentStatus === "captured")
      )
        ? "completed"
        : totalMilestones > 0
        ? "current"
        : "upcoming",
    },
    {
      title: "Deliverable Submitted",
      status: projects.some((p) =>
        (p.milestones || []).some(
          (m) =>
            m.status === "submitted" ||
            m.status === "under_review" ||
            m.status === "completed" ||
            m.status === "approved"
        )
      )
        ? "completed"
        : "upcoming",
    },
    {
      title: "Verification & Sign-Off",
      status: completedMilestones > 0 ? "completed" : "upcoming",
    },
  ];

  return (
    <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/50">
      <div className="flex items-center justify-between mb-space-md">
        <h2 className="font-headline-sm text-headline-sm text-on-surface">
          Active Milestone Lifecycle
        </h2>
        <span className="font-label-sm text-label-sm text-secondary font-mono">
          {completedMilestones} of {totalMilestones} Completed
        </span>
      </div>

      <div className="flex flex-col sm:flex-row items-center sm:items-start gap-space-lg">
        {/* Circular Donut Chart */}
        <div className="relative w-36 h-36 shrink-0 flex items-center justify-center">
          <svg
            className="w-full h-full -rotate-90 transform"
            viewBox="0 0 120 120"
          >
            {/* Background ring */}
            <circle
              className="text-surface-container"
              cx="60"
              cy="60"
              fill="none"
              r="50"
              stroke="currentColor"
              strokeWidth="12"
            />
            {/* Dynamic Progress ring */}
            <circle
              className="text-primary-container"
              cx="60"
              cy="60"
              fill="none"
              r="50"
              stroke="currentColor"
              strokeDasharray="314"
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="12"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-metric-display text-metric-display text-on-surface font-bold leading-none">
              {pct}%
            </span>
            <span className="font-label-sm text-label-sm text-secondary mt-0.5">
              Overall
            </span>
          </div>
        </div>

        {/* Step Progress Checklist */}
        <div className="flex flex-col gap-space-sm w-full">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-center gap-space-sm">
              {step.status === "completed" && (
                <div className="w-5 h-5 rounded-full bg-primary-container text-on-primary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-[14px]">
                    check
                  </span>
                </div>
              )}
              {step.status === "current" && (
                <div className="w-5 h-5 rounded-full bg-primary-container flex items-center justify-center shrink-0">
                  <div className="w-2 h-2 rounded-full bg-white" />
                </div>
              )}
              {step.status === "upcoming" && (
                <div className="w-5 h-5 rounded-full bg-surface-container flex items-center justify-center shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-outline-variant" />
                </div>
              )}

              <span
                className={`font-body-sm text-body-sm ${
                  step.status === "completed"
                    ? "text-on-surface font-medium"
                    : step.status === "current"
                    ? "text-primary font-semibold"
                    : "text-secondary"
                }`}
              >
                {step.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
