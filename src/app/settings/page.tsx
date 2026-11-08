"use client";

import { useProjects } from "@/context/ProjectContext";

export default function SettingsPage() {
  const { activeRole, setActiveRole, resetDemoData } = useProjects();

  return (
    <div className="flex flex-col gap-space-lg max-w-4xl w-full">
      <div className="flex flex-col gap-1">
        <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
          Workspace Settings
        </h1>
        <p className="font-body-md text-body-md text-secondary">
          Configure demo testing parameters, active simulation perspectives, and storage state.
        </p>
      </div>

      {/* Role Management Card */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
        <div className="flex items-center gap-2 pb-space-xs border-b border-surface-container-low">
          <span className="material-symbols-outlined text-primary text-[22px]">badge</span>
          <h2 className="font-title-md text-title-md text-on-surface">
            Active Testing Persona
          </h2>
        </div>
        <p className="font-body-sm text-body-sm text-secondary">
          Switch roles to audit both sides of the contract workflow without logging out.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-md">
          <div
            onClick={() => setActiveRole("client")}
            className={`p-space-md rounded-xl cursor-pointer border transition-all flex flex-col gap-1 ${
              activeRole === "client"
                ? "bg-primary-container/10 border-primary shadow-xs"
                : "bg-surface-container-low border-surface-container-high/60 hover:bg-surface-container"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-title-md text-title-md text-on-surface font-semibold">
                Mohammed Ayman
              </span>
              {activeRole === "client" && (
                <span className="material-symbols-outlined text-primary text-[20px]">
                  check_circle
                </span>
              )}
            </div>
            <span className="font-label-sm text-label-sm text-primary font-medium">
              Client • Product Director
            </span>
            <p className="font-body-sm text-body-sm text-secondary mt-1">
              Can create projects, scope milestones, pre-authorize holds, and sign off on verification releases.
            </p>
          </div>

          <div
            onClick={() => setActiveRole("freelancer")}
            className={`p-space-md rounded-xl cursor-pointer border transition-all flex flex-col gap-1 ${
              activeRole === "freelancer"
                ? "bg-primary-container/10 border-primary shadow-xs"
                : "bg-surface-container-low border-surface-container-high/60 hover:bg-surface-container"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-title-md text-title-md text-on-surface font-semibold">
                Sarah Chen
              </span>
              {activeRole === "freelancer" && (
                <span className="material-symbols-outlined text-primary text-[20px]">
                  check_circle
                </span>
              )}
            </div>
            <span className="font-label-sm text-label-sm text-primary font-medium">
              Freelancer • Senior UI/UX Engineer
            </span>
            <p className="font-body-sm text-body-sm text-secondary mt-1">
              Can review assigned requirements, upload staging evidence, and trigger automated compliance checks.
            </p>
          </div>
        </div>
      </div>

      {/* State & Reset Card */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
        <div className="flex items-center gap-2 pb-space-xs border-b border-surface-container-low">
          <span className="material-symbols-outlined text-secondary text-[22px]">restart_alt</span>
          <h2 className="font-title-md text-title-md text-on-surface">
            Session &amp; Demo Data Reset
          </h2>
        </div>
        <p className="font-body-sm text-body-sm text-secondary">
          Reset all newly created projects, milestones, and submitted artifacts back to the initial baseline demo state.
        </p>

        <div className="flex items-center justify-between pt-2">
          <span className="font-body-sm text-body-sm text-secondary">
            Clears browser localStorage for Milestone AI
          </span>
          <button
            type="button"
            onClick={() => {
              if (confirm("Reset demo projects and submissions to initial state?")) {
                resetDemoData();
                alert("Demo data reset to initial baseline.");
              }
            }}
            className="px-4 py-2 rounded-lg bg-surface-container-low hover:bg-error/10 hover:text-error text-secondary font-label-md text-label-md transition-colors"
          >
            Reset Demo Data
          </button>
        </div>
      </div>
    </div>
  );
}
