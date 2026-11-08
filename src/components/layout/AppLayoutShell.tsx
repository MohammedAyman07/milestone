"use client";

import { useState } from "react";
import Sidebar from "./Sidebar";
import Header from "./Header";
import { ProjectProvider } from "@/context/ProjectContext";
import { AuthProvider } from "@/context/AuthContext";

export default function AppLayoutShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <AuthProvider>
      <ProjectProvider>
        <div className="min-h-screen bg-background text-on-surface">
          <Sidebar
            mobileOpen={mobileMenuOpen}
            onClose={() => setMobileMenuOpen(false)}
          />
          <div className="pl-0 lg:pl-72 flex flex-col min-h-screen">
            <Header onOpenMobileMenu={() => setMobileMenuOpen(true)} />
            <main className="w-full pt-16 px-space-md sm:px-space-lg pb-space-xl bg-background min-h-[calc(100vh-4rem)] flex-1">
              {children}
            </main>
          </div>
        </div>
      </ProjectProvider>
    </AuthProvider>
  );
}
