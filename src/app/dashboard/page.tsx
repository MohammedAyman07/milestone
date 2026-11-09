"use client";

import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";
import { useAuth } from "@/context/AuthContext";
import StatCards from "@/components/dashboard/StatCards";
import ActiveProjectsTable from "@/components/dashboard/ActiveProjectsTable";
import RecentActivityList from "@/components/dashboard/RecentActivityList";
import ProjectProgressWidget from "@/components/dashboard/ProjectProgressWidget";
import TrustSpotlightBanner from "@/components/dashboard/TrustSpotlightBanner";

export default function DashboardPage() {
  const { activeRole } = useProjects();
  const { user: authUser } = useAuth();

  const isClient = (authUser?.role || activeRole) === "client";
  const userName = authUser?.fullName || (authUser?.email ? authUser.email.split("@")[0] : (isClient ? "Client" : "Freelancer"));

  return (
    <div className="flex flex-col w-full gap-space-lg">
      {/* Welcome & Top Alert Banner */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-space-md">
        <div className="flex flex-col">
          <div className="flex items-center gap-space-xs">
            <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
              Welcome back, {userName}!
            </h1>
            <span aria-label="waving hand" className="text-2xl select-none" role="img">
              👋
            </span>
          </div>
          <p className="font-body-md text-body-md text-secondary mt-1">
            {isClient
              ? "Turn your project scopes into verified deliverables with AI-assisted criteria checks and client-approved payments."
              : "Track your assigned milestone deliverables, review automated inspection criteria, and prepare handover packages."}
          </p>
        </div>

        {/* Blue Trust Callout Banner */}
        <div className="w-full lg:w-auto min-w-[360px] bg-primary-container text-on-primary rounded-xl px-space-lg py-3.5 shadow-sm flex items-center justify-between gap-space-md relative overflow-hidden group hover:shadow-md transition-shadow">
          <div className="absolute -right-6 -bottom-6 w-28 h-28 bg-white/10 rounded-full blur-xl pointer-events-none" />
          <div className="flex items-center gap-space-md z-10">
            <div className="w-10 h-10 rounded-lg bg-white/20 backdrop-blur-md flex items-center justify-center text-on-primary shrink-0">
              <span className="material-symbols-outlined text-[24px]">
                {isClient ? "verified_user" : "task_alt"}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-title-md text-title-md leading-tight text-white font-semibold">
                {isClient ? "Secure. Transparent. Reliable." : "Milestone Delivery Console"}
              </span>
              <span className="font-label-sm text-label-sm text-white/80 mt-0.5">
                {isClient
                  ? "AI-assisted verification. Client-approved payments."
                  : "Transparent criteria. Rapid milestone sign-off."}
              </span>
            </div>
          </div>
          <Link
            href={isClient ? "/verification" : "/submissions"}
            aria-label={isClient ? "View verification summary" : "Go to submissions"}
            className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors shrink-0 z-10"
          >
            <span className="material-symbols-outlined text-[18px]">
              arrow_forward
            </span>
          </Link>
        </div>
      </div>

      {/* 4 Stat Metric Cards */}
      <StatCards />

      {/* Main 2-Column Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
        {/* Left Column (Span 7 on lg, 8 on xl) */}
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col gap-space-lg">
          <ActiveProjectsTable />
          <RecentActivityList />
        </div>

        {/* Right Column (Span 5 on lg, 4 on xl) */}
        <div className="lg:col-span-5 xl:col-span-4 flex flex-col gap-space-lg">
          <ProjectProgressWidget />
          <TrustSpotlightBanner />
        </div>
      </div>
    </div>
  );
}
