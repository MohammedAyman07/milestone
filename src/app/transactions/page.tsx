"use client";

import { useProjects } from "@/context/ProjectContext";

export default function TransactionsPage() {
  const { transactions } = useProjects();

  return (
    <div className="flex flex-col gap-space-lg w-full">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
            Transaction History &amp; Ledgers
          </h1>
          <span className="font-label-sm text-label-sm bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-mono">
            Illustrative Sandbox Ledger
          </span>
        </div>
        <p className="font-body-md text-body-md text-secondary">
          Audit trail of PayPal merchant authorization holds, client milestone approvals, and merchant capture executions.
        </p>
      </div>

      {/* Trust Notice */}
      <div className="bg-surface-container-low rounded-xl p-space-md border border-surface-container-high/60 flex items-start gap-space-md">
        <div className="w-10 h-10 rounded-lg bg-primary-container text-white flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-[22px]">account_balance</span>
        </div>
        <div className="flex flex-col">
          <span className="font-title-md text-title-md text-on-surface font-semibold">
            Merchant Processing &amp; Authorization Model
          </span>
          <p className="font-body-sm text-body-sm text-secondary mt-0.5 max-w-3xl">
            Payments use standard PayPal merchant authorization. Pre-authorized amounts are held against the buyer&apos;s account until explicit client approval initiates PayPal merchant capture. Standard capture pays the receiving merchant account directly and does not provide an escrow service or automatic freelancer payouts.
          </p>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/70">
        <div className="overflow-x-auto -mx-space-lg px-space-lg">
          <table className="w-full min-w-[700px] text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-low/70 rounded-lg">
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary rounded-l-lg">
                  Transaction Ref
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary">
                  Project &amp; Milestone
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary">
                  Payee / Counterparty
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary text-right">
                  Amount
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary">
                  Date
                </th>
                <th className="py-2.5 px-3 font-label-md text-label-md text-secondary text-right rounded-r-lg">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y-0">
              {transactions.map((tx) => (
                <tr
                  key={tx.id}
                  className="hover:bg-surface-container-low/50 transition-colors"
                >
                  <td className="py-3 px-3">
                    <span className="font-mono text-label-md font-semibold text-primary">
                      {tx.transactionRef}
                    </span>
                    <span className="text-[11px] text-secondary block font-mono">
                      Order: {tx.paypalOrderId}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-col">
                      <span className="font-title-md text-title-md text-on-surface">
                        {tx.projectName}
                      </span>
                      <span className="font-body-sm text-body-sm text-secondary truncate max-w-xs">
                        {tx.milestoneTitle}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3 font-body-sm text-body-sm text-on-surface">
                    {tx.payee}
                  </td>
                  <td className="py-3 px-3 font-body-md text-body-md text-on-surface text-right tabular-nums font-semibold">
                    ${tx.amount.toFixed(2)} {tx.currency}
                  </td>
                  <td className="py-3 px-3 font-body-sm text-body-sm text-secondary whitespace-nowrap">
                    {tx.date}
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span
                      className={`inline-flex items-center font-label-sm text-label-sm font-semibold px-2.5 py-0.5 rounded-full ${
                        tx.status === "CAPTURED" || tx.status === "SETTLED"
                          ? "bg-emerald-50 text-emerald-700"
                          : tx.status === "AUTHORIZED"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {tx.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
