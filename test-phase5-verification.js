const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Read environment variables directly from .env.local without hardcoding secrets
const envPath = path.resolve(__dirname, ".env.local");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  envContent.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  });
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BASE_URL = "http://localhost:3000";

if (!SERVICE_KEY) {
  console.error("CRITICAL: SUPABASE_SERVICE_ROLE_KEY is not defined in environment.");
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anonClient = createClient(SUPABASE_URL, ANON_KEY);

const results = {
  passed: [],
  failed: [],
  blocked: [],
};

function pass(name, details = "") {
  console.log(`[PASS] ${name}${details ? ` -> ${details}` : ""}`);
  results.passed.push({ name, details });
}

function fail(name, error) {
  console.error(`[FAIL] ${name} -> ${error}`);
  results.failed.push({ name, error });
}

async function runTests() {
  console.log("==================================================================");
  console.log("  MILESTONE AI — PHASE 5 PRODUCTION GEMINI VERIFICATION ENGINE TEST");
  console.log("==================================================================\n");

  let testClientUser = null;
  let testFreelancerUser = null;
  let testProjectId = null;
  let testMilestoneId = null;
  let testSubmissionId = null;
  let persistedReportId = null;

  // -------------------------------------------------------------------------
  // STEP 1: Set up real Project, Milestone, Criteria & Submission in Supabase
  // -------------------------------------------------------------------------
  try {
    console.log("--- Setting Up Real Supabase Test Fixtures ---");
    const clientEmail = `test.client.${Date.now()}@milestoneai.dev`;
    const freelancerEmail = `test.freelancer.${Date.now()}@milestoneai.dev`;

    const { data: uClient, error: cErr } = await adminClient.auth.admin.createUser({
      email: clientEmail,
      password: "TestPassword123!",
      email_confirm: true,
      user_metadata: { full_name: "Test Client", role: "client" },
    });
    if (cErr) throw new Error("Client user creation failed: " + cErr.message);
    testClientUser = uClient.user;

    const { data: uFree, error: fErr } = await adminClient.auth.admin.createUser({
      email: freelancerEmail,
      password: "TestPassword123!",
      email_confirm: true,
      user_metadata: { full_name: "Test Freelancer", role: "freelancer" },
    });
    if (fErr) throw new Error("Freelancer user creation failed: " + fErr.message);
    testFreelancerUser = uFree.user;

    // Create Project
    const { data: proj, error: pErr } = await adminClient
      .from("projects")
      .insert({
        title: "E-Commerce Gateway Real Verification Test",
        description: "Integration of PayPal payment provider with automated webhook handling.",
        budget: 2500.0,
        currency: "USD",
        client_id: testClientUser.id,
        freelancer_id: testFreelancerUser.id,
        status: "active",
        deadline: new Date(Date.now() + 864000000).toISOString(),
      })
      .select("id")
      .single();
    if (pErr) throw new Error("Project insert failed: " + pErr.message);
    testProjectId = proj.id;

    // Create Milestone
    const { data: mstone, error: mErr } = await adminClient
      .from("milestones")
      .insert({
        project_id: testProjectId,
        phase: 1,
        title: "PayPal Capture Webhook Integration",
        description: "Implement webhook receiver with signature validation.",
        amount: 800.0,
        currency: "USD",
        due_date: new Date(Date.now() + 86400000).toISOString(),
        status: "in_progress",
        payment_status: "unauthorized",
      })
      .select("id")
      .single();
    if (mErr) throw new Error("Milestone insert failed: " + mErr.message);
    testMilestoneId = mstone.id;

    // Create 3 Acceptance Criteria in Supabase (Source of Truth)
    const { error: acErr } = await adminClient.from("acceptance_criteria").insert([
      {
        milestone_id: testMilestoneId,
        criterion_code: "AC-101",
        label: "Public GitHub repository with commit history accessible via HTTP",
        description: "Repository must be reachable and contain commit logs.",
      },
      {
        milestone_id: testMilestoneId,
        criterion_code: "AC-102",
        label: "Live preview / staging endpoint accessible via HTTPS",
        description: "Staging deployment must return HTTP 200.",
      },
      {
        milestone_id: testMilestoneId,
        criterion_code: "AC-103",
        label: "Automated test coverage report with passing unit tests",
        description: "Automated test execution log must show all tests passed.",
      },
    ]);
    if (acErr) throw new Error("Criteria insert failed: " + acErr.message);

    // Create Freelancer Submission in Supabase
    const { data: sub, error: subErr } = await adminClient
      .from("submissions")
      .insert({
        milestone_id: testMilestoneId,
        project_id: testProjectId,
        submitter_id: testFreelancerUser.id,
        repo_url: "https://github.com/facebook/react",
        staging_url: "https://example.com",
        figma_url: "https://figma.com/file/sample-spec",
        notes: "Milestone complete. Test runner results and design token specs attached.",
        status: "submitted",
      })
      .select("id")
      .single();
    if (subErr) throw new Error("Submission insert failed: " + subErr.message);
    testSubmissionId = sub.id;

    // Create Submission Files in Supabase
    const { error: sfErr } = await adminClient.from("submission_files").insert([
      {
        submission_id: testSubmissionId,
        file_name: "unit-tests-output.json",
        file_size_bytes: 45000,
        mime_type: "application/json",
        storage_path: `${testProjectId}/unit-tests-output.json`,
        description: "Jest test results: 42 passed, 0 failed, 100% coverage",
      },
      {
        submission_id: testSubmissionId,
        file_name: "architecture-spec.pdf",
        file_size_bytes: 120000,
        mime_type: "application/pdf",
        storage_path: `${testProjectId}/architecture-spec.pdf`,
        description: "System data flow diagram",
      },
    ]);
    if (sfErr) throw new Error("Submission files insert failed: " + sfErr.message);

    pass("Supabase Database Fixtures Created", `Project: ${testProjectId}, Milestone: ${testMilestoneId}`);
  } catch (err) {
    fail("Supabase Fixtures Setup", err.message);
    return;
  }

  // -------------------------------------------------------------------------
  // TEST 1: Retrieve actual criteria from Supabase (Never trust browser criteria)
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 1: Criteria Source of Truth (Database vs Untrusted Browser) ---");
    // We send FAKE criteria in the browser payload, but provide the real milestoneId
    const res = await fetch(`${BASE_URL}/api/gemini/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: testProjectId,
        milestoneId: testMilestoneId,
        acceptanceCriteria: [
          { id: "FAKE-999", label: "Browser-supplied fake criterion should be ignored" },
        ],
        submissionId: testSubmissionId,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);

    const report = data.auditReport;
    if (report.criteriaSource !== "SUPABASE_DATABASE") {
      throw new Error(`Expected criteriaSource to be SUPABASE_DATABASE, got: ${report.criteriaSource}`);
    }

    const evaluatedIds = report.criteriaResults.map((c) => c.criterionId);
    if (!evaluatedIds.includes("AC-101") || evaluatedIds.includes("FAKE-999")) {
      throw new Error(`Browser spoofed criteria was used instead of Supabase! Evaluated: ${evaluatedIds.join(", ")}`);
    }

    pass("Requirement 1: Actual Criteria Retrieved from Supabase (Browser criteria discarded)", `Evaluated: ${evaluatedIds.join(", ")}`);
  } catch (err) {
    fail("Requirement 1: Supabase Criteria Enforcement", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 2: Genuine submitted evidence verification with live Gemini
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 2: Genuine Submitted Evidence Evaluation ---");
    const res = await fetch(`${BASE_URL}/api/gemini/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: testProjectId,
        milestoneId: testMilestoneId,
        submissionId: testSubmissionId,
        acceptanceCriteria: [
          { id: "AC-101", label: "Public GitHub repository with commit history accessible via HTTP" },
          { id: "AC-102", label: "Live preview / staging endpoint accessible via HTTPS" },
          { id: "AC-103", label: "Automated test coverage report with passing unit tests" },
        ],
        repoUrl: "https://github.com/facebook/react",
        stagingUrl: "https://example.com",
        notes: "All test cases passing, public GitHub repository and staging site accessible.",
        files: [
          {
            id: "f1",
            name: "test-run-summary.json",
            size: "35 KB",
            type: "application/json",
            description: "Test output log showing 48 passed tests with 0 failures.",
          },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);

    const report = data.auditReport;
    persistedReportId = data.dbReportId || report.id;

    // Check outputs
    if (!["VERIFIED", "FAILED", "NEEDS_EVIDENCE"].includes(report.overallStatus)) {
      throw new Error(`Invalid overall status: ${report.overallStatus}`);
    }

    for (const c of report.criteriaResults) {
      if (!["PASS", "FAIL", "INCONCLUSIVE"].includes(c.result)) {
        throw new Error(`Criterion ${c.criterionId} returned invalid result: ${c.result}`);
      }
      if (typeof c.confidenceScore !== "number" || c.confidenceScore < 0 || c.confidenceScore > 100) {
        throw new Error(`Criterion ${c.criterionId} has invalid confidenceScore: ${c.confidenceScore}`);
      }
      if (!c.explanation || c.explanation.trim() === "") {
        throw new Error(`Criterion ${c.criterionId} lacks an explanation`);
      }
    }

    pass(
      "Requirement 3, 4, 5, 6: Independent Criteria Evaluation & Standardized 3-Level Outcomes",
      `Status: ${report.overallStatus}, Model: ${report.modelUsed}, Criteria Evaluated: ${report.criteriaResults.length}`
    );
  } catch (err) {
    fail("Requirement 3-6: Live Gemini Verification", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 3: Deterministic Overrides for Inaccessible / Missing Evidence
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 3: Missing & Inaccessible Evidence (Unreachable Endpoints) ---");
    // Point to non-existent GitHub repository and invalid staging
    const res = await fetch(`${BASE_URL}/api/gemini/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: testProjectId,
        milestoneId: testMilestoneId,
        acceptanceCriteria: [
          { id: "AC-101", label: "Public GitHub repository with commit history accessible via HTTP" },
          { id: "AC-102", label: "Live preview / staging endpoint accessible via HTTPS" },
        ],
        repoUrl: "https://github.com/milestone-ai-nonexistent-org/fake-repo-xyz-404",
        stagingUrl: "https://this-is-a-completely-fake-unreachable-domain-999.xyz",
        notes: "Submitting without real deployment.",
        files: [],
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error);

    const report = data.auditReport;
    // Check deterministic audit
    if (report.deterministicAudit.githubReachable) {
      throw new Error("Fake GitHub URL was incorrectly marked as reachable!");
    }
    if (report.deterministicAudit.stagingReachable) {
      throw new Error("Fake staging URL was incorrectly marked as reachable!");
    }

    // Inaccessible endpoints MUST result in INCONCLUSIVE or FAIL, never PASS
    for (const c of report.criteriaResults) {
      if (c.result === "PASS") {
        throw new Error(`Criterion ${c.criterionId} returned PASS despite probe failure!`);
      }
    }

    if (report.overallStatus === "VERIFIED") {
      throw new Error("Report overallStatus was VERIFIED despite all evidence being unreachable!");
    }

    pass(
      "Requirement 8, 9: Deterministic Probe Enforcement & Inaccessible Evidence Handled",
      `Overall status correctly aggregated as: ${report.overallStatus}`
    );
  } catch (err) {
    fail("Requirement 8, 9: Inaccessible Evidence Handling", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 4: Disallowed File Formats (.exe, .bat, etc.) Deterministic Rejection
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 4: Disallowed Executable Evidence Rejection ---");
    const res = await fetch(`${BASE_URL}/api/gemini/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: testProjectId,
        milestoneId: testMilestoneId,
        acceptanceCriteria: [
          { id: "AC-101", label: "Valid deliverables format" },
        ],
        repoUrl: "https://github.com/facebook/react",
        stagingUrl: "https://example.com",
        notes: "Evidence attached.",
        files: [
          { id: "bad1", name: "malicious_runner.exe", size: "2.1 MB", type: "application/x-msdownload" },
        ],
      }),
    });

    if (res.status === 422) {
      pass("Requirement 8: Disallowed file extension rejected with HTTP 422 Unprocessable Entity");
    } else {
      throw new Error(`Expected HTTP 422, got ${res.status}`);
    }
  } catch (err) {
    fail("Requirement 8: File Extension Security Validation", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 5: Financial State Protection (AI Never Approves Payments)
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 5: Financial State Protection (Payment Unchanged) ---");
    const { data: milestoneAfter } = await adminClient
      .from("milestones")
      .select("payment_status, status")
      .eq("id", testMilestoneId)
      .single();

    if (milestoneAfter.payment_status !== "unauthorized") {
      throw new Error(`Milestone payment_status was changed to: ${milestoneAfter.payment_status}!`);
    }

    const { data: payments } = await adminClient
      .from("payments")
      .select("id")
      .eq("milestone_id", testMilestoneId);

    if (payments && payments.length > 0) {
      throw new Error("AI engine created unauthorized payment rows!");
    }

    pass("Requirement 10: Financial State Untouched (Payment status remains 'unauthorized', 0 payments created)");
  } catch (err) {
    fail("Requirement 10: Financial Protection Check", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 6: Report Immutability Guard (Trigger Protection Against Modification)
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 6: Report Immutability Verification (Database Trigger) ---");
    // Find the saved report in Supabase
    const { data: rep, error: rErr } = await adminClient
      .from("verification_reports")
      .select("id, overall_status, overall_score")
      .eq("milestone_id", testMilestoneId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (rErr || !rep) {
      throw new Error("No report row found in Supabase verification_reports: " + (rErr?.message || "empty"));
    }

    // Try to illicitly alter the AI findings (e.g. changing FAILED/NEEDS_EVIDENCE to VERIFIED)
    const { error: tamperError } = await adminClient
      .from("verification_reports")
      .update({ overall_status: "VERIFIED", overall_score: 100 })
      .eq("id", rep.id);

    if (tamperError && tamperError.message.includes("immutable")) {
      pass("Requirement 12: AI Verification Findings Immutability Guard Active", tamperError.message);
    } else if (tamperError) {
      pass("Requirement 12: Modification Blocked by DB", tamperError.message);
    } else {
      throw new Error("AI Verification Report was mutated! Immutability trigger did not trigger.");
    }
  } catch (err) {
    fail("Requirement 12: Immutability Protection", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 7: Persisted Individual Criterion Results & Audit Logs
  // -------------------------------------------------------------------------
  try {
    console.log("\n--- Test 7: Persistence Verification in Supabase Tables ---");
    const { data: critResults, error: crErr } = await adminClient
      .from("verification_criteria_results")
      .select("criterion_id, criterion_text, result, confidence_score")
      .limit(5);

    if (crErr || !critResults || critResults.length === 0) {
      throw new Error("No criterion results found in verification_criteria_results: " + (crErr?.message || "empty"));
    }

    const { data: auditEvents, error: aErr } = await adminClient
      .from("audit_logs")
      .select("action, entity_type, project_id, created_at")
      .eq("action", "AI_VERIFICATION_COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1);

    if (aErr || !auditEvents || auditEvents.length === 0) {
      throw new Error("No audit log found for AI_VERIFICATION_COMPLETED: " + (aErr?.message || "empty"));
    }

    pass(
      "Requirement 11: Reports, Criteria Results & Audit Logs Persisted in Supabase",
      `Saved ${critResults.length} criteria results, Audit Event recorded: ${auditEvents[0].action}`
    );
  } catch (err) {
    fail("Requirement 11: Database Persistence Verification", err.message);
  }

  // -------------------------------------------------------------------------
  // Cleanup Test Data
  // -------------------------------------------------------------------------
  try {
    if (testProjectId) {
      await adminClient.from("projects").delete().eq("id", testProjectId);
    }
    if (testClientUser) {
      await adminClient.auth.admin.deleteUser(testClientUser.id);
    }
    if (testFreelancerUser) {
      await adminClient.auth.admin.deleteUser(testFreelancerUser.id);
    }
    console.log("\n✓ Test fixtures safely cleaned up.");
  } catch (cleanupErr) {
    console.warn("Cleanup warning:", cleanupErr.message);
  }

  // -------------------------------------------------------------------------
  // FINAL SUMMARY
  // -------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`TEST RESULTS SUMMARY:`);
  console.log(`  PASSED: ${results.passed.length}`);
  console.log(`  FAILED: ${results.failed.length}`);
  console.log(`  BLOCKED: ${results.blocked.length}`);
  console.log("==================================================================");

  if (results.failed.length > 0) {
    process.exit(1);
  }
}

runTests();
