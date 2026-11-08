"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { UserRole } from "@/lib/types";

export interface SupabaseUserProfile {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  avatarUrl?: string;
  paypalMerchantId?: string;
}

interface AuthContextType {
  user: SupabaseUserProfile | null;
  loading: boolean;
  isSupabaseConfigured: boolean;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  isSupabaseConfigured: false,
  signOut: async () => {},
  refreshUser: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SupabaseUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSupabaseConfigured, setIsSupabaseConfigured] = useState(false);

  const supabase = createClient();

  const fetchProfile = async (userId: string, email: string) => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

      if (data && !error) {
        setUser({
          id: data.id,
          email: data.email,
          fullName: data.full_name,
          role: data.role as UserRole,
          avatarUrl: data.avatar_url,
          paypalMerchantId: data.paypal_merchant_id,
        });
      } else {
        // Fallback profile if profile row is pending creation trigger
        setUser({
          id: userId,
          email,
          fullName: email.split("@")[0] || "User",
          role: "client",
        });
      }
    } catch (err) {
      console.error("Failed to load user profile:", err);
    }
  };

  const refreshUser = async () => {
    if (!supabase) {
      setIsSupabaseConfigured(false);
      setLoading(false);
      return;
    }

    setIsSupabaseConfigured(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        await fetchProfile(session.user.id, session.user.email || "");
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error("Auth session check error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();

    if (supabase) {
      const { data: authListener } = supabase.auth.onAuthStateChange(
        async (_event, session) => {
          if (session?.user) {
            await fetchProfile(session.user.id, session.user.email || "");
          } else {
            setUser(null);
          }
          setLoading(false);
        }
      );

      return () => {
        authListener.subscription.unsubscribe();
      };
    } else {
      setIsSupabaseConfigured(false);
      setLoading(false);
    }
  }, []);

  const signOut = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isSupabaseConfigured,
        signOut,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
