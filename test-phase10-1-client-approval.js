const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ENV_PATH = path.join(__dirname, '.env.local');
const originalEnvContent = fs.readFileSync(ENV_PATH, 'utf8');

// Parse baseline env
let url = '', servKey = '', anonKey = '', geminiKey = '', geminiModel = 'gemini-2.5-flash';
let savedClientId = '', savedClientSecret = '';
originalEnvContent.split('\n').forEach(line => {
  const t = line.trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) servKey = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_ANON_KEY=')) anonKey = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('GEMINI_API_KEY=')) geminiKey = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('GEMINI_MODEL=')) geminiModel = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('PAYPAL_CLIENT_ID=')) savedClientId = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('PAYPAL_CLIENT_SECRET=')) savedClientSecret = t.split('=')[1].replace(/"/g, '').trim();
});

const adminClient = createClient(url, servKey);
const anonClient = createClient(url, anonKey);
const DECISION_URL = 'http://localhost:3000/api/milestones/decision';

const testResults = {
  passed: [],
  failed: []
};

function recordPass(testName, details = '') {
  console.log(`✓ [PASS] ${testName}${details ? ` -> ${details}` : ''}`);
  testResults.passed.push({ testName, details });
}

function recordFail(testName, error) {
  console.error(`✗ [FAIL] ${testName} -> ${error}`);
  testResults.failed.push({ testName, error });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 10.1: Client Milestone Approval Workflow Test Suite");
  console.log("=============================================================================\n");

  let clientUserA = null; // Client / Project Owner
  let clientTokenA = null;
  let freelancerUser = null; // Freelancer / Payee
  let freelancerToken = null;
  let clientUserB = null; // Attacker / Non-owner Client
  let clientTokenB = null;
  let testProject = null;
  let createdThirdUser = false;

  const createdMilestones = [];
  const createdSubmissions = [];
  const createdReports = [];

  try {
    // 1. Setup Test Users
    const { data: usersData } = await adminClient.auth.admin.listUsers();
    clientUserA = usersData.users[0];
    freelancerUser = usersData.users[1];

    if (usersData.users.length > 2) {
      clientUserB = usersData.users[2];
    } else {
      const email3 = `unrelated.${Date.now()}@test.milestoneai.dev`;
      const { data: u3Data, error: u3Err } = await adminClient.auth.admin.createUser({
        email: email3,
        password: 'TestPassword123!@#',
        email_confirm: true,
        user_metadata: { role: 'client', full_name: 'Unrelated User' }
      });
      if (u3Err) throw u3Err;
      clientUserB = u3Data.user;
      createdThirdUser = true;
    }

    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];

    // Configure testProject ownership: Client A is client, Freelancer is freelancer, Client B is unrelated
    await adminClient.from('projects').update({
      client_id: clientUserA.id,
      freelancer_id: freelancerUser.id,
      budget: 100000.00
    }).eq('id', testProject.id);

    // Sign in Client A
    const authA = await anonClient.auth.signInWithPassword({
      email: clientUserA.email,
      password: 'TestPassword123!@#'
    });
    clientTokenA = authA.data.session.access_token;

    // Sign in Freelancer
    const authFree = await anonClient.auth.signInWithPassword({
      email: freelancerUser.email,
      password: 'TestPassword123!@#'
    });
    freelancerToken = authFree.data.session.access_token;

    // Sign in Client B (other user)
    const authB = await anonClient.auth.signInWithPassword({
      email: clientUserB.email,
      password: 'TestPassword123!@#'
    });
    clientTokenB = authB.data.session.access_token;

    console.log(`✓ Client A (Owner): ${clientUserA.email} (${clientUserA.id})`);
    console.log(`✓ Freelancer (Payee): ${freelancerUser.email} (${freelancerUser.id})`);
    console.log(`✓ Client B (Non-Owner): ${clientUserB.email} (${clientUserB.id})`);
    console.log(`✓ Test Project: ${testProject.id}\n`);

    // Helper: Create test milestone with payment authorization hold
    async function createMilestone(phase, title, amount = 75.00) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 10.1 Deliverable Review Scope',
        amount,
        currency: 'USD',
        status: 'submitted',
        payment_status: 'authorized',
        due_date: new Date(Date.now() + 7 * 86400000).toISOString()
      }]).select().single();
      if (error) throw error;
      createdMilestones.push(m.id);
      return m;
    }

    // Helper: Create submission
    async function createSubmission(milestoneId, notes = 'Completed deliverables') {
      const { data: sub, error } = await adminClient.from('submissions').insert([{
        milestone_id: milestoneId,
        project_id: testProject.id,
        submitter_id: freelancerUser.id,
        repo_url: 'https://github.com/agency/test-repo/commit/123456',
        staging_url: 'https://staging.test-app.com',
        notes,
        status: 'submitted'
      }]).select().single();
      if (error) throw error;
      createdSubmissions.push(sub.id);
      return sub;
    }

    // Helper: Create verification report with criteria results
    async function createVerificationReport(submissionId, milestoneId, criteriaResults = [], overallStatus = 'VERIFIED') {
      const { data: report, error } = await adminClient.from('verification_reports').insert([{
        submission_id: submissionId,
        project_id: testProject.id,
        milestone_id: milestoneId,
        model_used: 'gemini-2.5-flash',
        overall_status: overallStatus,
        overall_score: overallStatus === 'VERIFIED' ? 100 : 50,
        overall_evidence_quality: 'HIGH',
        confidence_explanation: 'Multi-modal analysis passed.',
        executive_summary: 'All criteria evaluated.',
        unverified_claims: [],
        deterministic_audit: { filesValid: true, githubReachable: true, stagingReachable: true },
        advisory_notice: 'AI Verification is advisory.',
        client_decision: 'pending'
      }]).select().single();
      if (error) throw error;
      createdReports.push(report.id);

      if (criteriaResults.length > 0) {
        const rows = criteriaResults.map((c, i) => ({
          report_id: report.id,
          criterion_id: c.id || `c${i + 1}`,
          criterion_text: c.text || `Acceptance criterion ${i + 1}`,
          result: c.result || 'PASS',
          explanation: c.explanation || 'Criterion satisfied.',
          evidence_references: ['github.com/test'],
          confidence_score: 95,
          evidence_quality: 'HIGH',
          recommended_action: 'Ready for approval.'
        }));
        await adminClient.from('verification_criteria_results').insert(rows);
      }

      return report;
    }

    // =========================================================================
    // 1. Valid Client Approval
    // =========================================================================
    console.log("--- 1. Testing Valid Client Approval ---");
    const m1 = await createMilestone(101, "Milestone 10.1 - Clean Approval");
    const sub1 = await createSubmission(m1.id);
    await createVerificationReport(sub1.id, m1.id, [
      { id: "c1", text: "Unit tests passing", result: "PASS" },
      { id: "c2", text: "Tailwind responsive container deployed", result: "PASS" }
    ], 'VERIFIED');

    const res1 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m1.id,
        submissionId: sub1.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body1 = await res1.json();
    if (res1.status === 200 && body1.success && body1.milestone.status === 'approved') {
      recordPass("TEST 1A: Valid client approval returned HTTP 200 with approved status", `status: ${body1.milestone.status}`);
    } else {
      recordFail("TEST 1A: Valid client approval", `HTTP ${res1.status}: ${JSON.stringify(body1)}`);
    }

    // Payment safety check: approval must NOT capture funds
    const { data: m1Db } = await adminClient.from('milestones').select('*').eq('id', m1.id).single();
    if (m1Db.status === 'approved' && m1Db.payment_status === 'authorized') {
      recordPass("TEST 1B: Payment safety verified: payment_status remains 'authorized' (NEVER captured or settled)", `payment_status: ${m1Db.payment_status}`);
    } else {
      recordFail("TEST 1B: Payment safety verification", `Invalid payment_status: ${m1Db.payment_status}`);
    }

    // Audit event check
    const { data: logs1 } = await adminClient.from('audit_logs').select('*')
      .eq('milestone_id', m1.id)
      .eq('action', 'MILESTONE_APPROVED');

    if (logs1 && logs1.length > 0) {
      recordPass("TEST 1C: Audit event MILESTONE_APPROVED successfully logged in database");
    } else {
      recordFail("TEST 1C: Audit event verification", "MILESTONE_APPROVED not found in audit_logs");
    }

    // =========================================================================
    // 2. Unauthorized Client Approval
    // =========================================================================
    console.log("\n--- 2. Testing Unauthorized Client Approval ---");
    const m2 = await createMilestone(102, "Milestone 10.1 - Attacker Check");
    const sub2 = await createSubmission(m2.id);
    await createVerificationReport(sub2.id, m2.id, [{ id: "c1", result: "PASS" }], 'VERIFIED');

    const res2 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenB}` // Unrelated client
      },
      body: JSON.stringify({
        milestoneId: m2.id,
        submissionId: sub2.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body2 = await res2.json();
    if (res2.status === 403) {
      recordPass("TEST 2: Non-owner client rejected with HTTP 403 Forbidden", body2.error);
    } else {
      recordFail("TEST 2: Non-owner client check", `Expected 403, got ${res2.status}: ${JSON.stringify(body2)}`);
    }

    // =========================================================================
    // 3. Freelancer Attempting Approval
    // =========================================================================
    console.log("\n--- 3. Testing Freelancer Attempting Approval ---");
    const res3 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${freelancerToken}` // Freelancer
      },
      body: JSON.stringify({
        milestoneId: m2.id,
        submissionId: sub2.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body3 = await res3.json();
    if (res3.status === 403) {
      recordPass("TEST 3: Freelancer account rejected with HTTP 403 Forbidden", body3.error);
    } else {
      recordFail("TEST 3: Freelancer approval check", `Expected 403, got ${res3.status}: ${JSON.stringify(body3)}`);
    }

    // =========================================================================
    // 4. Missing Verification Report
    // =========================================================================
    console.log("\n--- 4. Testing Missing Verification Report ---");
    const m4 = await createMilestone(104, "Milestone 10.1 - No Report");
    const sub4 = await createSubmission(m4.id); // No verification report created!

    const res4 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m4.id,
        submissionId: sub4.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body4 = await res4.json();
    if (res4.status === 400 && body4.error.includes("Verification Required")) {
      recordPass("TEST 4: Missing verification report rejected with HTTP 400", body4.error);
    } else {
      recordFail("TEST 4: Missing verification report", `Expected 400, got ${res4.status}: ${JSON.stringify(body4)}`);
    }

    // =========================================================================
    // 5. FAIL or INCONCLUSIVE Criterion
    // =========================================================================
    console.log("\n--- 5. Testing FAIL or INCONCLUSIVE Criterion ---");
    const m5A = await createMilestone(105, "Milestone 10.1 - Fail Criterion");
    const sub5A = await createSubmission(m5A.id);
    await createVerificationReport(sub5A.id, m5A.id, [
      { id: "c1", text: "Unit tests", result: "PASS" },
      { id: "c2", text: "Lighthouse 95+", result: "FAIL", explanation: "Lighthouse returned 72/100" }
    ], 'FAILED');

    const res5A = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m5A.id,
        submissionId: sub5A.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body5A = await res5A.json();
    if (res5A.status === 400 && (body5A.error.includes("Verification Policy Violation") || body5A.error.includes("Acceptance Criteria Unmet"))) {
      recordPass("TEST 5A: Submission with FAIL criterion rejected from approval (HTTP 400)", body5A.error);
    } else {
      recordFail("TEST 5A: FAIL criterion check", `Expected 400, got ${res5A.status}: ${JSON.stringify(body5A)}`);
    }

    const m5B = await createMilestone(106, "Milestone 10.1 - Inconclusive Criterion");
    const sub5B = await createSubmission(m5B.id);
    await createVerificationReport(sub5B.id, m5B.id, [
      { id: "c1", text: "Unit tests", result: "PASS" },
      { id: "c2", text: "Staging deployment", result: "INCONCLUSIVE", explanation: "Staging host timed out" }
    ], 'NEEDS_EVIDENCE');

    const res5B = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m5B.id,
        submissionId: sub5B.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body5B = await res5B.json();
    if (res5B.status === 400 && (body5B.error.includes("Verification Policy Violation") || body5B.error.includes("Acceptance Criteria Unmet"))) {
      recordPass("TEST 5B: Submission with INCONCLUSIVE criterion rejected from approval (HTTP 400)", body5B.error);
    } else {
      recordFail("TEST 5B: INCONCLUSIVE criterion check", `Expected 400, got ${res5B.status}: ${JSON.stringify(body5B)}`);
    }

    // =========================================================================
    // 6. Duplicate Approval
    // =========================================================================
    console.log("\n--- 6. Testing Duplicate Approval ---");
    // Attempting to approve m1 again (which was approved in Test 1)
    const res6 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m1.id,
        submissionId: sub1.id,
        decision: "approve",
        confirmed: true
      })
    });

    const body6 = await res6.json();
    if (res6.status === 409 && body6.error.includes("already been approved")) {
      recordPass("TEST 6: Duplicate approval request rejected with HTTP 409 Conflict", body6.error);
    } else {
      recordFail("TEST 6: Duplicate approval check", `Expected 409, got ${res6.status}: ${JSON.stringify(body6)}`);
    }

    // =========================================================================
    // 7. Concurrent Approval Requests
    // =========================================================================
    console.log("\n--- 7. Testing Concurrent Approval Requests ---");
    const m7 = await createMilestone(107, "Milestone 10.1 - Concurrent Race");
    const sub7 = await createSubmission(m7.id);
    await createVerificationReport(sub7.id, m7.id, [{ id: "c1", result: "PASS" }], 'VERIFIED');

    const [raceRes1, raceRes2] = await Promise.all([
      fetch(DECISION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${clientTokenA}` },
        body: JSON.stringify({ milestoneId: m7.id, submissionId: sub7.id, decision: "approve", confirmed: true })
      }),
      fetch(DECISION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${clientTokenA}` },
        body: JSON.stringify({ milestoneId: m7.id, submissionId: sub7.id, decision: "approve", confirmed: true })
      })
    ]);

    const statuses = [raceRes1.status, raceRes2.status].sort();
    // One must succeed (200), and the other must be caught by lock (409) or duplicate check (409)
    if (statuses[0] === 200 && statuses[1] === 409) {
      recordPass("TEST 7A: Concurrent requests safely handled by concurrency lock (Statuses: 200, 409)");
    } else {
      recordFail("TEST 7A: Concurrent requests race", `Unexpected statuses: ${statuses.join(', ')}`);
    }

    // Verify milestone database integrity
    const { data: m7Db } = await adminClient.from('milestones').select('*').eq('id', m7.id).single();
    if (m7Db.status === 'approved' && m7Db.payment_status === 'authorized') {
      recordPass("TEST 7B: Milestone database state integrity verified after concurrency race");
    } else {
      recordFail("TEST 7B: Milestone state corrupted", JSON.stringify(m7Db));
    }

    // =========================================================================
    // 8. Revision Request
    // =========================================================================
    console.log("\n--- 8. Testing Revision Request ---");
    const m8 = await createMilestone(108, "Milestone 10.1 - Revision Request");
    const sub8 = await createSubmission(m8.id);
    await createVerificationReport(sub8.id, m8.id, [{ id: "c1", result: "PASS" }], 'VERIFIED');

    const feedbackNotes8 = "Please update mobile navigation padding and re-test on iOS Safari.";
    const res8 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m8.id,
        submissionId: sub8.id,
        decision: "request_revision",
        feedbackNotes: feedbackNotes8
      })
    });

    const body8 = await res8.json();
    if (res8.status === 200 && body8.success && body8.submission.status === 'revision_requested') {
      recordPass("TEST 8A: Revision request returned HTTP 200 with revision_requested status", `submission status: ${body8.submission.status}`);
    } else {
      recordFail("TEST 8A: Revision request", `HTTP ${res8.status}: ${JSON.stringify(body8)}`);
    }

    // Verify database record
    const { data: sub8Db } = await adminClient.from('submissions').select('*').eq('id', sub8.id).single();
    const { data: report8Db } = await adminClient.from('verification_reports').select('*').eq('submission_id', sub8.id).single();

    if (sub8Db.status === 'revision_requested' && report8Db.client_decision === 'revisions_requested' && report8Db.client_notes === feedbackNotes8) {
      recordPass("TEST 8B: Database verified: submission status='revision_requested' and client feedback stored");
    } else {
      recordFail("TEST 8B: Database revision verification", `sub: ${sub8Db?.status}, report: ${report8Db?.client_decision}`);
    }

    // =========================================================================
    // 9. Rejection With and Without Explanation
    // =========================================================================
    console.log("\n--- 9. Testing Rejection With and Without Explanation ---");
    const m9 = await createMilestone(109, "Milestone 10.1 - Rejection");
    const sub9 = await createSubmission(m9.id);
    await createVerificationReport(sub9.id, m9.id, [{ id: "c1", result: "FAIL" }], 'FAILED');

    // Rejection without explanation: must fail
    const res9A = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m9.id,
        submissionId: sub9.id,
        decision: "reject",
        feedbackNotes: "   " // Empty whitespace
      })
    });

    const body9A = await res9A.json();
    if (res9A.status === 400 && body9A.error.includes("Mandatory Explanation")) {
      recordPass("TEST 9A: Rejection without explanation rejected with HTTP 400", body9A.error);
    } else {
      recordFail("TEST 9A: Rejection without explanation", `Expected 400, got ${res9A.status}: ${JSON.stringify(body9A)}`);
    }

    // Rejection with explanation: must succeed
    const rejectionExplanation = "The submitted deliverables do not meet contractual specification and failed test suites.";
    const res9B = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m9.id,
        submissionId: sub9.id,
        decision: "reject",
        feedbackNotes: rejectionExplanation
      })
    });

    const body9B = await res9B.json();
    if (res9B.status === 200 && body9B.success && body9B.submission.status === 'rejected') {
      recordPass("TEST 9B: Rejection with explanation succeeded with HTTP 200", `submission status: ${body9B.submission.status}`);
    } else {
      recordFail("TEST 9B: Rejection with explanation", `Expected 200, got ${res9B.status}: ${JSON.stringify(body9B)}`);
    }

    const { data: sub9Db } = await adminClient.from('submissions').select('*').eq('id', sub9.id).single();
    if (sub9Db.status === 'rejected') {
      recordPass("TEST 9C: Database verified: submission status updated to 'rejected'");
    } else {
      recordFail("TEST 9C: Database rejection verification", `Status: ${sub9Db.status}`);
    }

    // =========================================================================
    // 10. Unauthorized Submission Access
    // =========================================================================
    console.log("\n--- 10. Testing Unauthorized Submission Access ---");
    // Unauthenticated GET
    const res10A = await fetch(`${DECISION_URL}?milestoneId=${m1.id}`);
    if (res10A.status === 401) {
      recordPass("TEST 10A: Unauthenticated review query rejected with HTTP 401");
    } else {
      recordFail("TEST 10A: Unauthenticated query check", `Expected 401, got ${res10A.status}`);
    }

    // Non-participant user GET
    const res10B = await fetch(`${DECISION_URL}?milestoneId=${m1.id}`, {
      headers: { "Authorization": `Bearer ${clientTokenB}` }
    });
    const body10B = await res10B.json();
    if (res10B.status === 403) {
      recordPass("TEST 10B: Non-participant user query rejected with HTTP 403 Forbidden", body10B.error);
    } else {
      recordFail("TEST 10B: Non-participant query check", `Expected 403, got ${res10B.status}: ${JSON.stringify(body10B)}`);
    }

    // Authorized client GET
    const res10C = await fetch(`${DECISION_URL}?milestoneId=${m1.id}`, {
      headers: { "Authorization": `Bearer ${clientTokenA}` }
    });
    const body10C = await res10C.json();
    if (res10C.status === 200 && body10C.success && body10C.userRole === 'client' && body10C.milestone.id === m1.id) {
      recordPass("TEST 10C: Authorized client review query succeeded with HTTP 200 and complete payload");
    } else {
      recordFail("TEST 10C: Authorized client query", `Expected 200, got ${res10C.status}: ${JSON.stringify(body10C)}`);
    }

    // Authorized freelancer GET
    const res10D = await fetch(`${DECISION_URL}?milestoneId=${m1.id}`, {
      headers: { "Authorization": `Bearer ${freelancerToken}` }
    });
    const body10D = await res10D.json();
    if (res10D.status === 200 && body10D.success && body10D.userRole === 'freelancer') {
      recordPass("TEST 10D: Authorized freelancer review query succeeded with HTTP 200 and role='freelancer'");
    } else {
      recordFail("TEST 10D: Authorized freelancer query", `Expected 200, got ${res10D.status}: ${JSON.stringify(body10D)}`);
    }

    // =========================================================================
    // 11. Explicit Approval Confirmation Requirement
    // =========================================================================
    console.log("\n--- 11. Testing Explicit Approval Confirmation Requirement ---");
    const m11 = await createMilestone(111, "Milestone 10.1 - Unconfirmed Approval");
    const sub11 = await createSubmission(m11.id);
    await createVerificationReport(sub11.id, m11.id, [{ id: "c1", result: "PASS" }], 'VERIFIED');

    const res11 = await fetch(DECISION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m11.id,
        submissionId: sub11.id,
        decision: "approve",
        confirmed: false // Explicit confirmation missing/false!
      })
    });

    const body11 = await res11.json();
    if (res11.status === 400 && body11.error.includes("Confirmation Required")) {
      recordPass("TEST 11: Unconfirmed approval request rejected with HTTP 400", body11.error);
    } else {
      recordFail("TEST 11: Unconfirmed approval check", `Expected 400, got ${res11.status}: ${JSON.stringify(body11)}`);
    }

  } catch (err) {
    console.error("Test Suite Runtime Error:", err);
    recordFail("Test Suite Execution", err.message);
  } finally {
    console.log("\n--- Cleaning up temporary test fixtures ---");
    try {
      if (createdReports.length > 0) {
        await adminClient.from('verification_reports').delete().in('id', createdReports);
      }
      if (createdSubmissions.length > 0) {
        await adminClient.from('submissions').delete().in('id', createdSubmissions);
      }
      if (createdMilestones.length > 0) {
        await adminClient.from('milestones').delete().in('id', createdMilestones);
      }
      if (createdThirdUser && clientUserB) {
        await adminClient.auth.admin.deleteUser(clientUserB.id);
      }
      console.log("✓ Test fixtures cleaned up successfully.");
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr.message);
    }

    console.log("\n=============================================================================");
    console.log(`TOTAL PASSED: ${testResults.passed.length}`);
    console.log(`TOTAL FAILED: ${testResults.failed.length}`);
    console.log("=============================================================================");

    if (testResults.failed.length > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

runTestSuite();
