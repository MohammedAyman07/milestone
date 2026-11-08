"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);

    if (!supabase) {
      setErrorMsg(
        "Supabase is not configured. Please supply NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
      );
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setErrorMsg(error.message);
      } else if (data.session) {
        router.push("/dashboard");
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to sign in");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md bg-surface-container-lowest rounded-2xl p-space-xl shadow-lg border border-surface-container-high/60 flex flex-col gap-space-lg">
        <div className="flex flex-col items-center text-center gap-1">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-white mb-2 shadow-sm">
            <span className="material-symbols-outlined text-[28px]">payments</span>
          </div>
          <h1 className="font-headline-md text-headline-md text-on-surface font-semibold tracking-tight">
            Sign In to MILESTONE AI
          </h1>
          <p className="font-body-md text-body-md text-secondary">
            Institutional Milestone Management &amp; AI Verification
          </p>
        </div>

        {errorMsg && (
          <div className="p-space-md rounded-xl bg-error/10 border border-error/20 text-error font-body-sm text-body-sm flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">error</span>
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="flex flex-col gap-space-md">
          <div>
            <label className="block font-label-md text-label-md text-on-surface mb-1 font-medium">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="sarah.chen@designstudio.io"
              className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md border border-surface-container-high/60 focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block font-label-md text-label-md text-on-surface font-medium">
                Password
              </label>
              <Link href="#" className="font-label-sm text-label-sm text-primary hover:underline">
                Forgot password?
              </Link>
            </div>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md border border-surface-container-high/60 focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-primary text-white font-title-md text-title-md font-semibold rounded-lg hover:bg-primary/90 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? (
              <span>Authenticating...</span>
            ) : (
              <>
                <span className="material-symbols-outlined text-[20px]">login</span>
                <span>Sign In with Supabase</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-space-sm border-t border-surface-container-low text-center">
          <span className="font-body-sm text-body-sm text-secondary">
            Don&apos;t have an account?{" "}
          </span>
          <Link href="/signup" className="font-label-md text-label-md text-primary font-semibold hover:underline">
            Create an Account
          </Link>
        </div>

        <div className="p-3 bg-surface-container-low rounded-lg text-[12px] text-secondary flex items-start gap-2">
          <span className="material-symbols-outlined text-[16px] text-primary mt-0.5 shrink-0">shield</span>
          <span>
            Identity is secured via Supabase Auth with Row Level Security. Service credentials are never exposed to browser clients.
          </span>
        </div>
      </div>
    </div>
  );
}
