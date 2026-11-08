import Link from "next/link";

export default function PaymentsPage() {
  return (
    <div className="flex flex-col gap-space-lg w-full">
      {/* Demo Transparency Banner */}
      <div className="bg-blue-50 border border-blue-200/80 rounded-xl p-space-md flex items-start gap-space-md">
        <span className="material-symbols-outlined text-primary text-[22px] shrink-0 mt-0.5">
          account_balance_wallet
        </span>
        <div className="flex flex-col">
          <span className="font-label-md text-label-md text-primary font-semibold uppercase tracking-wider">
            Demo Payment Console (Phase 2)
          </span>
          <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
            Demonstrates buyer-to-merchant payment authorization. Live PayPal Sandbox Orders and Captures REST endpoints will be integrated in Phase 4.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md">
        <div className="flex flex-col gap-1">
          <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
            Payment Authorizations &amp; Releases
          </h1>
          <p className="font-body-md text-body-md text-secondary">
            Manage pre-authorized payment holds, review verified milestone scopes, and authorize release.
          </p>
        </div>

        <Link
          href="/transactions"
          className="px-4 py-2 bg-surface-container-low hover:bg-surface-container rounded-lg font-label-md text-label-md text-on-surface transition-colors flex items-center gap-1.5 font-medium self-start sm:self-auto"
        >
          <span className="material-symbols-outlined text-[18px]">receipt_long</span>
          <span>View Transaction Ledgers</span>
        </Link>
      </div>

      {/* Main Payment Card */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70 flex flex-col gap-space-md">
        <div className="flex items-center justify-between pb-space-xs border-b border-surface-container-low">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[20px]">
              account_balance_wallet
            </span>
            <span className="font-label-md text-label-md uppercase tracking-wider text-secondary font-semibold">
              Pending Release Scope: Website Redesign (Milestone 2)
            </span>
          </div>
          <span className="bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full text-label-sm font-label-sm font-semibold">
            Pre-Authorization Hold
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md p-space-md bg-surface-container-low rounded-xl">
          <div>
            <span className="font-label-sm text-label-sm text-secondary uppercase block">
              Payee
            </span>
            <span className="font-title-md text-title-md text-on-surface font-semibold">
              Sarah Chen
            </span>
            <span className="font-body-sm text-body-sm text-secondary block font-mono">
              PAY-CHEN-7720
            </span>
          </div>

          <div>
            <span className="font-label-sm text-label-sm text-secondary uppercase block">
              Authorized Hold Amount
            </span>
            <span className="font-metric-display text-[22px] leading-tight text-on-surface font-semibold tabular-nums">
              $500.00 USD
            </span>
            <span className="font-label-sm text-label-sm text-primary">
              Order #ORD-9410-2
            </span>
          </div>

          <div>
            <span className="font-label-sm text-label-sm text-secondary uppercase block">
              Release Condition
            </span>
            <span className="font-title-md text-title-md text-on-surface font-semibold">
              Client Sign-Off Required
            </span>
            <span className="font-label-sm text-label-sm text-secondary">
              Hold valid for 6 days
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-space-xs">
          <span className="font-body-sm text-body-sm text-secondary">
            Payment will transfer via PayPal Merchant Capture once client approval is confirmed.
          </span>
          <Link
            href="/verification"
            className="px-5 py-2.5 bg-primary text-white hover:bg-primary/90 rounded-lg font-title-md text-title-md font-semibold transition-colors shadow-xs"
          >
            Review Audit Before Release
          </Link>
        </div>
      </div>
    </div>
  );
}
