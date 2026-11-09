"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled client error caught by error boundary:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center mb-4 shadow-xs">
        <span className="material-symbols-outlined text-[28px]">warning</span>
      </div>
      <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold mb-2">
        Workspace View Temporarily Unavailable
      </h2>
      <p className="font-body-md text-secondary max-w-md mb-6">
        {error.message || "An unexpected error occurred while loading this workspace view."}
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={() => reset()}
          className="px-4 py-2 bg-primary text-white rounded-lg font-label-md font-semibold hover:bg-primary/90 transition-colors shadow-xs"
        >
          Try Again
        </button>
        <Link
          href="/dashboard"
          className="px-4 py-2 bg-surface-container-low text-on-surface hover:bg-surface-container rounded-lg font-label-md font-medium transition-colors border border-surface-container-high/60"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
