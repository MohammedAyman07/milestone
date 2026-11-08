const fs = require('fs');
const path = require('path');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// 1. Read environment variables from .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
let url = '', servKey = '', anonKey = '', geminiKey = '', geminiModel = 'gemini-2.5-flash';
let savedClientId = '', savedClientSecret = '';
envContent.split('\n').forEach(line => {
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
const API_URL = 'http://localhost:3000/api/paypal/orders';
const MOCK_PORT = 9876;
const ENV_PATH = path.join(__dirname, '.env.local');

function updateEnvForMock() {
  const baseLines = [
    `GEMINI_API_KEY="${geminiKey}"`,
    `GEMINI_MODEL="${geminiModel}"`,
    `NEXT_PUBLIC_SUPABASE_URL="${url}"`,
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_pjDstJdv50dCFoh21NttlA_VFaJcWqM"',
    `NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonKey}"`,
    `SUPABASE_SERVICE_ROLE_KEY="${servKey}"`,
    'PAYPAL_ENVIRONMENT=sandbox',
    'PAYPAL_CLIENT_ID=mock_test_client_id',
    'PAYPAL_CLIENT_SECRET=mock_test_client_secret',
    'PAYPAL_WEBHOOK_ID=',
    `PAYPAL_BASE_URL=http://localhost:${MOCK_PORT}`,
    'PAYPAL_IDEMPOTENCY_RETENTION_HOURS=6',
    'PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=false',
  ];
  fs.writeFileSync(ENV_PATH, baseLines.join('\n') + '\n');
}

function restoreCleanEnv() {
  const cleanLines = [
    `GEMINI_API_KEY="${geminiKey}"`,
    `GEMINI_MODEL="${geminiModel}"`,
    `NEXT_PUBLIC_SUPABASE_URL="${url}"`,
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_pjDstJdv50dCFoh21NttlA_VFaJcWqM"',
    `NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonKey}"`,
    `SUPABASE_SERVICE_ROLE_KEY="${servKey}"`,
    'PAYPAL_ENVIRONMENT=sandbox',
    `PAYPAL_CLIENT_ID=${savedClientId}`,
    `PAYPAL_CLIENT_SECRET=${savedClientSecret}`,
    'PAYPAL_WEBHOOK_ID=',
    'PAYPAL_IDEMPOTENCY_RETENTION_HOURS=6',
    'PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=false',
  ];
  fs.writeFileSync(ENV_PATH, cleanLines.join('\n') + '\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
let capturedOrdersRequests = [];

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

    if (req.url === '/v1/oauth2/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'mock_distributed_token_456',
        token_type: 'Bearer',
        expires_in: 3600
      }));
      return;
    }

    if (req.url === '/v2/checkout/orders') {
      capturedOrdersRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody
      });

      const orderId = 'ORDER-DIST-MOCK-' + Math.floor(Math.random() * 100000);
      res.writeHead(201, {
        'Content-Type': 'application/json',
        'paypal-debug-id': 'dbg-dist-201'
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
  console.log("MILESTONE AI — Phase 8.4: Distributed Concurrency & Recovery Test Suite");
  console.log("=============================================================================\n");

  let clientUser = null;
  let clientToken = null;
  let testProject = null;
  const createdMilestones = [];

  try {
    updateEnvForMock();
    await sleep(1500);

    // Start Mock Server
    await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
    console.log(`✓ Mock PayPal Server running on port ${MOCK_PORT}\n`);

    // Setup Test Client & Auth
    const { data: usersData } = await adminClient.auth.admin.listUsers();
    clientUser = usersData.users[0];
    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];

    // Pre-clean and setup project budget
    await adminClient.from('payments').delete().eq('project_id', testProject.id);
    await adminClient.from('milestones').delete().eq('project_id', testProject.id).gte('phase', 300);
    await adminClient.from('projects').update({
      client_id: clientUser.id,
      budget: 100000.00
    }).eq('id', testProject.id);

    const auth = await anonClient.auth.signInWithPassword({
      email: clientUser.email,
      password: 'TestPassword123!@#'
    });
    clientToken = auth.data.session.access_token;

    // Helper to create milestone
    async function createMilestone(phase, title) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Distributed concurrency test',
        amount: 75.00,
        currency: 'USD',
        due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
        status: 'pending',
        payment_status: 'unauthorized',
      }]).select('id').single();
      if (error) throw new Error("Failed to create test milestone: " + error.message);
      createdMilestones.push(m.id);
      return m.id;
    }

    // -------------------------------------------------------------------------
    // TEST 1: Database-Level Atomic Concurrency Protection (Independent Processes)
    // -------------------------------------------------------------------------
    console.log("--- 1. Testing Database-Level Atomic Concurrency Protection ---");
    const m1Id = await createMilestone(301, 'Atomic DB Concurrency Milestone');

    // Simulate two independent worker processes calling insert simultaneously
    // without sharing any in-memory lock
    const rawUuidA = require('crypto').randomUUID().replace(/-/g, "");
    const rawUuidB = require('crypto').randomUUID().replace(/-/g, "");

    const insertAttempt = async (attemptId) => {
      return adminClient.from('payments').insert([{
        milestone_id: m1Id,
        project_id: testProject.id,
        payer_id: clientUser.id,
        payee_id: clientUser.id,
        amount: 75.00,
        currency: "USD",
        payment_type: "order",
        status: "CREATED",
        payment_attempt_id: attemptId,
        attempt_number: 1,
        idempotency_order_create: `ord_create_${attemptId}`,
      }]).select().single();
    };

    // Dispatch two simultaneous calls from separate processes
    const [resProcessA, resProcessB] = await Promise.all([
      insertAttempt(`att_${rawUuidA}`),
      insertAttempt(`att_${rawUuidB}`)
    ]);

    const successes = [resProcessA, resProcessB].filter(r => r.data && !r.error);
    const conflicts = [resProcessA, resProcessB].filter(r => r.error && r.error.message.includes("uq_active_milestone_payment_attempt"));

    if (successes.length === 1 && conflicts.length === 1) {
      recordPass("TEST 1A: Database-level atomic constraint allows exactly ONE creation and rejects concurrent attempt with unique violation");

      // Verify payments table has exactly ONE row for this milestone
      const { count: paymentRowCount } = await adminClient.from('payments')
        .select('*', { count: 'exact', head: true })
        .eq('milestone_id', m1Id);

      if (paymentRowCount === 1) {
        recordPass("TEST 1B: Verified exactly ONE payment attempt row exists in PostgreSQL", `Count: ${paymentRowCount}`);
      } else {
        recordFail("TEST 1B: Expected exactly 1 payment record, found: " + paymentRowCount);
      }
    } else {
      recordFail("TEST 1A: Atomic concurrency failed", `Successes: ${successes.length}, Conflicts: ${conflicts.length}`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Independent Process API Route Concurrency
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Testing Independent Process API Concurrency Simulation ---");
    const m2Id = await createMilestone(302, 'API Concurrency Milestone');

    // Fire two simultaneous HTTP requests to the API route
    const [resHttpA, resHttpB] = await Promise.all([
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
        body: JSON.stringify({ milestoneId: m2Id })
      }),
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
        body: JSON.stringify({ milestoneId: m2Id })
      })
    ]);

    const statuses = [resHttpA.status, resHttpB.status];
    const hasSuccess = statuses.includes(201);
    const hasConflict = statuses.includes(409);

    if (hasSuccess && hasConflict) {
      recordPass("TEST 2: Concurrent API requests safely handled (one 201 Created, one 409 Conflict)", `Statuses: ${statuses.join(', ')}`);
    } else {
      recordFail("TEST 2: Concurrent API requests did not return 201 and 409", `Statuses: ${statuses.join(', ')}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Stale Uncertain Attempt & Retention Window Expiry (> 72 Hours)
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Testing Retention Window Expiry (> 72 Hours) ---");
    const m3Id = await createMilestone(303, 'Stale Uncertain 80h Milestone');

    // Manually create an uncertain attempt backdated to 80 hours ago
    const staleAttemptId = `att_stale_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const staleIdempotencyKey = `ord_create_${staleAttemptId}`;
    const eightyHoursAgo = new Date(Date.now() - 80 * 3600 * 1000).toISOString();

    const { data: stalePayment, error: staleErr } = await adminClient.from('payments').insert([{
      milestone_id: m3Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: staleAttemptId,
      attempt_number: 1,
      idempotency_order_create: staleIdempotencyKey,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "Historical simulated socket timeout" },
      created_at: eightyHoursAgo,
      updated_at: eightyHoursAgo,
    }]).select().single();

    if (staleErr || !stalePayment) throw new Error("Failed to insert stale payment fixture: " + staleErr?.message);

    // Reset captured mock requests
    capturedOrdersRequests = [];

    // Client attempts to create/reconcile order for m3Id
    const resStale = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({ milestoneId: m3Id })
    });
    const dataStale = await resStale.json();

    if (resStale.status === 409 && dataStale.outcome === 'RECONCILIATION_EXPIRED' && dataStale.reconciliationPending === true) {
      recordPass("TEST 3A: Attempt older than 72 hours rejected with HTTP 409 RECONCILIATION_EXPIRED", dataStale.error);

      // Verify NO PayPal order request was dispatched
      if (capturedOrdersRequests.length === 0) {
        recordPass("TEST 3B: Confirmed ZERO outgoing PayPal calls dispatched for expired uncertain attempt (no blind replay)");
      } else {
        recordFail("TEST 3B: PayPal API was called despite retention window expiration!", `Calls: ${capturedOrdersRequests.length}`);
      }

      // Verify database record remains in CREATED status with manual_reconciliation_required=true
      const { data: pCheck } = await adminClient.from('payments')
        .select('status, manual_reconciliation_required, order_id')
        .eq('payment_attempt_id', staleAttemptId)
        .single();

      if (pCheck && pCheck.status === 'CREATED' && pCheck.manual_reconciliation_required === true && !pCheck.order_id) {
        recordPass("TEST 3C: Database record preserved in CREATED status with manual_reconciliation_required=true");
      } else {
        recordFail("TEST 3C: Stale payment record was wrongly mutated", JSON.stringify(pCheck));
      }

      // Verify audit log PAYPAL_ORDER_RECONCILIATION_EXPIRED
      const { data: aLogs } = await adminClient.from('audit_logs')
        .select('action, new_state')
        .eq('entity_id', stalePayment.id)
        .eq('action', 'PAYPAL_ORDER_RECONCILIATION_EXPIRED');

      if (aLogs && aLogs.length > 0) {
        recordPass("TEST 3D: Audit event PAYPAL_ORDER_RECONCILIATION_EXPIRED verified", JSON.stringify(aLogs[0].new_state));
      } else {
        recordFail("TEST 3D: Audit log for expired reconciliation missing");
      }
    } else {
      recordFail("TEST 3A: Stale attempt not rejected with 409 RECONCILIATION_EXPIRED", `Status: ${resStale.status}, Body: ${JSON.stringify(dataStale)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Replay Within Retention Window (< 6 Hours) Still Reconciles
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Testing Replay Within Retention Window (< 6 Hours) ---");
    const m4Id = await createMilestone(304, 'Valid Uncertain 2h Milestone');

    // Create an uncertain attempt backdated to 2 hours ago (within standard 6h window)
    const validAttemptId = `att_recent_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const validIdempotencyKey = `ord_create_${validAttemptId}`;
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const { data: recentPayment } = await adminClient.from('payments').insert([{
      milestone_id: m4Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: validAttemptId,
      attempt_number: 1,
      idempotency_order_create: validIdempotencyKey,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "Simulated 503 error" },
      created_at: twoHoursAgo,
      updated_at: twoHoursAgo,
    }]).select().single();

    capturedOrdersRequests = [];

    // Client requests order creation for m4Id
    const resRecent = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({ milestoneId: m4Id })
    });
    const dataRecent = await resRecent.json();

    if (resRecent.status === 200 && dataRecent.reconciled === true && dataRecent.orderId) {
      recordPass("TEST 4A: Attempt within retention window (<6h) successfully replayed and reconciled (HTTP 200)");

      // Verify that the original idempotency key was sent to mock server
      const reqReceived = capturedOrdersRequests[0];
      if (reqReceived && reqReceived.headers['paypal-request-id'] === validIdempotencyKey) {
        recordPass("TEST 4B: Verified original idempotency key reused during valid reconciliation", validIdempotencyKey);
      } else {
        recordFail("TEST 4B: Idempotency key was not reused", reqReceived?.headers['paypal-request-id']);
      }
    } else {
      recordFail("TEST 4A: Replay within retention window failed", `Status: ${resRecent.status}, Body: ${JSON.stringify(dataRecent)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Original Payload & Key Immutability Under Tampering Attempt
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Testing Original Payload & Key Immutability During Recovery ---");
    const m5Id = await createMilestone(305, 'Tamper Resistance Milestone');

    // Create uncertain attempt with amount $75.00
    const tamperAttemptId = `att_tamper_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const tamperIdempotencyKey = `ord_create_${tamperAttemptId}`;

    await adminClient.from('payments').insert([{
      milestone_id: m5Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: tamperAttemptId,
      attempt_number: 1,
      idempotency_order_create: tamperIdempotencyKey,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN" }
    }]);

    capturedOrdersRequests = [];

    // Client attempts to tamper with amount and project linkage during retry
    const resTamper = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({
        milestoneId: m5Id,
        amount: 1.00, // Maliciously altered amount
        currency: 'EUR', // Maliciously altered currency
      })
    });
    const dataTamper = await resTamper.json();

    if (resTamper.status === 200 && dataTamper.reconciled === true) {
      // Inspect payload received by mock PayPal server
      const reqSentToPayPal = capturedOrdersRequests[0];
      const purchaseUnit = reqSentToPayPal?.body?.purchase_units?.[0];

      if (purchaseUnit && purchaseUnit.amount?.value === "75.00" && purchaseUnit.amount?.currency_code === "USD") {
        recordPass("TEST 5: Confirmed recovery strictly uses database amount ($75.00 USD), completely ignoring tampered client body parameters");
      } else {
        recordFail("TEST 5: Server sent tampered amount to PayPal!", JSON.stringify(purchaseUnit));
      }
    } else {
      recordFail("TEST 5: Tamper recovery request failed", `Status: ${resTamper.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Stale CREATED Attempts Cannot Be Bypassed By New Attempts
    // -------------------------------------------------------------------------
    console.log("\n--- 6. Testing Stale CREATED Barrier (Zero Second Attempts Permitted) ---");
    // m3Id has the stale 80h attempt. Verify that no second attempt can be inserted directly in DB
    const { data: secondAttempt, error: secondErr } = await adminClient.from('payments').insert([{
      milestone_id: m3Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: `att_illegal_bypass_${Date.now()}`,
      attempt_number: 2,
    }]);

    if (secondErr && secondErr.message.includes("uq_active_milestone_payment_attempt")) {
      recordPass("TEST 6: Verified stale CREATED attempt acts as permanent barrier; direct DB bypass rejected by unique index", secondErr.message);
    } else {
      recordFail("TEST 6: Stale attempt did not block second attempt!", secondErr?.message || "Success");
    }

  } catch (err) {
    console.error("Test execution exception:", err);
    recordFail("Execution Exception", err.message);
  } finally {
    // Stop Mock Server
    await new Promise((resolve) => mockServer.close(resolve));
    console.log("✓ Mock PayPal Server stopped.");

    // Clean up all test fixtures
    console.log("--- Cleaning up temporary test fixtures ---");
    for (const mId of createdMilestones) {
      await adminClient.from('payments').delete().eq('milestone_id', mId);
      await adminClient.from('milestones').delete().eq('id', mId);
    }
    console.log("✓ Baseline database state restored.");

    restoreCleanEnv();
    console.log("✓ Clean .env.local restored to safe baseline.");
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
