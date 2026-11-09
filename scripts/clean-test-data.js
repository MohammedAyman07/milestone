// scripts/clean-test-data.js
const { createClient } = require("@supabase/supabase-js");

const REAL_CLIENT_EMAIL = "asatipl123@gmail.com";
const REAL_CLIENT_ID = "52d9c0b8-8180-49e5-b905-0a1e861e70f4";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("=== SUPABASE DATABASE & STORAGE CLEANUP ===");
  console.log(`Preserving real user: ${REAL_CLIENT_EMAIL} (${REAL_CLIENT_ID})`);

  // 1. Storage cleanup in milestone-evidence
  console.log("\n--- Cleaning Storage (milestone-evidence) ---");
  const { data: rootItems, error: listErr } = await supabase.storage.from("milestone-evidence").list();
  if (!listErr && rootItems && rootItems.length > 0) {
    for (const item of rootItems) {
      console.log(`Inspecting folder/item: ${item.name}`);
      const { data: files } = await supabase.storage.from("milestone-evidence").list(item.name);
      if (files && files.length > 0) {
        const filePaths = files.map((f) => `${item.name}/${f.name}`);
        console.log(`Deleting ${filePaths.length} files in ${item.name}:`, filePaths);
        await supabase.storage.from("milestone-evidence").remove(filePaths);
      }
      // Also attempt removing folder placeholder
      await supabase.storage.from("milestone-evidence").remove([item.name]);
    }
    console.log("[DONE] Storage files cleaned.");
  } else {
    console.log("No storage files found to clean.");
  }

  // 2. Delete verification_criteria_results
  console.log("\n--- Cleaning Tables ---");
  const { error: vcrErr } = await supabase.from("verification_criteria_results").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned verification_criteria_results:", vcrErr ? vcrErr.message : "OK");

  // 3. Delete verification_reports
  const { error: vrErr } = await supabase.from("verification_reports").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned verification_reports:", vrErr ? vrErr.message : "OK");

  // 4. Delete submission_files
  const { error: sfErr } = await supabase.from("submission_files").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned submission_files:", sfErr ? sfErr.message : "OK");

  // 5. Delete submissions
  const { error: subErr } = await supabase.from("submissions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned submissions:", subErr ? subErr.message : "OK");

  // 6. Delete payments
  const { error: payErr } = await supabase.from("payments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned payments:", payErr ? payErr.message : "OK");

  // 7. Delete acceptance_criteria
  const { error: acErr } = await supabase.from("acceptance_criteria").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned acceptance_criteria:", acErr ? acErr.message : "OK");

  // 8. Delete milestones
  const { error: msErr } = await supabase.from("milestones").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned milestones:", msErr ? msErr.message : "OK");

  // 9. Delete test projects
  const { error: prjErr } = await supabase.from("projects").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  console.log("Cleaned projects:", prjErr ? prjErr.message : "OK");

  // 10. Clean test profiles (keep real client)
  const { data: testProfiles, error: profListErr } = await supabase
    .from("profiles")
    .select("id, email")
    .neq("id", REAL_CLIENT_ID);

  if (!profListErr && testProfiles) {
    console.log(`Found ${testProfiles.length} test profiles to delete.`);
    for (const p of testProfiles) {
      console.log(`Deleting test profile: ${p.email} (${p.id})`);
      await supabase.from("profiles").delete().eq("id", p.id);
      try {
        await supabase.auth.admin.deleteUser(p.id);
      } catch (authErr) {
        console.warn(`Could not delete Auth user ${p.id}:`, authErr.message);
      }
    }
  }

  // 11. Verify preserved real account
  console.log("\n--- Verification of Preserved Real Account ---");
  const { data: realProfile } = await supabase
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", REAL_CLIENT_ID)
    .single();

  console.log("Preserved Client Account:", realProfile);

  const { data: remainingProjects } = await supabase.from("projects").select("id, title");
  console.log("Remaining Projects (should be 0):", remainingProjects?.length || 0);

  console.log("\n[SUCCESS] Cleanup complete! The platform is now in real production-ready state.");
}

main().catch((err) => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
