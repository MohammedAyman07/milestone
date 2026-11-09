"use client";

import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";

export default function RecentActivityList() {
  const { activeRole } = useProjects();
  const isClient = activeRole === "client";

  const clientActivities = [
    {
      id: "act-1",
      title: 'AI-assisted milestone verification ready for "Website Redesign"',
      subtitle: "Milestone 2 deliverable audited • Client review required",
      time: "2h ago",
      icon: "fact_check",
      iconBgClass: "bg-emerald-50",
      iconColorClass: "text-emerald-600",
      link: "/verification",
    },
    {
      id: "act-2",
      title: "PayPal merchant authorization hold: $500.00 (Order #ORD-9410-2)",
      subtitle: "Authorization active in PayPal sandbox pending explicit client milestone approval",
      time: "3h ago",
      icon: "payments",
      iconBgClass: "bg-blue-50",
      iconColorClass: "text-primary-container",
      link: "/payments",
    },
    {
      id: "act-3",
      title: 'New submission received for "Website Redesign"',
      subtitle: "Evidence uploaded to private storage • Staging preview live",
      time: "5h ago",
      icon: "upload",
      iconBgClass: "bg-surface-container",
      iconColorClass: "text-primary",
      link: "/submissions",
    },
    {
      id: "act-4",
      title: "Client-approved milestone: PayPal merchant capture: $250.00",
      subtitle: "Captured to merchant receiving account (DVR5YSMVVNHMJ) via Payments v2",
      time: "2d ago",
      icon: "check_circle",
      iconBgClass: "bg-teal-50",
      iconColorClass: "text-teal-600",
      link: "/transactions",
    },
  ];

  const freelancerActivities = [
    {
      id: "act-f1",
      title: 'Deliverables submitted for "Website Redesign"',
      subtitle: "AI-assisted milestone verification underway • Awaiting client review",
      time: "2h ago",
      icon: "task_alt",
      iconBgClass: "bg-blue-50",
      iconColorClass: "text-primary",
      link: "/submissions",
    },
    {
      id: "act-f2",
      title: "PayPal merchant authorization verified: $500.00 hold confirmed",
      subtitle: "Authoritative hold verified on PayPal; captured only upon client milestone approval",
      time: "3h ago",
      icon: "lock",
      iconBgClass: "bg-surface-container",
      iconColorClass: "text-secondary",
      link: "/projects/website-redesign",
    },
    {
      id: "act-f3",
      title: "Milestone 1 captured: $250.00",
      subtitle: "PayPal merchant capture completed to merchant account",
      time: "2d ago",
      icon: "payments",
      iconBgClass: "bg-emerald-50",
      iconColorClass: "text-emerald-600",
      link: "/transactions",
    },
    {
      id: "act-f4",
      title: 'Assigned to new scope: "Website Redesign - Phase 3"',
      subtitle: "$500.00 milestone budget • Target due Dec 05, 2026",
      time: "3d ago",
      icon: "folder",
      iconBgClass: "bg-surface-container",
      iconColorClass: "text-secondary",
      link: "/projects/website-redesign",
    },
  ];

  const activities = isClient ? clientActivities : freelancerActivities;

  return (
    <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/50">
      <div className="flex items-center justify-between mb-space-sm">
        <div className="flex items-center gap-2">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            Recent Activity
          </h2>
          <span className="font-label-sm text-label-sm bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-mono">
            Illustrative Activity
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
        Illustrates the verified MILESTONE AI lifecycle: AI verification, client milestone approval, and PayPal merchant authorization &amp; capture.
      </p>

      <div className="flex flex-col gap-space-md">
        {activities.map((act) => (
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
                <span className="font-body-sm text-body-sm text-secondary">
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
    </div>
  );
}
