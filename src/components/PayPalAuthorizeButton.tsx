"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface PayPalAuthorizeButtonProps {
  milestoneId: string;
  projectId: string;
  amount: number;
  currency?: string;
  className?: string;
  label?: string;
  disabled?: boolean;
}

export function PayPalAuthorizeButton({
  milestoneId,
  projectId,
  amount,
  currency = "USD",
  className = "",
  label = "Authorize with PayPal",
  disabled = false,
}: PayPalAuthorizeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAuthorize = async () => {
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

      const res = await fetch("/api/paypal/orders", {
        method: "POST",
        headers,
        body: JSON.stringify({
          milestoneId,
          projectId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to initiate PayPal payment authorization.");
        return;
      }

      if (data.approvalUrl) {
        // Redirect browser to PayPal Sandbox approval URL
        window.location.href = data.approvalUrl;
      } else {
        setError("PayPal did not return a valid buyer approval URL.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Network error: ${msg}. Please verify connection and retry.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={handleAuthorize}
        disabled={loading || disabled}
        className={`px-4 py-2 bg-[#0070BA] hover:bg-[#003087] text-white font-semibold rounded-lg font-label-md text-label-md transition-colors flex items-center justify-center gap-2 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
        title={`Authorize $${amount.toFixed(2)} ${currency} with PayPal Sandbox`}
      >
        {loading ? (
          <>
            <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            <span>Connecting to PayPal...</span>
          </>
        ) : (
          <>
            <span className="font-bold tracking-tight">PayPal</span>
            <span className="text-white/80 font-normal">|</span>
            <span>{label}</span>
          </>
        )}
      </button>

      {error && (
        <div className="p-2 bg-rose-50 border border-rose-200 rounded text-rose-700 text-label-sm font-medium flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[16px]">error</span>
          <span className="flex-1">{error}</span>
        </div>
      )}
    </div>
  );
}
