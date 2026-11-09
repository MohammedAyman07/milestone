"use client";

import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";

interface ActivityItem {
  id: string;
  title: string;
  subtitle: string;
  time: string;
  icon: string;
  iconBgClass: string;
  iconColorClass: string;
  link: string;
}

export default function RecentActivityList() {
  const { projects, activeRole } = useProjects();
  const isClient = activeRole === "client";

  // Derive dynamic real activities from actual projects and milestones
  const activities: ActivityItem[] = [];

  projects.forEach((proj) => {
    proj.milestones.forEach((m) => {
      if (m.paymentStatus === "captured") {
        activities.push({
          id: `act-cap-${m.id}`,
          title: `Milestone captured: "${m.title}"`,
          subtitle: `$${m.amount.toFixed(2)} ${m.currency} captured for ${proj.title}`,
          time: "Recent",
          icon: "check_circle",
          iconBgClass: "bg-teal-50",
          iconColorClass: "text-teal-600",
          link: `/projects/${proj.id}`,
        });
      } else if (m.status === "under_review" || m.status === "submitted") {
        activities.push({
          id: `act-rev-${m.id}`,
          title: `Milestone verification ready: "${m.title}"`,
          subtitle: `Deliverable submitted for ${proj.title} • Review required`,
          time: "Pending",
          icon: "fact_check",
          iconBgClass: "bg-emerald-50",
          iconColorClass: "text-emerald-600",
          link: `/verification?milestoneId=${m.id}`,
        });
      } else if (m.paymentStatus === "authorized") {
        activities.push({
          id: `act-auth-${m.id}`,
          title: `PayPal hold active: $${m.amount.toFixed(2)} ${m.currency}`,
          subtitle: `Pre-authorization hold for "${m.title}" in ${proj.title}`,
          time: "Active",
          icon: "lock",
          iconBgClass: "bg-blue-50",
          iconColorClass: "text-primary",
          link: `/projects/${proj.id}`,
        });
      }
    });

    activities.push({
      id: `act-proj-${proj.id}`,
      title: `Project workspace: "${proj.title}"`,
      subtitle: `Budget: $${proj.budget.toLocaleString()} ${proj.currency}`,
      time: proj.deadline ? `Due ${proj.deadline}` : "Active",
      icon: "folder",
      iconBgClass: "bg-surface-container",
      iconColorClass: "text-primary",
      link: `/projects/${proj.id}`,
    });
  });

  return (
    <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/50">
      <div className="flex items-center justify-between mb-space-sm">
        <div className="flex items-center gap-2">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            Recent Activity
          </h2>
          <span className="font-label-sm text-label-sm bg-surface-container px-2 py-0.5 rounded text-secondary font-mono">
            {activities.length} {activities.length === 1 ? "Event" : "Events"}
          </span>
        </div>
        <Link
          href="/transactions"
          className="font-label-md text-label-md text-primary hover:text-on-primary-fixed-variant flex items-center gap-1 transition-colors"
        >
          <span>Ledger Details</span>
          <span className="material-symbols-outlined text-[16px]">
            arrow_forward
          </span>
        </Link>
      </div>
      <p className="text-xs text-on-surface-variant mb-space-md">
        Real-time audit log of your project milestones, verification reviews, and payment releases.
      </p>

      {activities.length === 0 ? (
        <div className="py-8 text-center flex flex-col items-center justify-center gap-2">
          <span className="material-symbols-outlined text-secondary text-[32px]">history</span>
          <p className="font-body-md text-secondary">No recent activity yet.</p>
          <p className="font-body-sm text-secondary/70 max-w-sm">
            {isClient
              ? "Create a project, pre-authorize a milestone hold, or invite a freelancer to see activity."
              : "When a client assigns you to a project or updates milestone scopes, events will appear here."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-space-md">
          {activities.slice(0, 6).map((act) => (
            <Link
              key={act.id}
              href={act.link}
              className="flex items-start justify-between gap-space-md p-2 rounded-lg hover:bg-surface-container-low transition-colors group"
            >
              <div className="flex items-center gap-space-md min-w-0">
                <div
                  className={`w-9 h-9 rounded-full ${act.iconBgClass} ${act.iconColorClass} flex items-center justify-center shrink-0 shadow-xs`}
                >
                  <span className="material-symbols-outlined text-[20px]">
                    {act.icon}
                  </span>
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-title-md text-title-md text-on-surface group-hover:text-primary transition-colors truncate">
                    {act.title}
                  </span>
                  <span className="font-body-sm text-body-sm text-secondary truncate">
                    {act.subtitle}
                  </span>
                </div>
              </div>
              <span className="font-label-sm text-label-sm text-secondary whitespace-nowrap shrink-0">
                {act.time}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
