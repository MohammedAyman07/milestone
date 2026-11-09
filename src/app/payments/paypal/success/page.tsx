"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface ApprovalDetails {
  orderId: string;
  paymentAttemptId: string;
  milestoneId: string;
  projectId?: string;
  amount: number;
  currency: string;
  payerId?: string;
  payerEmail?: string;
  status: string;
  alreadyApproved?: boolean;
}

interface AuthDetails {
  authorizationId: string;
  status: string;
  amount: number;
  currency: string;
  authorizedAt: string;
  expirationTime?: string;
  message?: string;
  alreadyAuthorized?: boolean;
}

function PayPalSuccessContent() {
  const searchParams = useSearchParams();

  const orderId = searchParams.get("token") || searchParams.get("orderId");
  const payerId = searchParams.get("PayerID") || searchParams.get("payerId");

  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<ApprovalDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);

  // Phase 9.2 Authorization State
  const [authorizing, setAuthorizing] = useState(false);
  const [authDetails, setAuthDetails] = useState<AuthDetails | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authRetryable, setAuthRetryable] = useState(false);

  const validateApproval = async () => {
    if (!orderId) {
      setError("Missing PayPal Order ID (token). Unable to validate approval.");
      setLoading(false);
      return;
    }

    setLoading(true);
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

      const res = await fetch("/api/paypal/orders/validate-approval", {
        method: "POST",
        headers,
        body: JSON.stringify({
          orderId,
          payerId: payerId || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to validate PayPal buyer approval.");
        setRetryable(Boolean(data.retryable || res.status >= 500));
        return;
      }

      setDetails(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Network error validating approval: ${msg}`);
      setRetryable(true);
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorize = async () => {
    if (!details?.paymentAttemptId) return;

    setAuthorizing(true);
    setAuthError(null);

    try {
      const supabase = createClient();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
      }

      const res = await fetch("/api/paypal/orders/authorize", {
        method: "POST",
        headers,
        body: JSON.stringify({
          paymentAttemptId: details.paymentAttemptId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setAuthError(data.error || "Payment authorization failed.");
        setAuthRetryable(Boolean(data.retryable || res.status >= 500));
        return;
      }

      setAuthDetails(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthError(`Network error during authorization: ${msg}`);
      setAuthRetryable(true);
    } finally {
      setAuthorizing(false);
    }
  };

  useEffect(() => {
    validateApproval();
  }, [orderId]);

  return (
    <div className="flex flex-col items-center justify-center py-space-xl px-space-md w-full max-w-2xl mx-auto">
      {/* 1. Loading State */}
      {loading && (
        <div className="bg-surface-container-lowest rounded-2xl p-space-xl border border-surface-container-low shadow-sm w-full flex flex-col items-center text-center gap-space-md">
          <div className="w-14 h-14 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
          <div className="flex flex-col gap-1">
            <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
              Verifying PayPal Buyer Approval...
            </h2>
            <p className="font-body-md text-body-md text-secondary">
              Contacting PayPal Sandbox server-side to validate order status, amount, and intent.
            </p>
          </div>
          <div className="bg-surface-container-low px-4 py-2 rounded-lg text-label-sm font-mono text-secondary">
            Order Token: {orderId || "Pending"}
          </div>
        </div>
      )}

      {/* 2. Error State */}
      {!loading && error && (
        <div className="bg-surface-container-lowest rounded-2xl p-space-xl border border-rose-200 shadow-sm w-full flex flex-col gap-space-md">
          <div className="flex items-start gap-space-md">
            <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[28px]">error</span>
            </div>
            <div className="flex flex-col">
              <span className="font-label-sm text-label-sm text-rose-700 uppercase font-semibold tracking-wider">
                Approval Verification Incomplete
              </span>
              <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold mt-0.5">
                Could Not Confirm Buyer Approval
              </h2>
              <p className="font-body-md text-body-md text-secondary mt-1">
                {error}
              </p>
            </div>
          </div>

          <div className="bg-surface-container-low p-space-md rounded-xl text-body-sm text-secondary flex flex-col gap-1">
            <span className="font-semibold text-on-surface">Guidance & Next Steps:</span>
            <ul className="list-disc list-inside space-y-1 text-label-md">
              <li>If you cancelled on PayPal, return to your project to review the milestone.</li>
              <li>If this was a network timeout, click &ldquo;Retry Verification&rdquo; below.</li>
              <li>No funds have been transferred or held.</li>
            </ul>
          </div>

          <div className="flex items-center justify-end gap-space-md pt-space-xs border-t border-surface-container-low">
            <Link
              href="/projects"
              className="px-4 py-2.5 rounded-lg border border-surface-container-high text-secondary hover:text-on-surface font-label-md text-label-md transition-colors"
            >
              Back to Projects
            </Link>
            {retryable && (
              <button
                type="button"
                onClick={validateApproval}
                className="px-4 py-2.5 rounded-lg bg-primary text-white hover:bg-primary/90 font-label-md text-label-md font-semibold transition-colors flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[18px]">refresh</span>
                <span>Retry Verification</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. Success State & Phase 9.2 Authorization Action */}
      {!loading && !error && details && (
        <div className="bg-surface-container-lowest rounded-2xl p-space-xl border border-surface-container-low/70 shadow-sm w-full flex flex-col gap-space-lg">
          {/* Header */}
          <div className="flex items-start gap-space-md">
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-xs ${
                authDetails
                  ? "bg-blue-50 text-primary"
                  : "bg-emerald-50 text-emerald-700"
              }`}
            >
              <span className="material-symbols-outlined text-[28px]">
                {authDetails ? "lock" : "check_circle"}
              </span>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span
                  className={`font-label-sm text-label-sm px-2.5 py-0.5 rounded-full font-semibold ${
                    authDetails
                      ? "text-primary bg-primary/10"
                      : "text-emerald-700 bg-emerald-50"
                  }`}
                >
                  {authDetails ? "Payment Authorization Active" : "Buyer Approval Confirmed"}
                </span>
                <span className="font-label-sm text-label-sm font-mono text-secondary">
                  Status: {authDetails ? authDetails.status : details.status}
                </span>
              </div>
              <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold mt-1">
                {authDetails
                  ? "Payment Authorized (Hold Active)"
                  : "PayPal Order Approved by Buyer"}
              </h2>
              <p className="font-body-md text-body-md text-secondary">
                {authDetails
                  ? "PayPal has authorized the payment hold. Funds have NOT been captured and will not be transferred until milestone completion is verified and approved."
                  : "Your payment approval was authenticated directly with PayPal Orders v2 and safely persisted."}
              </p>
            </div>
          </div>

          {/* Institutional Trust Notice: Explains Authorization != Capture */}
          <div
            className={`border rounded-xl p-space-md flex items-start gap-3 ${
              authDetails
                ? "bg-amber-50/80 border-amber-200/80 text-amber-900"
                : "bg-blue-50/80 border-blue-200/70 text-blue-900"
            }`}
          >
            <span className="material-symbols-outlined text-[22px] shrink-0 mt-0.5">
              {authDetails ? "shield" : "info"}
            </span>
            <div className="flex flex-col">
              <span className="font-label-md text-label-md font-semibold">
                {authDetails
                  ? "Authorization Hold Active — Payment Not Captured"
                  : "Funds Pre-Approved — Authorization Required"}
              </span>
              <p className="font-body-sm text-body-sm mt-0.5 opacity-90">
                {authDetails ? (
                  <>
                    An authorization hold for{" "}
                    <strong>${authDetails.amount.toFixed(2)} USD</strong> has been
                    placed on your PayPal payment method.{" "}
                    <span className="underline font-medium">
                      Funds are not captured or transferred
                    </span>{" "}
                    to the freelancer at this time. Capture occurs only after the
                    freelancer submits work and AI/client review confirms completion.
                  </>
                ) : (
                  <>
                    Your PayPal approval allows Milestone AI to place an authorization
                    hold for the agreed milestone amount. Click <strong>Authorize Payment Hold</strong> below
                    to complete the authorization.
                  </>
                )}
              </p>
            </div>
          </div>

          {/* Verification Audit Details Grid */}
          <div className="bg-surface-container-low rounded-xl p-space-md grid grid-cols-1 sm:grid-cols-2 gap-space-md">
            <div>
              <span className="font-label-sm text-label-sm text-secondary uppercase block">
                PayPal Order ID
              </span>
              <span className="font-body-md text-body-md font-mono text-on-surface font-medium select-all">
                {details.orderId}
              </span>
            </div>

            <div>
              <span className="font-label-sm text-label-sm text-secondary uppercase block">
                Payment Attempt ID
              </span>
              <span className="font-body-md text-body-md font-mono text-on-surface font-medium select-all">
                {details.paymentAttemptId}
              </span>
            </div>

            {authDetails && (
              <div>
                <span className="font-label-sm text-label-sm text-secondary uppercase block">
                  PayPal Authorization ID
                </span>
                <span className="font-body-md text-body-md font-mono text-on-surface font-medium select-all">
                  {authDetails.authorizationId}
                </span>
              </div>
            )}

            <div>
              <span className="font-label-sm text-label-sm text-secondary uppercase block">
                {authDetails ? "Authorized Hold Value" : "Approved Value"}
              </span>
              <span className="font-metric-display text-[20px] text-on-surface font-semibold tabular-nums">
                ${(authDetails ? authDetails.amount : details.amount)?.toFixed(2)}{" "}
                {details.currency || "USD"}
              </span>
            </div>

            <div>
              <span className="font-label-sm text-label-sm text-secondary uppercase block">
                Buyer Account
              </span>
              <span className="font-body-md text-body-md text-on-surface truncate block">
                {details.payerEmail || details.payerId || "Verified Sandbox Buyer"}
              </span>
            </div>

            {authDetails?.expirationTime && (
              <div>
                <span className="font-label-sm text-label-sm text-secondary uppercase block">
                  Authorization Validity
                </span>
                <span className="font-body-md text-body-md text-on-surface truncate block">
                  29 Days (Expires: {new Date(authDetails.expirationTime).toLocaleDateString()})
                </span>
              </div>
            )}
          </div>

          {/* Phase 9.2: Authorization Action Banner */}
          {!authDetails && (
            <div className="p-space-md bg-surface-container-low/70 border border-surface-container-high rounded-xl flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="font-title-sm text-title-sm font-semibold text-on-surface">
                  Step 2: Server-Side Payment Authorization
                </span>
                <p className="font-body-sm text-body-sm text-secondary">
                  Authorize the official PayPal Orders v2 payment hold. This securely places an authorization hold on the funds.
                </p>
              </div>

              {authError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-body-sm flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">
                    error
                  </span>
                  <div className="flex flex-col">
                    <span className="font-semibold">Authorization Unsuccessful:</span>
                    <span>{authError}</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <span className="font-label-sm text-label-sm text-secondary flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px] text-emerald-600">
                    verified_user
                  </span>
                  <span>Server-side OAuth2 & Idempotent</span>
                </span>

                <button
                  type="button"
                  onClick={handleAuthorize}
                  disabled={authorizing}
                  className="px-5 py-2.5 bg-primary hover:bg-primary/90 text-white font-semibold rounded-lg font-label-md text-label-md transition-all flex items-center gap-2 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {authorizing ? (
                    <>
                      <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      <span>Authorizing Payment Hold...</span>
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-[18px]">lock</span>
                      <span>
                        {authRetryable ? "Retry Payment Authorization" : "Authorize Payment Hold"}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-space-xs border-t border-surface-container-low">
            <span className="font-body-sm text-body-sm text-secondary">
              {authDetails
                ? "Phase 9.2: Server-Side Payment Authorization Complete"
                : "Phase 9.1: Buyer Approval Complete"}
            </span>

            <div className="flex items-center gap-space-sm">
              <Link
                href={details.projectId ? `/projects/${details.projectId}` : "/projects"}
                className="px-4 py-2.5 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-lg font-label-md text-label-md font-semibold transition-colors flex items-center gap-1.5 shadow-xs"
              >
                <span>View Milestone</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PayPalSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20 w-full">
          <div className="w-10 h-10 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
        </div>
      }
    >
      <PayPalSuccessContent />
    </Suspense>
  );
}
