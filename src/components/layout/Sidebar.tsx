"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useProjects } from "@/context/ProjectContext";

interface NavItem {
  name: string;
  href: string;
  icon: string;
  badge?: string;
}

const corePlatformItems: NavItem[] = [
  { name: "Overview", href: "/dashboard", icon: "dashboard" },
  { name: "My Projects", href: "/projects", icon: "folder_open" },
  { name: "Milestones", href: "/milestones", icon: "flag" },
  { name: "Submissions", href: "/submissions", icon: "task_alt" },
  {
    name: "AI Verification",
    href: "/verification",
    icon: "auto_awesome",
    badge: "Engine",
  },
];

const treasuryItems: NavItem[] = [
  { name: "Payments", href: "/payments", icon: "payments" },
  { name: "Transaction History", href: "/transactions", icon: "receipt_long" },
  { name: "Settings", href: "/settings", icon: "settings" },
];

export default function Sidebar({
  mobileOpen,
  onClose,
}: {
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const { activeRole, setActiveRole } = useProjects();

  const isLinkActive = (href: string) => {
    if (href === "/dashboard" && (pathname === "/" || pathname === "/dashboard")) {
      return true;
    }
    return pathname.startsWith(href) && href !== "/dashboard";
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-on-surface/30 backdrop-blur-xs lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed top-0 left-0 h-screen w-72 bg-surface-container-lowest shadow-[0_1px_8px_rgba(0,0,0,0.04)] border-r border-surface-container-low z-50 flex flex-col justify-between overflow-y-auto transition-transform duration-200 ease-in-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex flex-col">
          {/* Brand Header */}
          <div className="h-16 px-space-lg flex items-center justify-between border-b border-surface-container-low">
            <Link href="/dashboard" className="flex items-center gap-space-sm group">
              <div className="w-9 h-9 rounded-lg bg-primary-container flex items-center justify-center text-on-primary shadow-sm group-hover:bg-primary transition-colors">
                <span className="material-symbols-outlined text-[22px]">layers</span>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-space-xs">
                  <span className="font-title-md text-title-md tracking-tight text-on-surface">
                    milestone
                  </span>
                  <span className="font-label-sm text-label-sm uppercase bg-secondary-container text-on-secondary-container px-1.5 py-0.5 rounded font-semibold">
                    AI
                  </span>
                </div>
                <span className="font-label-sm text-label-sm text-secondary">
                  AI-powered project payments
                </span>
              </div>
            </Link>

            {onClose && (
              <button
                type="button"
                className="lg:hidden w-8 h-8 flex items-center justify-center rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container-low"
                onClick={onClose}
                aria-label="Close navigation"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            )}
          </div>

          {/* Role Switcher Pill (Client vs Freelancer View) */}
          <div className="px-space-md pt-3 pb-1">
            <div className="bg-surface-container-low p-1 rounded-lg flex items-center gap-1 border border-surface-container-high/60">
              <button
                type="button"
                onClick={() => setActiveRole("client")}
                className={`flex-1 py-1 px-2 rounded-md font-label-sm text-label-sm transition-all flex items-center justify-center gap-1 ${
                  activeRole === "client"
                    ? "bg-surface-container-lowest text-primary font-semibold shadow-xs"
                    : "text-secondary hover:text-on-surface"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">person</span>
                <span>Client View</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveRole("freelancer")}
                className={`flex-1 py-1 px-2 rounded-md font-label-sm text-label-sm transition-all flex items-center justify-center gap-1 ${
                  activeRole === "freelancer"
                    ? "bg-surface-container-lowest text-primary font-semibold shadow-xs"
                    : "text-secondary hover:text-on-surface"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">engineering</span>
                <span>Freelancer View</span>
              </button>
            </div>
          </div>

          {/* Navigation Sections */}
          <div className="px-space-md py-space-xs">
            {/* Core Platform */}
            <div className="font-label-sm text-label-sm uppercase tracking-wider text-secondary px-space-sm mb-space-xs mt-2">
              Core Platform
            </div>
            <nav className="flex flex-col gap-1">
              {corePlatformItems.map((item) => {
                const active = isLinkActive(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={onClose}
                    className={`flex items-center justify-between px-space-sm py-2 rounded-lg transition-colors ${
                      active
                        ? "bg-primary-container text-on-primary-container font-label-md text-label-md font-semibold shadow-xs"
                        : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface font-body-md text-body-md"
                    }`}
                  >
                    <div className="flex items-center gap-space-sm">
                      <span className="material-symbols-outlined text-[20px]">
                        {item.icon}
                      </span>
                      <span>{item.name}</span>
                    </div>
                    {item.badge && (
                      <span
                        className={`font-label-sm text-label-sm px-1.5 py-0.5 rounded-full font-medium ${
                          active
                            ? "bg-white/20 text-white"
                            : "bg-primary-fixed text-on-primary-fixed"
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* Treasury & Account */}
            <div className="font-label-sm text-label-sm uppercase tracking-wider text-secondary px-space-sm mt-space-md mb-space-xs">
              Treasury & Account
            </div>
            <nav className="flex flex-col gap-1">
              {treasuryItems.map((item) => {
                const active = isLinkActive(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={onClose}
                    className={`flex items-center gap-space-sm px-space-sm py-2 rounded-lg transition-colors ${
                      active
                        ? "bg-primary-container text-on-primary-container font-label-md text-label-md font-semibold shadow-xs"
                        : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface font-body-md text-body-md"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      {item.icon}
                    </span>
                    <span>{item.name}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Bottom Trust Card — Accurately describes AI-Assisted Verification & Client Approval */}
        <div className="p-space-md">
          <div className="bg-surface-container-low rounded-xl p-space-md flex flex-col gap-space-xs border border-surface-container-high/50">
            <div className="flex items-center justify-between">
              <span className="font-label-md text-label-md text-primary font-semibold tracking-wide">
                MILESTONE VERIFICATION
              </span>
              <span className="material-symbols-outlined text-primary text-[18px]">
                verified
              </span>
            </div>
            <span className="font-title-md text-title-md text-on-surface font-semibold">
              Verify Deliverables. Authorize Payouts.
            </span>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              AI-assisted contract inspection with explicit client authorization before payment release.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
