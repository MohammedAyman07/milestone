import Link from "next/link";

export default function TrustSpotlightBanner() {
  return (
    <div className="bg-gradient-to-br from-blue-50 via-white to-blue-100/60 rounded-xl p-space-lg shadow-sm relative overflow-hidden flex flex-col justify-between min-h-[260px] group border border-blue-100/60">
      {/* Abstract Glow Behind Art */}
      <div className="absolute -right-12 -bottom-12 w-48 h-48 bg-primary/10 rounded-full blur-2xl pointer-events-none" />

      <div className="relative z-10 max-w-[65%]">
        <h3 className="font-headline-sm text-headline-sm text-on-surface tracking-tight leading-snug">
          AI Verification
          <br />
          You Can Trust
        </h3>
        <p className="font-body-sm text-body-sm text-secondary mt-2">
          Let our AI check deliverables against agreed requirements — with clear
          results.
        </p>
      </div>

      <div className="relative z-10 mt-space-lg">
        <Link
          href="/verification"
          className="inline-flex items-center gap-1.5 px-space-md py-2 bg-primary-container hover:bg-primary text-white font-label-md text-label-md rounded-lg shadow-sm hover:shadow-md transition-all"
        >
          <span>Learn More</span>
          <span className="material-symbols-outlined text-[16px]">
            arrow_forward
          </span>
        </Link>
      </div>

      {/* Decorative Illustration Floating Document & Shield */}
      <div className="absolute right-3 bottom-4 w-36 h-40 pointer-events-none select-none flex items-center justify-center">
        <div className="relative w-28 h-36 bg-white rounded-lg shadow-md p-2.5 flex flex-col gap-2 transform rotate-3 transition-transform group-hover:rotate-1 border border-surface-container-high/60">
          <div className="w-8 h-2 rounded bg-primary/20" />
          <div className="flex items-center gap-1.5">
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[10px]">
                check
              </span>
            </div>
            <div className="w-12 h-1.5 rounded bg-surface-container-high" />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[10px]">
                check
              </span>
            </div>
            <div className="w-14 h-1.5 rounded bg-surface-container-high" />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[10px]">
                check
              </span>
            </div>
            <div className="w-10 h-1.5 rounded bg-surface-container-high" />
          </div>

          {/* Overlaid Modern Blue Shield */}
          <div className="absolute -right-3 -bottom-2 w-12 h-14 bg-gradient-to-b from-primary to-primary-container rounded-md flex items-center justify-center text-white shadow-lg transform -rotate-6">
            <span className="material-symbols-outlined text-[26px]">
              verified
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
