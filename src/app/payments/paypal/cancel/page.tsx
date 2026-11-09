"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

function PayPalCancelContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const orderId = searchParams.get("token") || searchParams.get("orderId");
  const [cancelling, setCancelling] = useState(false);
  const [cancelStatus, setCancelStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleVoidAttempt = async () => {
    if (!orderId) {
      router.push("/projects");
      return;
    }

    setCancelling(true);
    setError(null);

    try {
      const supabase = createClient();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
      }

      const res = await fetch("/api/paypal/orders/cancel", {
        method: "POST",
        headers,
        body: JSON.stringify({
          orderId,
          reason: "User cancelled in PayPal checkout window",
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to void payment attempt.");
        return;
      }

      setCancelStatus("Payment attempt voided. Milestone is unlocked.");
      setTimeout(() => {
        if (data.projectId) {
          router.push(`/projects/${data.projectId}`);
        } else {
          router.push("/projects");
        }
      }, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Network error: ${msg}`);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center py-space-xl px-space-md w-full max-w-2xl mx-auto">
      <div className="bg-surface-container-lowest rounded-2xl p-space-xl border border-amber-200 shadow-sm w-full flex flex-col gap-space-lg">
        {/* Header */}
        <div className="flex items-start gap-space-md">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center shrink-0 shadow-xs">
            <span className="material-symbols-outlined text-[28px]">cancel</span>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-label-sm text-label-sm text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full font-semibold">
                Checkout Cancelled
              </span>
              {orderId && (
                <span className="font-label-sm text-label-sm font-mono text-secondary">
                  Order: {orderId}
                </span>
              )}
            </div>
            <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold mt-1">
              PayPal Authorization Cancelled
            </h2>
            <p className="font-body-md text-body-md text-secondary">
              You cancelled the PayPal approval checkout before confirming payment authorization.
            </p>
          </div>
        </div>

        {/* Financial Assurance Banner */}
        <div className="bg-surface-container-low rounded-xl p-space-md flex items-start gap-3 border border-surface-container-high/60">
          <span className="material-symbols-outlined text-primary text-[22px] shrink-0 mt-0.5">
            verified_user
          </span>
          <div className="flex flex-col">
            <span className="font-label-md text-label-md text-on-surface font-semibold">
              No Funds Transferred or Held
            </span>
            <p className="font-body-sm text-body-sm text-secondary mt-0.5">
              Your PayPal account was not charged and no funds were pre-authorized. You can return to your project milestone to retry approval whenever you are ready.
            </p>
          </div>
        </div>

        {/* Status or Error Notifications */}
        {cancelStatus && (
          <div className="p-3 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg text-body-sm flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">check</span>
            <span>{cancelStatus}</span>
          </div>
        )}

        {error && (
          <div className="p-3 bg-rose-50 text-rose-800 border border-rose-200 rounded-lg text-body-sm flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-space-sm pt-space-xs border-t border-surface-container-low">
          <Link
            href="/projects"
            className="w-full sm:w-auto px-4 py-2.5 rounded-lg border border-surface-container-high text-secondary hover:text-on-surface font-label-md text-label-md text-center transition-colors"
          >
            Back to Projects
          </Link>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {orderId && (
              <button
                type="button"
                onClick={handleVoidAttempt}
                disabled={cancelling}
                className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-surface-container-high text-on-surface hover:bg-surface-container-highest font-label-md text-label-md font-medium transition-colors disabled:opacity-50"
              >
                {cancelling ? "Voiding Attempt..." : "Unlock Milestone (Void Attempt)"}
              </button>
            )}

            <Link
              href="/milestones"
              className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-primary text-white hover:bg-primary/90 font-label-md text-label-md font-semibold text-center transition-colors shadow-xs"
            >
              View Milestones
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PayPalCancelPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20 w-full">
          <div className="w-10 h-10 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </div>
      }
    >
      <PayPalCancelContent />
    </Suspense>
  );
}
