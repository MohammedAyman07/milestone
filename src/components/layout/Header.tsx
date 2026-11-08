"use client";

import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";
import { useAuth } from "@/context/AuthContext";

interface HeaderProps {
  onOpenMobileMenu?: () => void;
}

export default function Header({ onOpenMobileMenu }: HeaderProps) {
  const { activeRole } = useProjects();
  const { user: authUser, signOut, isSupabaseConfigured } = useAuth();

  const displayName = authUser?.fullName || (activeRole === "client" ? "Mohammed Ayman" : "Sarah Chen");
  const displayRole = authUser?.role ? (authUser.role === "client" ? "Client" : "Freelancer") : (activeRole === "client" ? "Client (Demo)" : "Freelancer (Demo)");
  const avatarIcon = (authUser?.role || activeRole) === "client" ? "person" : "engineering";

  return (
    <header className="fixed top-0 left-0 lg:left-72 right-0 h-16 bg-surface-container-lowest/90 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border-b border-surface-container-low z-40 flex items-center justify-between px-space-md lg:px-space-lg">
      {/* Left Search Bar + Mobile Menu Trigger */}
      <div className="flex items-center gap-space-sm flex-1 max-w-xl">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden w-9 h-9 rounded-lg bg-surface-container-low flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors shrink-0"
          aria-label="Open sidebar menu"
        >
          <span className="material-symbols-outlined text-[20px]">menu</span>
        </button>

        <div className="relative flex items-center w-full">
          <span className="material-symbols-outlined absolute left-3 text-secondary text-[20px] pointer-events-none">
            search
          </span>
          <input
            className="w-full h-10 pl-10 pr-space-md bg-surface-container-low rounded-lg text-on-surface placeholder:text-secondary focus:outline-none focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary font-body-sm text-body-sm transition-all"
            placeholder="Search projects, milestones, deliverables, payouts..."
            type="text"
          />
        </div>
      </div>

      {/* Right Controls: Supabase Auth Status, Notifications & User Profile */}
      <div className="flex items-center gap-space-md ml-3">
        {/* Backend State Indicator */}
        {isSupabaseConfigured ? (
          <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-label-sm text-label-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
            <span>Supabase RLS Active</span>
          </div>
        ) : (
          <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-label-sm text-label-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-pulse" />
            <span>Dev / Demo Storage Mode</span>
          </div>
        )}

        <button
          className="relative w-9 h-9 rounded-lg bg-surface-container-low flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
          type="button"
          aria-label="View notifications"
        >
          <span className="material-symbols-outlined text-[20px]">notifications</span>
          <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-error" />
        </button>

        <div className="flex items-center gap-space-sm pl-space-xs border-l border-surface-container-high">
          {authUser ? (
            <div className="flex items-center gap-2">
              <div className="flex flex-col text-right hidden sm:flex">
                <span className="font-label-md text-label-md text-on-surface font-semibold">
                  {displayName}
                </span>
                <span className="font-label-sm text-label-sm text-secondary">
                  {displayRole}
                </span>
              </div>
              <button
                type="button"
                onClick={() => signOut()}
                className="p-1 rounded text-secondary hover:text-error transition-colors"
                title="Sign out of Supabase"
              >
                <span className="material-symbols-outlined text-[18px]">logout</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex flex-col text-right hidden sm:flex">
                <span className="font-label-md text-label-md text-on-surface font-semibold">
                  {displayName}
                </span>
                <span className="font-label-sm text-label-sm text-secondary">
                  {displayRole}
                </span>
              </div>
              <Link
                href="/login"
                className="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-primary font-label-sm text-label-sm rounded font-medium transition-colors"
              >
                Sign In
              </Link>
            </div>
          )}

          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary shadow-xs">
            <span className="material-symbols-outlined text-[18px]">
              {avatarIcon}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
