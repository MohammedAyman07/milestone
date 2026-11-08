"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"client" | "freelancer">("client");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);

    if (!supabase) {
      setErrorMsg(
        "Supabase is not configured. Please supply NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
      );
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            role,
          },
        },
      });

      if (error) {
        setErrorMsg(error.message);
      } else if (data.user) {
        // Also insert into profiles table
        const { error: profileError } = await supabase.from("profiles").upsert({
          id: data.user.id,
          email,
          full_name: fullName,
          role,
        });

        if (profileError) {
          console.warn("Profile creation warning:", profileError.message);
        }

        setSuccessMsg(
          "Account created successfully! Check your email for a confirmation link or proceed to sign in."
        );
        setTimeout(() => router.push("/login"), 2000);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to sign up");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md bg-surface-container-lowest rounded-2xl p-space-xl shadow-lg border border-surface-container-high/60 flex flex-col gap-space-lg">
        <div className="flex flex-col items-center text-center gap-1">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-white mb-2 shadow-sm">
            <span className="material-symbols-outlined text-[28px]">person_add</span>
          </div>
          <h1 className="font-headline-md text-headline-md text-on-surface font-semibold tracking-tight">
            Create an Account
          </h1>
          <p className="font-body-md text-body-md text-secondary">
            Join MILESTONE AI with Supabase Auth
          </p>
        </div>

        {errorMsg && (
          <div className="p-space-md rounded-xl bg-error/10 border border-error/20 text-error font-body-sm text-body-sm flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">error</span>
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="p-space-md rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 font-body-sm text-body-sm flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0 text-emerald-600">check_circle</span>
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSignup} className="flex flex-col gap-space-md">
          <div>
            <label className="block font-label-md text-label-md text-on-surface mb-1 font-medium">
              Full Legal Name
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Sarah Chen"
              className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md border border-surface-container-high/60 focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none"
            />
          </div>

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
            <label className="block font-label-md text-label-md text-on-surface mb-1 font-medium">
              Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              className="w-full p-3 bg-surface-container-low rounded-lg text-on-surface font-body-md text-body-md border border-surface-container-high/60 focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="block font-label-md text-label-md text-on-surface mb-1 font-medium">
              Account Role
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRole("client")}
                className={`p-3 rounded-lg border text-left flex flex-col gap-0.5 transition-all ${
                  role === "client"
                    ? "bg-primary/5 border-primary text-primary font-semibold"
                    : "bg-surface-container-low border-surface-container-high text-secondary hover:text-on-surface"
                }`}
              >
                <span className="font-label-md text-label-md">Client</span>
                <span className="text-[11px] font-normal opacity-80">Authorizes projects &amp; releases</span>
              </button>
              <button
                type="button"
                onClick={() => setRole("freelancer")}
                className={`p-3 rounded-lg border text-left flex flex-col gap-0.5 transition-all ${
                  role === "freelancer"
                    ? "bg-primary/5 border-primary text-primary font-semibold"
                    : "bg-surface-container-low border-surface-container-high text-secondary hover:text-on-surface"
                }`}
              >
                <span className="font-label-md text-label-md">Freelancer</span>
                <span className="text-[11px] font-normal opacity-80">Submits milestones &amp; evidence</span>
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-primary text-white font-title-md text-title-md font-semibold rounded-lg hover:bg-primary/90 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-50 mt-1"
          >
            {loading ? (
              <span>Registering...</span>
            ) : (
              <>
                <span className="material-symbols-outlined text-[20px]">how_to_reg</span>
                <span>Register with Supabase</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-space-sm border-t border-surface-container-low text-center">
          <span className="font-body-sm text-body-sm text-secondary">
            Already have an account?{" "}
          </span>
          <Link href="/login" className="font-label-md text-label-md text-primary font-semibold hover:underline">
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
