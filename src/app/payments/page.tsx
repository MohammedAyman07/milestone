"use client";

import Link from "next/link";
import { useProjects } from "@/context/ProjectContext";
import { useAuth } from "@/context/AuthContext";

export default function PaymentsPage() {
  const { projects, activeRole } = useProjects();
  const { user: authUser } = useAuth();
  const isClient = (authUser?.role || activeRole) === "client";

  // Gather all milestones that have payment records or review statuses
  const paymentMilestones: Array<{
    projectId: string;
    projectTitle: string;
    milestoneId: string;
    milestoneTitle: string;
    amount: number;
    currency: string;
    paymentStatus: string;
    milestoneStatus: string;
    payeeName: string;
    payeeEmail: string;
    paypalOrderId?: string;
  }> = [];

  projects.forEach((proj) => {
    proj.milestones.forEach((m) => {
      if (
        m.paymentStatus === "authorized" ||
        m.paymentStatus === "captured" ||
        m.status === "under_review" ||
        m.status === "submitted"
      ) {
        paymentMilestones.push({
          projectId: proj.id,
          projectTitle: proj.title,
          milestoneId: m.id,
          milestoneTitle: m.title,
          amount: m.amount,
          currency: m.currency,
          paymentStatus: m.paymentStatus,
          milestoneStatus: m.status,
          payeeName: proj.freelancer?.name || "Assigned Freelancer",
          payeeEmail: proj.freelancer?.email || "No email",
          paypalOrderId: m.orderId,
        });
      }
    });
  });

  return (
    <div className="flex flex-col gap-space-lg w-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md">
        <div className="flex flex-col gap-1">
          <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
            Payment Authorizations &amp; Releases
          </h1>
          <p className="font-body-md text-body-md text-secondary">
            Manage pre-authorized PayPal holds, review verified milestone deliverables, and authorize release.
          </p>
        </div>

        <Link
          href="/transactions"
          className="px-4 py-2 bg-surface-container-low hover:bg-surface-container rounded-lg font-label-md text-label-md text-on-surface transition-colors flex items-center gap-1.5 font-medium self-start sm:self-auto border border-surface-container-high/60"
        >
          <span className="material-symbols-outlined text-[18px]">receipt_long</span>
          <span>View Transaction Ledgers</span>
        </Link>
      </div>

      {paymentMilestones.length === 0 ? (
        <div className="bg-surface-container-lowest rounded-xl p-space-xl border border-surface-container-low text-center flex flex-col items-center justify-center gap-3">
          <span className="material-symbols-outlined text-secondary text-[40px]">account_balance_wallet</span>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">No Active Payment Authorizations</h2>
          <p className="font-body-md text-secondary max-w-md">
            {isClient
              ? "Pre-authorize a payment hold on a milestone from your project workspace to manage holds and captures here."
              : "No payment holds or releases are currently active on your assigned milestones."}
          </p>
          <Link
            href="/projects"
            className="px-4 py-2 bg-primary text-white rounded-lg font-label-md font-semibold hover:bg-primary/90 transition-colors shadow-xs"
          >
            View Projects
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-space-md">
          {paymentMilestones.map((pm) => {
            const isAuthorized = pm.paymentStatus === "authorized";
            const isCaptured = pm.paymentStatus === "captured";

            return (
              <div
                key={pm.milestoneId}
                className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md"
              >
                <div className="flex items-center justify-between pb-space-xs border-b border-surface-container-low">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">
                      account_balance_wallet
                    </span>
                    <span className="font-label-md text-label-md uppercase tracking-wider text-secondary font-semibold">
                      Scope: {pm.projectTitle} • {pm.milestoneTitle}
                    </span>
                  </div>
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-label-sm font-label-sm font-semibold ${
                      isCaptured
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : isAuthorized
                        ? "bg-blue-50 text-blue-700 border border-blue-200"
                        : "bg-amber-50 text-amber-700 border border-amber-200"
                    }`}
                  >
                    {isCaptured
                      ? "Payment Captured"
                      : isAuthorized
                      ? "Pre-Authorization Hold"
                      : "Submission Under Review"}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md p-space-md bg-surface-container-low rounded-xl">
                  <div>
                    <span className="font-label-sm text-label-sm text-secondary uppercase block">
                      Payee (Freelancer)
                    </span>
                    <span className="font-title-md text-title-md text-on-surface font-semibold">
                      {pm.payeeName}
                    </span>
                    <span className="font-body-sm text-body-sm text-secondary block font-mono">
                      {pm.payeeEmail}
                    </span>
                  </div>

                  <div>
                    <span className="font-label-sm text-label-sm text-secondary uppercase block">
                      {isCaptured ? "Captured Amount" : "Authorized Hold Amount"}
                    </span>
                    <span className="font-metric-display text-[22px] leading-tight text-on-surface font-semibold tabular-nums">
                      ${pm.amount.toFixed(2)} {pm.currency}
                    </span>
                    {pm.paypalOrderId && (
                      <span className="font-label-sm text-label-sm text-primary block font-mono">
                        Order #{pm.paypalOrderId}
                      </span>
                    )}
                  </div>

                  <div>
                    <span className="font-label-sm text-label-sm text-secondary uppercase block">
                      Release Condition
                    </span>
                    <span className="font-title-md text-title-md text-on-surface font-semibold">
                      {isCaptured ? "Payment Captured to Merchant" : "Client Sign-Off Required"}
                    </span>
                    <span className="font-label-sm text-label-sm text-secondary block">
                      {isCaptured ? "Funds transferred via PayPal" : "Requires explicit client approval"}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-space-xs">
                  <span className="font-body-sm text-body-sm text-secondary">
                    {isCaptured
                      ? "Milestone approved and PayPal capture finalized."
                      : "Payment transfers via PayPal Merchant Capture once client approval is confirmed."}
                  </span>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/projects/${pm.projectId}`}
                      className="px-4 py-2 bg-surface-container-low hover:bg-surface-container rounded-lg font-label-md text-label-md text-on-surface font-medium transition-colors"
                    >
                      Project Workspace
                    </Link>
                    {isClient && !isCaptured && (
                      <Link
                        href={`/verification?milestoneId=${pm.milestoneId}`}
                        className="px-5 py-2 bg-primary text-white hover:bg-primary/90 rounded-lg font-title-md text-title-md font-semibold transition-colors shadow-xs"
                      >
                        Review Audit Before Release
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
