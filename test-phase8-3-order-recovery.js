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
const MOCK_PORT = 9876;

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

// Mock Server State
let mockMode = 'success'; // 'success' | 'definitive_rejection' | 'timeout' | '5xx' | 'sleep_for_lock'
let capturedHeaders = [];
let capturedRequests = [];

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString();
    let parsedBody = {};
    try {
      parsedBody = bodyStr ? JSON.parse(bodyStr) : {};
    } catch {
      parsedBody = bodyStr;
    }
    const reqInfo = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsedBody
    };
    capturedRequests.push(reqInfo);

    // OAuth2 Token Endpoint
    if (req.url === '/v1/oauth2/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'mock_sandbox_access_token_123',
        token_type: 'Bearer',
        expires_in: 3600
      }));
      return;
    }

    // Orders v2 Endpoint
    if (req.url === '/v2/checkout/orders') {
      const idempotencyKey = req.headers['paypal-request-id'];

      if (mockMode === 'definitive_rejection') {
        res.writeHead(422, {
          'Content-Type': 'application/json',
          'paypal-debug-id': 'dbg-rej-422'
        });
        res.end(JSON.stringify({
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed because the payload is invalid.',
          debug_id: 'dbg-rej-422'
        }));
        return;
      }

      if (mockMode === '5xx') {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'paypal-debug-id': 'dbg-503-err'
        });
        res.end(JSON.stringify({
          name: 'INTERNAL_SERVER_ERROR',
          message: 'An ambiguous internal error occurred on PayPal processing nodes.',
          debug_id: 'dbg-503-err'
        }));
        return;
      }

      if (mockMode === 'timeout') {
        // Abruptly destroy socket to simulate connection failure / dropped response
        res.destroy();
        return;
      }

      if (mockMode === 'sleep_for_lock') {
        // Hold connection open for 3 seconds to test in-flight concurrency lock
        setTimeout(() => {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'ORDER-INFLIGHT-SUCCESS',
            status: 'CREATED',
            links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-INFLIGHT-SUCCESS' }]
          }));
        }, 3000);
        return;
      }

      // Default: Success
      const orderId = 'ORDER-MOCK-' + Math.floor(Math.random() * 1000000);
      res.writeHead(201, {
        'Content-Type': 'application/json',
        'paypal-debug-id': 'dbg-success-201'
      });
      res.end(JSON.stringify({
        id: orderId,
        status: 'CREATED',
        intent: 'AUTHORIZE',
        links: [
          {
            href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
            rel: 'approve',
            method: 'GET'
          }
        ]
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
});

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 8.3: Order Creation Recovery Audit Test Suite");
  console.log("=============================================================================\n");

  let clientUser = null;
  let clientToken = null;
  let testProject = null;
  const createdMilestones = [];

  try {
    // Start Mock PayPal Server
    await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
    console.log(`✓ Mock PayPal Server running on http://127.0.0.1:${MOCK_PORT}\n`);

    // Setup Test Client & Auth
    const { data: usersData } = await adminClient.auth.admin.listUsers();
    clientUser = usersData.users[0];
    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];
    // Clean up any lingering milestones from previous runs
    await adminClient.from('payments').delete().eq('project_id', testProject.id);
    await adminClient.from('milestones').delete().eq('project_id', testProject.id).gte('phase', 200);

    // Update project budget to accommodate test milestones
    await adminClient.from('projects').update({
      client_id: clientUser.id,
      budget: 100000.00
    }).eq('id', testProject.id);

    const auth = await anonClient.auth.signInWithPassword({
      email: clientUser.email,
      password: 'TestPassword123!@#'
    });
    clientToken = auth.data.session.access_token;

    // Helper to create fresh test milestone
    async function createTestMilestone(phase, title = 'Test Milestone') {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Automated test deliverable',
        amount: 50.00,
        currency: 'USD',
        due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
        status: 'pending',
        payment_status: 'unauthorized',
      }]).select('id').single();
      if (error) throw new Error("Failed to create milestone: " + error.message);
      createdMilestones.push(m.id);
      return m.id;
    }

    // -------------------------------------------------------------------------
    // TEST 1: Definitive PayPal Rejection
    // -------------------------------------------------------------------------
    console.log("--- 1. Testing Definitive PayPal Rejection (422 Unprocessable) ---");
    const m1Id = await createTestMilestone(201, 'Milestone Definitive Rejection');
    mockMode = 'definitive_rejection';

    const resDefRej = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m1Id })
    });
    const dataDefRej = await resDefRej.json();

    if (resDefRej.status === 400 && dataDefRej.definitive === true && dataDefRej.paymentAttemptId) {
      recordPass("TEST 1A: Definitive PayPal rejection returned HTTP 400 with definitive=true");

      // Verify DB attempt status is FAILED
      const { data: pRecord } = await adminClient.from('payments')
        .select('id, status, error_details, manual_reconciliation_required')
        .eq('payment_attempt_id', dataDefRej.paymentAttemptId)
        .single();

      if (pRecord && pRecord.status === 'FAILED' && pRecord.manual_reconciliation_required === false) {
        recordPass("TEST 1B: Attempt safely marked FAILED upon definitive rejection (manual_reconciliation=false)");
      } else {
        recordFail("TEST 1B: Attempt not marked FAILED properly", `Status: ${pRecord?.status}`);
      }

      // Verify audit log
      const { data: aLogs } = await adminClient.from('audit_logs')
        .select('action')
        .eq('entity_id', pRecord.id)
        .eq('action', 'PAYPAL_ORDER_CREATION_FAILED');
      if (aLogs && aLogs.length > 0) {
        recordPass("TEST 1C: Audit log PAYPAL_ORDER_CREATION_FAILED recorded");
      } else {
        recordFail("TEST 1C: Failure audit log missing");
      }
    } else {
      recordFail("TEST 1A: Definitive rejection not handled with 400", `Status: ${resDefRej.status}, Body: ${JSON.stringify(dataDefRej)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Network Timeout / Connection Drop (Uncertain Outcome)
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Testing Network Timeout / Ambiguous Failure ---");
    const m2Id = await createTestMilestone(202, 'Milestone Timeout Ambiguous');
    mockMode = 'timeout';

    const resTimeout = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m2Id })
    });
    const dataTimeout = await resTimeout.json();

    if (resTimeout.status === 202 && dataTimeout.outcome === 'UNCERTAIN' && dataTimeout.reconciliationPending === true) {
      recordPass("TEST 2A: Timeout handled as UNCERTAIN with HTTP 202 reconciliationPending=true");

      // Verify DB attempt status is STILL CREATED (NOT failed!)
      const { data: pTimeout } = await adminClient.from('payments')
        .select('id, status, manual_reconciliation_required, idempotency_order_create, order_id')
        .eq('payment_attempt_id', dataTimeout.paymentAttemptId)
        .single();

      if (pTimeout && pTimeout.status === 'CREATED' && pTimeout.manual_reconciliation_required === true && !pTimeout.order_id) {
        recordPass("TEST 2B: Attempt preserved in CREATED status with manual_reconciliation_required=true (NEVER marked FAILED)");
      } else {
        recordFail("TEST 2B: Attempt was wrongly marked failed or not updated", JSON.stringify(pTimeout));
      }

      // Verify audit log
      const { data: aLogs } = await adminClient.from('audit_logs')
        .select('action')
        .eq('entity_id', pTimeout.id)
        .eq('action', 'PAYPAL_ORDER_CREATION_UNCERTAIN');
      if (aLogs && aLogs.length > 0) {
        recordPass("TEST 2C: Audit log PAYPAL_ORDER_CREATION_UNCERTAIN recorded");
      } else {
        recordFail("TEST 2C: Uncertain audit log missing");
      }
    } else {
      recordFail("TEST 2A: Timeout did not return HTTP 202 UNCERTAIN", `Status: ${resTimeout.status}, Body: ${JSON.stringify(dataTimeout)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: PayPal 5xx Ambiguous Outcome
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Testing PayPal 5xx Ambiguous Server Error ---");
    const m3Id = await createTestMilestone(203, 'Milestone 5xx Server Error');
    mockMode = '5xx';

    const res5xx = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m3Id })
    });
    const data5xx = await res5xx.json();

    if (res5xx.status === 202 && data5xx.outcome === 'UNCERTAIN') {
      recordPass("TEST 3A: PayPal 5xx treated as UNCERTAIN (HTTP 202)");

      const { data: p5xx } = await adminClient.from('payments')
        .select('status, manual_reconciliation_required')
        .eq('payment_attempt_id', data5xx.paymentAttemptId)
        .single();

      if (p5xx && p5xx.status === 'CREATED' && p5xx.manual_reconciliation_required === true) {
        recordPass("TEST 3B: PayPal 5xx preserves CREATED status and sets manual_reconciliation_required=true");
      } else {
        recordFail("TEST 3B: 5xx attempt wrongly mutated status", JSON.stringify(p5xx));
      }
    } else {
      recordFail("TEST 3A: 5xx did not return HTTP 202", `Status: ${res5xx.status}, Body: ${JSON.stringify(data5xx)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Duplicate Request During In-Flight Operation
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Testing In-Flight Concurrency Lock ---");
    const m4Id = await createTestMilestone(204, 'Milestone In-Flight Lock');
    mockMode = 'sleep_for_lock';

    // Fire first request (asynchronous, holds lock for 3s)
    const p1 = fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m4Id })
    });

    // Wait 100ms and fire concurrent second request for same milestone
    await new Promise(r => setTimeout(r, 100));
    const resConcurrent = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m4Id })
    });
    const dataConcurrent = await resConcurrent.json();

    if (resConcurrent.status === 409 && dataConcurrent.inFlight === true) {
      recordPass("TEST 4: Concurrent in-flight request rejected with HTTP 409 inFlight=true", dataConcurrent.error);
    } else {
      recordFail("TEST 4: Concurrent request was not rejected with inFlight lock", `Status: ${resConcurrent.status}, Body: ${JSON.stringify(dataConcurrent)}`);
    }
    // Await first request completion
    await p1;

    // -------------------------------------------------------------------------
    // TEST 5, 6, 8, 9: Repeated Request After Uncertain Outcome & Reconciliation
    // -------------------------------------------------------------------------
    console.log("\n--- 5, 6, 8, 9. Testing Reconciliation of Uncertain Attempt ---");
    // We reuse m2Id (from Test 2), which is in status 'CREATED' with manual_reconciliation_required=true
    const { data: pBeforeRec } = await adminClient.from('payments')
      .select('id, payment_attempt_id, idempotency_order_create')
      .eq('milestone_id', m2Id)
      .single();

    const originalAttemptId = pBeforeRec.payment_attempt_id;
    const originalIdempotencyKey = pBeforeRec.idempotency_order_create;

    // Clear captured requests on mock server
    capturedRequests = [];
    mockMode = 'success'; // Mock server will now return success on reconciliation

    const resReconcile = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m2Id })
    });
    const dataReconcile = await resReconcile.json();

    // Check TEST 5: Repeated request triggered reconciliation
    if (resReconcile.status === 200 && dataReconcile.reconciled === true) {
      recordPass("TEST 5: Repeated request on uncertain attempt automatically triggered reconciliation");
    } else {
      recordFail("TEST 5: Reconciliation not triggered or failed", `Status: ${resReconcile.status}, Body: ${JSON.stringify(dataReconcile)}`);
    }

    // Check TEST 6: Reconciliation finding existing / confirmed order
    if (dataReconcile.orderId && dataReconcile.approvalUrl) {
      recordPass("TEST 6: Reconciliation succeeded and returned valid orderId & approvalUrl", `Order: ${dataReconcile.orderId}`);
    } else {
      recordFail("TEST 6: Missing orderId or approvalUrl in reconciliation response", JSON.stringify(dataReconcile));
    }

    // Check TEST 8: Confirmation that no new attempt was created
    const { count: attemptCount } = await adminClient.from('payments')
      .select('*', { count: 'exact', head: true })
      .eq('milestone_id', m2Id);

    if (attemptCount === 1 && dataReconcile.paymentAttemptId === originalAttemptId) {
      recordPass("TEST 8: Confirmed NO duplicate payment attempt created (Attempt count remains 1)", `Preserved Attempt: ${originalAttemptId}`);
    } else {
      recordFail("TEST 8: Duplicate payment attempt was created!", `Count: ${attemptCount}`);
    }

    // Check TEST 9: Confirmation that original idempotency key was reused
    const orderReqToMock = capturedRequests.find(r => r.url === '/v2/checkout/orders');
    const sentIdempotencyKey = orderReqToMock?.headers['paypal-request-id'];

    if (sentIdempotencyKey === originalIdempotencyKey) {
      recordPass("TEST 9: Confirmed original idempotency key was reused for reconciliation", `Key: ${sentIdempotencyKey}`);
    } else {
      recordFail("TEST 9: Original idempotency key was NOT reused!", `Expected ${originalIdempotencyKey}, got ${sentIdempotencyKey}`);
    }

    // -------------------------------------------------------------------------
    // TEST 7: Reconciliation Unable to Establish Outcome (Remains Uncertain)
    // -------------------------------------------------------------------------
    console.log("\n--- 7. Testing Reconciliation Unable to Establish Outcome ---");
    // m3Id (from Test 3) is still uncertain
    capturedRequests = [];
    mockMode = '5xx'; // Mock still fails

    const resRecPending = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m3Id })
    });
    const dataRecPending = await resRecPending.json();

    if (resRecPending.status === 202 && dataRecPending.reconciliationPending === true) {
      recordPass("TEST 7: Reconciliation unable to establish outcome remains protected with HTTP 202 (reconciliationPending=true)");
    } else {
      recordFail("TEST 7: Unresolved reconciliation did not return 202", `Status: ${resRecPending.status}, Body: ${JSON.stringify(dataRecPending)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 10: Successful Fresh Order Creation Still Works
    // -------------------------------------------------------------------------
    console.log("\n--- 10. Testing Standard Successful Order Creation ---");
    const m10Id = await createTestMilestone(210, 'Milestone Standard Success');
    mockMode = 'success';

    const resSuccess = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m10Id })
    });
    const dataSuccess = await resSuccess.json();

    if (resSuccess.status === 201 && dataSuccess.success === true && dataSuccess.orderId && dataSuccess.approvalUrl) {
      recordPass("TEST 10A: Standard order creation returned HTTP 201 with orderId and approvalUrl", `Order ID: ${dataSuccess.orderId}`);

      const { data: pSuccess } = await adminClient.from('payments')
        .select('id, status, order_id, payment_attempt_id')
        .eq('payment_attempt_id', dataSuccess.paymentAttemptId)
        .single();

      if (pSuccess && pSuccess.status === 'CREATED' && pSuccess.order_id === dataSuccess.orderId) {
        recordPass("TEST 10B: Database payment record updated with order_id in CREATED state");
      } else {
        recordFail("TEST 10B: Database record not updated properly", JSON.stringify(pSuccess));
      }

      // Verify audit logs for initiated and created
      const { data: aInit } = await adminClient.from('audit_logs')
        .select('action')
        .eq('entity_id', pSuccess.id)
        .eq('action', 'PAYPAL_ORDER_CREATION_INITIATED');

      const { data: aCreated } = await adminClient.from('audit_logs')
        .select('action')
        .eq('entity_id', pSuccess.id)
        .eq('action', 'PAYPAL_ORDER_CREATED');

      if (aInit?.length && aCreated?.length) {
        recordPass("TEST 10C: Audit logs PAYPAL_ORDER_CREATION_INITIATED and PAYPAL_ORDER_CREATED verified");
      } else {
        recordFail("TEST 10C: Audit log verification failed for successful creation");
      }
    } else {
      recordFail("TEST 10A: Standard order creation failed", `Status: ${resSuccess.status}, Body: ${JSON.stringify(dataSuccess)}`);
    }

  } catch (err) {
    console.error("Test execution exception:", err);
    recordFail("Execution Exception", err.message);
  } finally {
    // Stop Mock Server
    await new Promise((resolve) => mockServer.close(resolve));
    console.log("✓ Mock PayPal Server stopped.");

    // Cleanup Test Milestones & Payments
    console.log("--- Cleaning up temporary test fixtures ---");
    for (const mId of createdMilestones) {
      await adminClient.from('payments').delete().eq('milestone_id', mId);
      await adminClient.from('milestones').delete().eq('id', mId);
    }
    console.log("✓ Database restored to clean baseline state.");
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
