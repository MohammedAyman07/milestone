"use client";

import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useProjects } from "@/context/ProjectContext";

export default function SettingsPage() {
  const { user: authUser, signOut, isSupabaseConfigured } = useAuth();
  const { resetDemoData } = useProjects();

  return (
    <div className="flex flex-col gap-space-lg max-w-4xl w-full">
      <div className="flex flex-col gap-1">
        <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
          Account &amp; Workspace Settings
        </h1>
        <p className="font-body-md text-body-md text-secondary">
          Manage your verified account profile, role configuration, and workspace preferences.
        </p>
      </div>

      {/* Account Profile Card */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
        <div className="flex items-center justify-between pb-space-xs border-b border-surface-container-low">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[22px]">account_circle</span>
            <h2 className="font-title-md text-title-md text-on-surface">
              Account Profile
            </h2>
          </div>
          {isSupabaseConfigured && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-label-sm text-label-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
              <span>Supabase Authenticated</span>
            </span>
          )}
        </div>

        {authUser ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md pt-1">
            <div className="flex flex-col gap-1 p-3 bg-surface-container-low rounded-lg">
              <span className="font-label-sm text-secondary uppercase font-semibold text-[11px]">
                Full Name
              </span>
              <span className="font-title-md text-on-surface font-medium">
                {authUser.fullName || "Not Specified"}
              </span>
            </div>

            <div className="flex flex-col gap-1 p-3 bg-surface-container-low rounded-lg">
              <span className="font-label-sm text-secondary uppercase font-semibold text-[11px]">
                Registered Email
              </span>
              <span className="font-title-md text-on-surface font-medium font-mono text-[14px]">
                {authUser.email}
              </span>
            </div>

            <div className="flex flex-col gap-1 p-3 bg-surface-container-low rounded-lg">
              <span className="font-label-sm text-secondary uppercase font-semibold text-[11px]">
                Account Role
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="material-symbols-outlined text-primary text-[18px]">
                  {authUser.role === "client" ? "person" : "engineering"}
                </span>
                <span className="font-title-md text-on-surface font-semibold capitalize">
                  {authUser.role === "client" ? "Client Account" : "Freelancer Account"}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1 p-3 bg-surface-container-low rounded-lg">
              <span className="font-label-sm text-secondary uppercase font-semibold text-[11px]">
                User ID (UUID)
              </span>
              <span className="font-body-sm text-secondary font-mono truncate text-[12px]">
                {authUser.id}
              </span>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined text-secondary text-[36px]">no_accounts</span>
            <p className="font-title-md text-on-surface font-medium">Not currently signed in</p>
            <p className="font-body-sm text-secondary max-w-sm">
              Sign in to your Client or Freelancer account to access authenticated projects and payments.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Link
                href="/login"
                className="px-4 py-2 bg-primary text-white font-label-md font-semibold rounded-lg hover:bg-primary/90 transition-colors shadow-xs"
              >
                Sign In
              </Link>
              <Link
                href="/signup"
                className="px-4 py-2 bg-surface-container-low text-on-surface border border-surface-container-high font-label-md font-semibold rounded-lg hover:bg-surface-container transition-colors"
              >
                Register
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Role Capabilities Card */}
      {authUser && (
        <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
          <div className="flex items-center gap-2 pb-space-xs border-b border-surface-container-low">
            <span className="material-symbols-outlined text-primary text-[22px]">security</span>
            <h2 className="font-title-md text-title-md text-on-surface">
              Account Role &amp; Permissions
            </h2>
          </div>

          {authUser.role === "client" ? (
            <div className="p-space-md rounded-xl bg-primary-container/10 border border-primary/20 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">verified_user</span>
                <span className="font-title-md text-on-surface font-semibold">Client Permissions</span>
              </div>
              <ul className="list-disc list-inside text-body-sm text-on-surface-variant space-y-1">
                <li>Create new projects and scope measurable milestones with acceptance criteria</li>
                <li>Assign projects strictly to registered freelancers by verified email</li>
                <li>Pre-authorize payment holds via PayPal Sandbox (AUTHORIZE intent)</li>
                <li>Review AI verification audit reports and execute milestone approval or request revisions</li>
                <li>Trigger PayPal capture execution upon verified deliverable approval</li>
              </ul>
            </div>
          ) : (
            <div className="p-space-md rounded-xl bg-purple-50 border border-purple-200 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-purple-700 text-[20px]">engineering</span>
                <span className="font-title-md text-on-surface font-semibold">Freelancer Permissions</span>
              </div>
              <ul className="list-disc list-inside text-body-sm text-on-surface-variant space-y-1">
                <li>Access projects specifically assigned to your registered email address</li>
                <li>Inspect detailed acceptance criteria and milestone delivery requirements</li>
                <li>Upload deliverable files to private storage and provide live staging links</li>
                <li>Trigger automated Gemini AI multi-modal verification on submitted deliverables</li>
                <li>Receive client approval notifications and verified milestone completions</li>
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Cache & Session Management */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
        <div className="flex items-center gap-2 pb-space-xs border-b border-surface-container-low">
          <span className="material-symbols-outlined text-secondary text-[22px]">cleaning_services</span>
          <h2 className="font-title-md text-title-md text-on-surface">
            Session &amp; Cache Management
          </h2>
        </div>
        <p className="font-body-sm text-body-sm text-secondary">
          Clear cached browser storage if you want to refresh all state directly from the server database.
        </p>

        <div className="flex flex-wrap items-center justify-between gap-space-sm pt-2">
          <button
            type="button"
            onClick={() => {
              resetDemoData();
              alert("Browser local cache cleared successfully.");
            }}
            className="px-4 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-label-md transition-colors border border-surface-container-high/60"
          >
            Clear Local Browser Cache
          </button>

          {authUser && (
            <button
              type="button"
              onClick={() => signOut()}
              className="px-4 py-2 rounded-lg bg-error/10 hover:bg-error/20 text-error font-label-md text-label-md font-semibold transition-colors flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">logout</span>
              <span>Sign Out of Supabase</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
