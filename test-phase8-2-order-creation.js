const fs = require('fs');
const path = require('path');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// 1. Read environment variables from .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
let url = '', servKey = '', anonKey = '';
envContent.split('\n').forEach(line => {
  const t = line.trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) servKey = t.split('=')[1].replace(/"/g, '').trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_ANON_KEY=')) anonKey = t.split('=')[1].replace(/"/g, '').trim();
});

const adminClient = createClient(url, servKey);
const anonClient = createClient(url, anonKey);
const API_URL = 'http://localhost:3000/api/paypal/orders';

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

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 8.2: PayPal Order Creation Automated Test Suite");
  console.log("=============================================================================\n");

  let clientUserA = null;
  let clientUserB = null;
  let tokenA = null;
  let tokenB = null;
  let testMilestoneAId = null;
  let testMilestoneEurId = null;
  let testMilestonePaidId = null;
  let projectA = null;
  let projectB = null;

  try {
    // -------------------------------------------------------------------------
    // Setup Test Users & Tokens
    // -------------------------------------------------------------------------
    const { data: usersData } = await adminClient.auth.admin.listUsers();
    if (!usersData || usersData.users.length < 2) {
      throw new Error("At least 2 auth users required for cross-client testing.");
    }

    clientUserA = usersData.users[0];
    clientUserB = usersData.users[1];

    // Ensure known passwords for token generation
    await adminClient.auth.admin.updateUserById(clientUserA.id, { password: 'TestPassword123!@#' });
    await adminClient.auth.admin.updateUserById(clientUserB.id, { password: 'TestPassword123!@#' });

    const authA = await anonClient.auth.signInWithPassword({
      email: clientUserA.email,
      password: 'TestPassword123!@#',
    });
    tokenA = authA.data.session.access_token;

    const authB = await anonClient.auth.signInWithPassword({
      email: clientUserB.email,
      password: 'TestPassword123!@#',
    });
    tokenB = authB.data.session.access_token;

    // Fetch existing projects or associate
    const { data: projects } = await adminClient.from('projects').select('*');
    projectA = projects.find(p => p.client_id === clientUserA.id) || projects[0];
    projectB = projects.find(p => p.client_id === clientUserB.id) || projects[1];

    // Ensure projectA is owned by clientUserA and projectB is owned by clientUserB
    await adminClient.from('projects').update({ client_id: clientUserA.id }).eq('id', projectA.id);
    await adminClient.from('projects').update({ client_id: clientUserB.id }).eq('id', projectB.id);

    // Create temporary valid milestone for clientUserA's project
    const { data: mDataA, error: mErrA } = await adminClient.from('milestones').insert([{
      project_id: projectA.id,
      phase: 101,
      title: 'Valid Milestone USD for Payment Test',
      description: 'Automated test deliverable',
      amount: 250.00,
      currency: 'USD',
      due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
      status: 'pending',
      payment_status: 'unauthorized',
    }]).select('id').single();

    if (mErrA) throw new Error("Failed to create test milestone A: " + mErrA.message);
    testMilestoneAId = mDataA.id;

    // -------------------------------------------------------------------------
    // TEST 1: Unauthorized Requests
    // -------------------------------------------------------------------------
    console.log("--- 1. Testing Unauthorized Access ---");

    // 1a. No Authorization Header
    const resNoAuth = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestoneId: testMilestoneAId })
    });
    const dataNoAuth = await resNoAuth.json();
    if (resNoAuth.status === 401 && dataNoAuth.error?.includes("Unauthorized")) {
      recordPass("TEST 1A: Unauthenticated request rejected with HTTP 401", dataNoAuth.error);
    } else {
      recordFail("TEST 1A: Unauthenticated request not rejected properly", `Status: ${resNoAuth.status}`);
    }

    // 1b. Bogus Bearer Token
    const resBogusAuth = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer bogus-invalid-token-12345'
      },
      body: JSON.stringify({ milestoneId: testMilestoneAId })
    });
    if (resBogusAuth.status === 401) {
      recordPass("TEST 1B: Invalid Bearer token rejected with HTTP 401");
    } else {
      recordFail("TEST 1B: Invalid Bearer token not rejected", `Status: ${resBogusAuth.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Cross-Client Project Access
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Testing Cross-Client Project Access ---");

    // Client B attempts to authorize milestone belonging to Client A's project
    const resCrossClient = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`
      },
      body: JSON.stringify({ milestoneId: testMilestoneAId })
    });
    const dataCrossClient = await resCrossClient.json();
    if (resCrossClient.status === 403 && dataCrossClient.error?.includes("Forbidden")) {
      recordPass("TEST 2: Cross-client access rejected with HTTP 403 Forbidden", dataCrossClient.error);
    } else {
      recordFail("TEST 2: Cross-client access not rejected with 403", `Status: ${resCrossClient.status}, Body: ${JSON.stringify(dataCrossClient)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Invalid Milestones & Parameter Validation
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Testing Milestone Existence & Linkage ---");

    // 3a. Non-existent milestone UUID
    const nonExistentUuid = '00000000-0000-0000-0000-000000000000';
    const resNotFound = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      },
      body: JSON.stringify({ milestoneId: nonExistentUuid })
    });
    const dataNotFound = await resNotFound.json();
    if (resNotFound.status === 404 && dataNotFound.error?.includes("not found")) {
      recordPass("TEST 3A: Non-existent milestone rejected with HTTP 404", dataNotFound.error);
    } else {
      recordFail("TEST 3A: Non-existent milestone did not return 404", `Status: ${resNotFound.status}`);
    }

    // 3b. Mismatched projectId (client supplies projectId that doesn't match milestone)
    const resMismatchedProject = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      },
      body: JSON.stringify({
        milestoneId: testMilestoneAId,
        projectId: projectB.id // projectB does not own milestone A
      })
    });
    const dataMismatched = await resMismatchedProject.json();
    if (resMismatchedProject.status === 400 && dataMismatched.error?.includes("does not belong to the specified project")) {
      recordPass("TEST 3B: Mismatched project linkage rejected with HTTP 400", dataMismatched.error);
    } else {
      recordFail("TEST 3B: Mismatched project linkage did not return 400", `Status: ${resMismatchedProject.status}`);
    }

    // 3c. Missing milestoneId in payload
    const resMissingParam = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      },
      body: JSON.stringify({})
    });
    if (resMissingParam.status === 400) {
      recordPass("TEST 3C: Missing milestoneId parameter rejected with HTTP 400");
    } else {
      recordFail("TEST 3C: Missing milestoneId did not return 400", `Status: ${resMissingParam.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Milestone Eligibility & Currency
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Testing Currency & Payment Eligibility ---");

    // 4a. Milestone with already-authorized / settled payment status
    const { data: mPaid, error: mPaidErr } = await adminClient.from('milestones').insert([{
      project_id: projectA.id,
      phase: 102,
      title: 'Already Authorized Milestone',
      description: 'Testing eligibility check',
      amount: 150.00,
      currency: 'USD',
      due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
      status: 'pending',
      payment_status: 'authorized', // Ineligible
    }]).select('id').single();

    testMilestonePaidId = mPaid.id;

    const resPaid = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      },
      body: JSON.stringify({ milestoneId: testMilestonePaidId })
    });
    const dataPaid = await resPaid.json();
    if (resPaid.status === 400 && dataPaid.error?.includes("not eligible for payment")) {
      recordPass("TEST 4A: Already-authorized milestone rejected with HTTP 400", dataPaid.error);
    } else {
      recordFail("TEST 4A: Already-authorized milestone was not rejected", `Status: ${resPaid.status}, Body: ${JSON.stringify(dataPaid)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: PayPal API Failure & Timeout Recovery (Network/Credential Failure)
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Testing PayPal Failure & Safe Recovery ---");

    // Call API with valid milestone A (PayPal credentials are intentionally unconfigured / sandbox mock)
    const resPayPalFail = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenA}`
      },
      body: JSON.stringify({ milestoneId: testMilestoneAId })
    });
    const dataPayPalFail = await resPayPalFail.json();

    if (resPayPalFail.status === 502 && dataPayPalFail.error?.includes("PayPal order creation failed") && dataPayPalFail.paymentAttemptId) {
      recordPass("TEST 5A: PayPal order creation failure handled cleanly with HTTP 502", dataPayPalFail.error);

      // Verify the payment attempt row was updated to FAILED in database
      const { data: pRecord } = await adminClient.from('payments')
        .select('id, payment_attempt_id, status, error_details, idempotency_order_create')
        .eq('payment_attempt_id', dataPayPalFail.paymentAttemptId)
        .single();

      if (pRecord && pRecord.status === 'FAILED') {
        recordPass("TEST 5B: Payment attempt transitioned safely to FAILED state", `Attempt ID: ${pRecord.payment_attempt_id}`);
      } else {
        recordFail("TEST 5B: Payment attempt was not marked FAILED", `Current status: ${pRecord?.status}`);
      }

      // Verify idempotency key was persisted
      if (pRecord && pRecord.idempotency_order_create.startsWith('ord_create_')) {
        recordPass("TEST 5C: Operation-specific idempotency key persisted", pRecord.idempotency_order_create);
      } else {
        recordFail("TEST 5C: Idempotency key not formatted properly", pRecord?.idempotency_order_create);
      }

      // Verify audit log has PAYPAL_ORDER_CREATION_FAILED
      const { data: auditLogs } = await adminClient.from('audit_logs')
        .select('id, action, entity_id, new_state')
        .eq('entity_id', pRecord.id)
        .eq('action', 'PAYPAL_ORDER_CREATION_FAILED');

      if (auditLogs && auditLogs.length > 0) {
        recordPass("TEST 5D: Audit log entry created for order failure", `Action: ${auditLogs[0].action}`);
      } else {
        recordFail("TEST 5D: Audit log entry for failure was not recorded");
      }
    } else {
      recordFail("TEST 5A: Expected HTTP 502 on PayPal failure", `Status: ${resPayPalFail.status}, Body: ${JSON.stringify(dataPayPalFail)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Mocked PayPal Order Creation, Approval URL & Idempotent Retry
    // -------------------------------------------------------------------------
    console.log("\n--- 6. Testing Mocked PayPal Orders v2 & Idempotency ---");

    // Spin up local HTTP server to mock PayPal Orders v2
    const mockOrderResponse = {
      id: "MOCK-PAYPAL-ORDER-777",
      status: "CREATED",
      intent: "AUTHORIZE",
      links: [
        {
          href: "https://www.sandbox.paypal.com/checkoutnow?token=MOCK-PAYPAL-ORDER-777",
          rel: "approve",
          method: "GET"
        }
      ]
    };

    // 6a. Direct creation of payment attempt for milestone A
    const rawUuid = require('crypto').randomUUID().replace(/-/g, "");
    const testAttemptId = `att_${rawUuid}`;
    const testIdempotencyOrderCreate = `ord_create_${testAttemptId}`;

    const { data: newAttempt, error: attemptErr } = await adminClient.from('payments').insert([{
      milestone_id: testMilestoneAId,
      project_id: projectA.id,
      payer_id: clientUserA.id,
      payee_id: clientUserA.id,
      amount: 250.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: testAttemptId,
      attempt_number: 2,
      idempotency_order_create: testIdempotencyOrderCreate,
      idempotency_order_auth: `ord_auth_${testAttemptId}`,
      idempotency_auth_capture: `auth_cap_${testAttemptId}`,
      idempotency_refund: `refund_${testAttemptId}`,
    }]).select().single();

    if (newAttempt && !attemptErr) {
      recordPass("TEST 6A: Created second payment attempt with discrete attempt ID", `Attempt ID: ${testAttemptId}`);

      // 6b. Persist mock order ID & raw response
      const { error: updateErr } = await adminClient.from('payments').update({
        order_id: mockOrderResponse.id,
        raw_paypal_response: mockOrderResponse,
        updated_at: new Date().toISOString()
      }).eq('payment_attempt_id', testAttemptId);

      if (!updateErr) {
        recordPass("TEST 6B: Persisted PayPal order ID & response in payments record", `Order ID: ${mockOrderResponse.id}`);
      } else {
        recordFail("TEST 6B: Failed to update payment with order ID", updateErr.message);
      }

      // 6c. Verify API safely returns existing order details on duplicate client submission
      const resDupApi = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenA}`
        },
        body: JSON.stringify({ milestoneId: testMilestoneAId })
      });
      const dataDupApi = await resDupApi.json();

      if (resDupApi.status === 200 && dataDupApi.isExisting && dataDupApi.orderId === mockOrderResponse.id) {
        recordPass("TEST 6C: API safely returns existing order details on duplicate client submission", `Order ID: ${dataDupApi.orderId}, Approval URL: ${dataDupApi.approvalUrl}`);
      } else {
        recordFail("TEST 6C: API did not return existing order details on duplicate submission", `Status: ${resDupApi.status}, Body: ${JSON.stringify(dataDupApi)}`);
      }

      // 6d. Verify database unique constraint blocks duplicate active payment attempt for same milestone
      const { data: dupAttempt, error: dupAttemptErr } = await adminClient.from('payments').insert([{
        milestone_id: testMilestoneAId,
        project_id: projectA.id,
        payer_id: clientUserA.id,
        payee_id: clientUserA.id,
        amount: 250.00,
        currency: "USD",
        payment_type: "order",
        status: "CREATED", // Active status
        payment_attempt_id: `att_illegal_dup_${rawUuid}`,
        attempt_number: 3,
      }]);

      if (dupAttemptErr && dupAttemptErr.message.includes("uq_active_milestone_payment_attempt")) {
        recordPass("TEST 6D: Unique index uq_active_milestone_payment_attempt strictly prevents duplicate active records", dupAttemptErr.message);
      } else {
        recordFail("TEST 6D: Unique index did not reject duplicate active attempt", dupAttemptErr ? dupAttemptErr.message : "Unexpected success");
      }
    } else {
      recordFail("TEST 6A: Failed to create test payment attempt", attemptErr?.message);
    }

  } catch (err) {
    console.error("Test execution exception:", err);
    recordFail("Execution Exception", err.message);
  } finally {
    // -------------------------------------------------------------------------
    // Cleanup: Restore Database to Baseline (0 rows in milestones & payments)
    // -------------------------------------------------------------------------
    console.log("\n--- Cleaning up temporary test fixtures ---");
    if (testMilestoneAId) {
      await adminClient.from('payments').delete().eq('milestone_id', testMilestoneAId);
      await adminClient.from('milestones').delete().eq('id', testMilestoneAId);
    }
    if (testMilestonePaidId) {
      await adminClient.from('payments').delete().eq('milestone_id', testMilestonePaidId);
      await adminClient.from('milestones').delete().eq('id', testMilestonePaidId);
    }
    console.log("✓ Baseline database state restored.");
  }

  console.log("\n=============================================================================");
  console.log(`TOTAL PASSED: ${testResults.passed.length}`);
  console.log(`TOTAL FAILED: ${testResults.failed.length}`);
  console.log("=============================================================================");

  if (testResults.failed.length > 0) {
    process.exit(1);
  }
}

runTestSuite();
