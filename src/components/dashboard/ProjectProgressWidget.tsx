export default function ProjectProgressWidget() {
  const steps = [
    { title: "Contract Setup", status: "completed" },
    { title: "Milestone Scoping", status: "completed" },
    { title: "Payment Pre-Authorized", status: "completed" },
    { title: "Deliverable Submitted", status: "current" },
    { title: "Verification & Sign-Off", status: "upcoming" },
  ];

  return (
    <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm border border-surface-container-low/50">
      <div className="flex items-center justify-between mb-space-md">
        <h2 className="font-headline-sm text-headline-sm text-on-surface">
          Active Milestone Lifecycle
        </h2>
        <span className="font-label-sm text-label-sm text-secondary font-mono">
          Phase 2 of 3
        </span>
      </div>

      <div className="flex flex-col sm:flex-row items-center sm:items-start gap-space-lg">
        {/* Circular Donut Chart */}
        <div className="relative w-36 h-36 shrink-0 flex items-center justify-center">
          <svg
            className="w-full h-full -rotate-90 transform"
            viewBox="0 0 120 120"
          >
            {/* Background ring */}
            <circle
              className="text-surface-container"
              cx="60"
              cy="60"
              fill="none"
              r="50"
              stroke="currentColor"
              strokeWidth="12"
            />
            {/* Progress ring (67% of 314 is ~210 dasharray, dashoffset 103) */}
            <circle
              className="text-primary-container"
              cx="60"
              cy="60"
              fill="none"
              r="50"
              stroke="currentColor"
              strokeDasharray="314"
              strokeDashoffset="103"
              strokeLinecap="round"
              strokeWidth="12"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-metric-display text-metric-display text-on-surface font-bold leading-none">
              67%
            </span>
            <span className="font-label-sm text-label-sm text-secondary mt-0.5">
              Overall
            </span>
          </div>
        </div>

        {/* Step Progress Checklist */}
        <div className="flex flex-col gap-space-sm w-full">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-center gap-space-sm">
              {step.status === "completed" && (
                <div className="w-5 h-5 rounded-full bg-primary-container text-on-primary flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-[14px]">
                    check
                  </span>
                </div>
              )}
              {step.status === "current" && (
                <div className="w-5 h-5 rounded-full bg-primary-container flex items-center justify-center shrink-0">
                  <div className="w-2 h-2 rounded-full bg-white" />
                </div>
              )}
              {step.status === "upcoming" && (
                <div className="w-5 h-5 rounded-full bg-surface-container flex items-center justify-center shrink-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-outline-variant" />
                </div>
              )}

              <span
                className={`font-body-sm text-body-sm ${
                  step.status === "completed"
                    ? "text-on-surface font-medium"
                    : step.status === "current"
                    ? "text-primary font-semibold"
                    : "text-secondary"
                }`}
              >
                {step.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
