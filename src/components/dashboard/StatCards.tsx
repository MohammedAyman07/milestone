"use client";

import { useProjects } from "@/context/ProjectContext";

export default function StatCards() {
  const { projects, activeRole } = useProjects();
  const isClient = activeRole === "client";

  const totalValue = projects.reduce((acc, p) => acc + p.budget, 0);
  const activeCount = projects.filter(
    (p) => p.status === "in_progress" || p.status === "active"
  ).length;

  // Pending reviews/approvals
  const pendingApprovalsCount = projects.reduce((acc, p) => {
    return (
      acc +
      p.milestones.filter(
        (m) => m.status === "under_review" || m.status === "submitted"
      ).length
    );
  }, 0);

  // Completed captured milestones
  const completedCount = projects.reduce((acc, p) => {
    return (
      acc +
      p.milestones.filter(
        (m) => m.paymentStatus === "captured" || m.status === "completed"
      ).length
    );
  }, 0);

  const stats = [
    {
      title: isClient ? "Total Project Value" : "Total Contract Value",
      value: `$${totalValue.toLocaleString()}`,
      change: "12%",
      isPositive: true,
      icon: "folder",
      iconBgClass: "bg-surface-container-low",
      iconColorClass: "text-primary",
      sparklineColor: "text-primary",
      sparklinePath: "M2 24 C 20 23, 35 15, 50 16 C 65 17, 70 5, 78 4",
    },
    {
      title: isClient ? "Active Projects" : "Assigned Projects",
      value: `${activeCount}`,
      change: "0%",
      isPositive: true,
      icon: "business_center",
      iconBgClass: "bg-purple-50",
      iconColorClass: "text-purple-600",
      sparklineColor: "text-purple-500",
      sparklinePath: "M2 22 C 20 22, 30 25, 45 15 C 60 5, 68 18, 78 8",
    },
    {
      title: isClient ? "Pending Approvals" : "Under Review",
      value: `${pendingApprovalsCount}`,
      change: "",
      statusText: pendingApprovalsCount > 0 ? "Action Required" : "Up to Date",
      icon: "verified_user",
      iconBgClass: "bg-emerald-50",
      iconColorClass: "text-emerald-600",
      sparklineColor: "text-emerald-500",
      sparklinePath: "M2 22 C 22 22, 32 18, 48 20 C 62 22, 68 12, 78 12",
    },
    {
      title: isClient ? "Payments Captured" : "Earned & Settled",
      value: `${completedCount}`,
      change: "100%",
      isPositive: true,
      icon: "credit_card",
      iconBgClass: "bg-teal-50",
      iconColorClass: "text-teal-600",
      sparklineColor: "text-teal-500",
      sparklinePath: "M2 24 C 20 24, 35 24, 52 14 C 65 6, 70 8, 78 6",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-space-md">
      {stats.map((stat) => (
        <div
          key={stat.title}
          className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between border border-surface-container-low/50"
        >
          <div className="flex items-start justify-between">
            <div
              className={`w-10 h-10 rounded-lg ${stat.iconBgClass} flex items-center justify-center ${stat.iconColorClass}`}
            >
              <span className="material-symbols-outlined text-[22px]">
                {stat.icon}
              </span>
            </div>

            {stat.statusText ? (
              <div
                className={`flex items-center gap-1 font-label-sm text-label-sm font-semibold px-2 py-0.5 rounded-full ${
                  stat.statusText === "Action Required"
                    ? "text-amber-700 bg-amber-50"
                    : "text-emerald-700 bg-emerald-50"
                }`}
              >
                <span>{stat.statusText}</span>
              </div>
            ) : (
              <div
                className={`flex items-center gap-1 font-label-md text-label-md px-2 py-0.5 rounded-full ${
                  stat.isPositive
                    ? "text-emerald-600 bg-emerald-50"
                    : "text-purple-700 bg-purple-50"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">
                  arrow_upward
                </span>
                <span>{stat.change}</span>
              </div>
            )}
          </div>

          <div className="mt-space-md">
            <div className="flex items-center justify-between">
              <span className="font-label-md text-label-md uppercase tracking-wider text-secondary">
                {stat.title}
              </span>
              <span className="text-[10px] text-outline uppercase tracking-wider font-mono">
                Demo
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="font-metric-display text-metric-display text-on-surface tabular-nums">
                {stat.value}
              </span>
              <svg
                className={`w-20 h-7 ${stat.sparklineColor}`}
                fill="none"
                viewBox="0 0 80 28"
              >
                <path
                  d={stat.sparklinePath}
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2.5"
                />
              </svg>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
