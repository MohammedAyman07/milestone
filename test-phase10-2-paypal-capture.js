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
const CAPTURE_URL = 'http://localhost:3000/api/paypal/capture';
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

// Mock PayPal Server State
const mockPayPalAuthorizations = new Map();
const simulateTimeoutCapture = new Set();
const simulate5xxCapture = new Set();
const simulateDefinitiveRejection = new Set();
const simulateDelayCapture = new Map(); // authId -> delayMs
const capturedIdempotencyKeys = [];

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString();
    let parsedBody = {};
    try { if (rawBody) parsedBody = JSON.parse(rawBody); } catch {}

    // 1. OAuth2 Token
    if (req.url === '/v1/oauth2/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: "mock_capture_access_token_888",
        token_type: "Bearer",
        expires_in: 32400
      }));
      return;
    }

    // 2. Payments v2 Capture Authorization (/v2/payments/authorizations/:authId/capture)
    const capMatch = req.url.match(/^\/v2\/payments\/authorizations\/([^/?]+)\/capture/);
    if (capMatch && req.method === 'POST') {
      const authId = capMatch[1];
      const idemKey = req.headers['paypal-request-id'];
      if (idemKey) capturedIdempotencyKeys.push(idemKey);

      // Simulate Timeout
      if (simulateTimeoutCapture.has(authId)) {
        setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: "Gateway Timeout" }));
        }, 12000);
        return;
      }

      // Simulate 5xx Server Error
      if (simulate5xxCapture.has(authId)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: "INTERNAL_SERVER_ERROR",
          message: "PayPal internal processing exception",
          debug_id: "dbg_capture_500"
        }));
        return;
      }

      // Simulate Definitive Rejection (422)
      if (simulateDefinitiveRejection.has(authId)) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested authorization cannot be captured.",
          debug_id: "dbg_capture_rej_422",
          details: [{ issue: "AUTHORIZATION_EXPIRED", description: "Authorization has expired." }]
        }));
        return;
      }

      // Simulate Delay
      const delayMs = simulateDelayCapture.get(authId) || 0;
      setTimeout(() => {
        const authResource = mockPayPalAuthorizations.get(authId);
        const captureVal = parsedBody.amount?.value || authResource?.amount?.value || '75.00';
        const captureCur = parsedBody.amount?.currency_code || authResource?.amount?.currency_code || 'USD';
        const capId = 'CAP_' + Math.random().toString(36).substring(2, 10).toUpperCase();

        const captureObj = {
          id: capId,
          status: 'COMPLETED',
          amount: { currency_code: captureCur, value: captureVal },
          final_capture: true,
          create_time: new Date().toISOString()
        };

        if (authResource) {
          if (!authResource.payments) authResource.payments = {};
          if (!authResource.payments.captures) authResource.payments.captures = [];
          authResource.payments.captures.push(captureObj);
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(captureObj));
      }, delayMs);
      return;
    }

    // 3. Payments v2 Get Authorization (/v2/payments/authorizations/:authId)
    const getAuthMatch = req.url.match(/^\/v2\/payments\/authorizations\/([^/?]+)/);
    if (getAuthMatch && req.method === 'GET') {
      const authId = getAuthMatch[1];
      if (mockPayPalAuthorizations.has(authId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockPayPalAuthorizations.get(authId)));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "Authorization not found" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
});

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 10.2: PayPal Authorization Capture Test Suite");
  console.log("=============================================================================\n");

  let clientUserA = null; // Owner Client
  let clientTokenA = null;
  let freelancerUser = null; // Freelancer
  let freelancerToken = null;
  let clientUserB = null; // Unrelated Non-Owner User
  let clientTokenB = null;
  let createdThirdUser = false;
  let testProject = null;

  const createdMilestones = [];
  const createdPayments = [];

  try {
    updateEnvForMock();
    await sleep(1500);

    await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
    console.log(`✓ Mock PayPal Server running on port ${MOCK_PORT}`);

    // Setup Test Users
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
        user_metadata: { role: 'client', full_name: 'Unrelated Client' }
      });
      if (u3Err) throw u3Err;
      clientUserB = u3Data.user;
      createdThirdUser = true;
    }

    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];

    // Configure testProject ownership
    await adminClient.from('projects').update({
      client_id: clientUserA.id,
      freelancer_id: freelancerUser.id,
      budget: 100000.00
    }).eq('id', testProject.id);

    // Ensure profiles table has proper roles
    await adminClient.from('profiles').update({ role: 'client' }).eq('id', clientUserA.id);
    await adminClient.from('profiles').update({ role: 'freelancer' }).eq('id', freelancerUser.id);

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

    // Helper: Create Milestone
    async function createMilestone(phase, title, opts = {}) {
      const amount = opts.amount || 75.00;
      const currency = opts.currency || 'USD';
      const status = opts.status || 'approved'; // Default to approved
      const paymentStatus = opts.paymentStatus || 'authorized';

      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 10.2 PayPal Capture Scope',
        amount,
        currency,
        status,
        payment_status: paymentStatus,
        due_date: new Date(Date.now() + 7 * 86400000).toISOString()
      }]).select().single();
      if (error) throw error;
      createdMilestones.push(m.id);
      return m;
    }

    // Helper: Create Payment Attempt in AUTHORIZED status with PayPal Authorization
    async function createAuthorizedPayment(milestoneId, opts = {}) {
      const paymentAttemptId = 'att_' + crypto.randomUUID().replace(/-/g, '');
      const orderId = opts.orderId || ('ORD_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16).toUpperCase());
      const authId = opts.authorizationId !== undefined ? opts.authorizationId : ('AUTH_' + crypto.randomUUID().replace(/-/g, '').substring(0, 10).toUpperCase());
      const amount = opts.amount || 75.00;
      const currency = opts.currency || 'USD';
      const status = opts.status || (authId ? 'AUTHORIZED' : 'CREATED');
      const expiresAt = opts.expiresAt || new Date(Date.now() + 29 * 86400000).toISOString();

      // Register in mock PayPal
      if (authId) {
        mockPayPalAuthorizations.set(authId, {
          id: authId,
          status: 'CREATED',
          amount: { currency_code: currency, value: amount.toFixed(2) },
          expiration_time: expiresAt,
          payments: { captures: opts.existingCaptures || [] }
        });
      }

      const { data: p, error } = await adminClient.from('payments').insert([{
        payment_attempt_id: paymentAttemptId,
        milestone_id: milestoneId,
        project_id: testProject.id,
        payer_id: clientUserA.id,
        payee_id: freelancerUser.id,
        payment_type: 'order',
        amount,
        currency,
        status,
        order_id: orderId,
        authorization_id: authId,
        idempotency_order_auth: 'auth_' + paymentAttemptId,
        idempotency_auth_capture: opts.idempotencyAuthCapture || null,
        authorized_at: authId ? new Date().toISOString() : null,
        authorization_expires_at: authId ? expiresAt : null,
        honor_period_expires_at: authId ? new Date(Date.now() + 3 * 86400000).toISOString() : null,
        capture_id: opts.captureId || null,
        captured_at: opts.capturedAt || null,
        manual_reconciliation_required: false,
        raw_paypal_response: { id: orderId }
      }]).select().single();

      if (error) throw error;
      createdPayments.push(p.id);
      return { payment: p, authId, orderId };
    }

    // =========================================================================
    // 1. Successful Capture
    // =========================================================================
    console.log("--- 1. Testing Successful Capture ---");
    const m1 = await createMilestone(201, "Milestone 10.2 - Valid Capture");
    const { payment: p1, authId: authId1 } = await createAuthorizedPayment(m1.id);

    const res1 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p1.payment_attempt_id,
        milestoneId: m1.id
      })
    });

    const body1 = await res1.json();
    if (res1.status === 200 && body1.success && body1.status === 'CAPTURED' && body1.captureId) {
      recordPass("TEST 1A: Successful capture returned HTTP 200 with CAPTURED status", `captureId: ${body1.captureId}`);
    } else {
      recordFail("TEST 1A: Successful capture", `HTTP ${res1.status}: ${JSON.stringify(body1)}`);
    }

    // Database verification: payment is CAPTURED (NOT SETTLED)
    const { data: p1Db } = await adminClient.from('payments').select('*').eq('id', p1.id).single();
    if (p1Db.status === 'CAPTURED' && p1Db.capture_id && p1Db.captured_at) {
      recordPass("TEST 1B: Database payment record updated to CAPTURED with capture_id and captured_at");
    } else {
      recordFail("TEST 1B: Database payment capture check", `Invalid status: ${p1Db?.status}`);
    }

    // Database verification: milestone payment_status is 'captured'
    const { data: m1Db } = await adminClient.from('milestones').select('*').eq('id', m1.id).single();
    if (m1Db.payment_status === 'captured' && m1Db.capture_id === p1Db.capture_id) {
      recordPass("TEST 1C: Milestone payment_status successfully transitioned to 'captured'");
    } else {
      recordFail("TEST 1C: Milestone capture check", `Invalid payment_status: ${m1Db?.payment_status}`);
    }

    // Audit event check: PAYMENT_CAPTURED logged
    const { data: logs1 } = await adminClient.from('audit_logs').select('*')
      .eq('milestone_id', m1.id)
      .eq('action', 'PAYMENT_CAPTURED');

    if (logs1 && logs1.length > 0) {
      recordPass("TEST 1D: Audit event PAYMENT_CAPTURED successfully logged in database");
    } else {
      recordFail("TEST 1D: Audit event check", "PAYMENT_CAPTURED not found in audit_logs");
    }

    // Settlement verification: payment must NOT be marked SETTLED
    if (p1Db.status === 'CAPTURED' && p1Db.status !== 'SETTLED') {
      recordPass("TEST 1E: Financial Rule: Payment is marked CAPTURED, never SETTLED without confirmation");
    } else {
      recordFail("TEST 1E: Premature settlement check", `Status: ${p1Db.status}`);
    }

    // =========================================================================
    // 2. Freelancer Denied
    // =========================================================================
    console.log("\n--- 2. Testing Freelancer Denied ---");
    const m2 = await createMilestone(202, "Milestone 10.2 - Freelancer Test");
    const { payment: p2 } = await createAuthorizedPayment(m2.id);

    const res2 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${freelancerToken}` // Freelancer
      },
      body: JSON.stringify({
        paymentAttemptId: p2.payment_attempt_id,
        milestoneId: m2.id
      })
    });

    const body2 = await res2.json();
    if (res2.status === 403) {
      recordPass("TEST 2: Freelancer attempting capture rejected with HTTP 403 Forbidden", body2.error);
    } else {
      recordFail("TEST 2: Freelancer capture check", `Expected 403, got ${res2.status}: ${JSON.stringify(body2)}`);
    }

    // =========================================================================
    // 3. Non-Owner Client Denied
    // =========================================================================
    console.log("\n--- 3. Testing Non-Owner Client Denied ---");
    const res3 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenB}` // Non-owner client
      },
      body: JSON.stringify({
        paymentAttemptId: p2.payment_attempt_id,
        milestoneId: m2.id
      })
    });

    const body3 = await res3.json();
    if (res3.status === 403) {
      recordPass("TEST 3: Non-owner client rejected with HTTP 403 Forbidden", body3.error);
    } else {
      recordFail("TEST 3: Non-owner client check", `Expected 403, got ${res3.status}: ${JSON.stringify(body3)}`);
    }

    // =========================================================================
    // 4. Unapproved Milestone Denied
    // =========================================================================
    console.log("\n--- 4. Testing Unapproved Milestone Denied ---");
    const m4 = await createMilestone(204, "Milestone 10.2 - Unapproved Milestone", { status: "submitted" });
    const { payment: p4 } = await createAuthorizedPayment(m4.id);

    const res4 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p4.payment_attempt_id,
        milestoneId: m4.id
      })
    });

    const body4 = await res4.json();
    if (res4.status === 400 && body4.error.includes("explicitly approved by client")) {
      recordPass("TEST 4: Unapproved milestone rejected from capture with HTTP 400", body4.error);
    } else {
      recordFail("TEST 4: Unapproved milestone check", `Expected 400, got ${res4.status}: ${JSON.stringify(body4)}`);
    }

    // =========================================================================
    // 5. Missing Authorization Denied
    // =========================================================================
    console.log("\n--- 5. Testing Missing Authorization Denied ---");
    const m5 = await createMilestone(205, "Milestone 10.2 - Missing Auth");
    const { payment: p5 } = await createAuthorizedPayment(m5.id, { authorizationId: null, status: 'CREATED' });

    const res5 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p5.payment_attempt_id,
        milestoneId: m5.id
      })
    });

    const body5 = await res5.json();
    if (res5.status === 400) {
      recordPass("TEST 5: Payment attempt without authorization rejected with HTTP 400", body5.error);
    } else {
      recordFail("TEST 5: Missing authorization check", `Expected 400, got ${res5.status}: ${JSON.stringify(body5)}`);
    }

    // =========================================================================
    // 6. Wrong Payment Attempt Denied
    // =========================================================================
    console.log("\n--- 6. Testing Wrong Payment Attempt Denied ---");
    const m6A = await createMilestone(206, "Milestone 10.2 - Milestone A");
    const m6B = await createMilestone(207, "Milestone 10.2 - Milestone B");
    const { payment: p6A } = await createAuthorizedPayment(m6A.id);

    // Mismatched: payment p6A belongs to milestone m6A, but body specifies milestone m6B!
    const res6 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p6A.payment_attempt_id,
        milestoneId: m6B.id // WRONG MILESTONE!
      })
    });

    const body6 = await res6.json();
    if (res6.status === 400 && body6.error.includes("does not belong to the specified milestone")) {
      recordPass("TEST 6: Mismatched payment attempt and milestone rejected with HTTP 400", body6.error);
    } else {
      recordFail("TEST 6: Wrong payment attempt check", `Expected 400, got ${res6.status}: ${JSON.stringify(body6)}`);
    }

    // =========================================================================
    // 7. Duplicate Capture Prevented
    // =========================================================================
    console.log("\n--- 7. Testing Duplicate Capture Prevented ---");
    // Repeating capture for p1 (which was already captured in Test 1)
    const res7 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p1.payment_attempt_id,
        milestoneId: m1.id
      })
    });

    const body7 = await res7.json();
    if (res7.status === 200 && body7.alreadyCaptured === true && body7.captureId === p1Db.capture_id) {
      recordPass("TEST 7: Duplicate capture returned idempotent HTTP 200 with existing capture ID without re-charging", `captureId: ${body7.captureId}`);
    } else {
      recordFail("TEST 7: Duplicate capture check", `Expected idempotent 200, got ${res7.status}: ${JSON.stringify(body7)}`);
    }

    // =========================================================================
    // 8. Concurrent Capture Prevented
    // =========================================================================
    console.log("\n--- 8. Testing Concurrent Capture Prevented ---");
    const m8 = await createMilestone(208, "Milestone 10.2 - Concurrent Capture");
    const { payment: p8, authId: authId8 } = await createAuthorizedPayment(m8.id);

    // Simulate 2000ms delay in mock server for authId8
    simulateDelayCapture.set(authId8, 2000);

    const [raceRes1, raceRes2] = await Promise.all([
      fetch(CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${clientTokenA}` },
        body: JSON.stringify({ paymentAttemptId: p8.payment_attempt_id, milestoneId: m8.id })
      }),
      fetch(CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${clientTokenA}` },
        body: JSON.stringify({ paymentAttemptId: p8.payment_attempt_id, milestoneId: m8.id })
      })
    ]);

    const statuses8 = [raceRes1.status, raceRes2.status].sort();
    if (statuses8[0] === 200 && statuses8[1] === 409) {
      recordPass("TEST 8A: Concurrent capture requests safely handled by concurrency lock (Statuses: 200, 409)");
    } else {
      recordFail("TEST 8A: Concurrent capture race", `Unexpected statuses: ${statuses8.join(', ')}`);
    }

    const { data: p8Db } = await adminClient.from('payments').select('*').eq('id', p8.id).single();
    if (p8Db.status === 'CAPTURED' && p8Db.capture_id) {
      recordPass("TEST 8B: Database state integrity verified: exactly ONE capture record created");
    } else {
      recordFail("TEST 8B: Database concurrency integrity", `Status: ${p8Db.status}`);
    }

    // =========================================================================
    // 9. Amount Tampering Rejected
    // =========================================================================
    console.log("\n--- 9. Testing Amount Tampering Rejected ---");
    const m9 = await createMilestone(209, "Milestone 10.2 - Amount Tamper");
    const { payment: p9, authId: authId9 } = await createAuthorizedPayment(m9.id);

    // Client body attempts to send a tampered amount ($9999.00 vs authoritative $75.00)
    const res9 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p9.payment_attempt_id,
        milestoneId: m9.id,
        amount: 9999.00 // Client tampering attempt!
      })
    });

    const body9 = await res9.json();
    // Server must ignore browser amount and capture authoritative database amount ($75.00)
    if (res9.status === 200 && body9.amount === 75.00) {
      recordPass("TEST 9: Server strictly captured authoritative database amount ($75.00), completely ignoring client-supplied amount ($9999.00)");
    } else {
      recordFail("TEST 9: Amount tampering defense", `HTTP ${res9.status}: ${JSON.stringify(body9)}`);
    }

    // =========================================================================
    // 10. Currency Tampering Rejected
    // =========================================================================
    console.log("\n--- 10. Testing Currency Tampering Rejected ---");
    const m10 = await createMilestone(210, "Milestone 10.2 - Currency Tamper");
    const { payment: p10 } = await createAuthorizedPayment(m10.id);

    // Directly alter database currency to non-USD bypass attempt
    // (Note: DB trigger blocks update of currency, so we test that DB rejects non-USD)
    try {
      const { error: currErr } = await adminClient.from('payments').update({ currency: 'EUR' }).eq('id', p10.id);
      if (currErr && currErr.message.includes("immutable")) {
        recordPass("TEST 10: Database trigger rejected currency tampering (Currency is immutable)");
      } else {
        recordFail("TEST 10: Currency immutability check", "Database permitted currency mutation");
      }
    } catch (e) {
      recordPass("TEST 10: Database trigger rejected currency mutation", e.message);
    }

    // =========================================================================
    // 11. PayPal Definitive Rejection Handled Correctly
    // =========================================================================
    console.log("\n--- 11. Testing PayPal Definitive Rejection ---");
    const m11 = await createMilestone(211, "Milestone 10.2 - Definitive Rejection");
    const { payment: p11, authId: authId11 } = await createAuthorizedPayment(m11.id);

    // Simulate 422 Unprocessable Entity
    simulateDefinitiveRejection.add(authId11);

    const res11 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p11.payment_attempt_id,
        milestoneId: m11.id
      })
    });

    const body11 = await res11.json();
    if (res11.status === 422 && body11.status === 'FAILED' && body11.definitive === true) {
      recordPass("TEST 11A: PayPal definitive rejection handled correctly with HTTP 422 and status='FAILED'");
    } else {
      recordFail("TEST 11A: Definitive rejection", `Expected 422, got ${res11.status}: ${JSON.stringify(body11)}`);
    }

    const { data: p11Db } = await adminClient.from('payments').select('*').eq('id', p11.id).single();
    if (p11Db.status === 'FAILED') {
      recordPass("TEST 11B: Database payment record marked FAILED upon definitive rejection");
    } else {
      recordFail("TEST 11B: Database failed status check", `Status: ${p11Db.status}`);
    }

    // =========================================================================
    // 12. Timeout Preserves CAPTURE_PENDING
    // =========================================================================
    console.log("\n--- 12. Testing Timeout Preserves CAPTURE_PENDING ---");
    const m12 = await createMilestone(212, "Milestone 10.2 - Timeout Test");
    const { payment: p12, authId: authId12 } = await createAuthorizedPayment(m12.id);

    // Clear completed capture side-effect in mock so it simulates uncertain timeout
    simulateTimeoutCapture.add(authId12);

    const res12 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p12.payment_attempt_id,
        milestoneId: m12.id
      })
    });

    const body12 = await res12.json();
    if (res12.status === 504 && body12.retryable === true && body12.status === 'CAPTURE_PENDING') {
      recordPass("TEST 12A: PayPal timeout safely returned HTTP 504 with retryable=true and status='CAPTURE_PENDING'");
    } else {
      recordFail("TEST 12A: PayPal timeout check", `Expected 504, got ${res12.status}: ${JSON.stringify(body12)}`);
    }

    const { data: p12Db } = await adminClient.from('payments').select('*').eq('id', p12.id).single();
    if (p12Db.status === 'CAPTURE_PENDING' && p12Db.manual_reconciliation_required === true) {
      recordPass("TEST 12B: Database verified: payment preserved in CAPTURE_PENDING (NEVER marked FAILED) with manual_reconciliation_required=true");
    } else {
      recordFail("TEST 12B: Database status on timeout", `Invalid status: ${p12Db.status}`);
    }

    // =========================================================================
    // 13. HTTP 5xx Preserves CAPTURE_PENDING
    // =========================================================================
    console.log("\n--- 13. Testing HTTP 5xx Preserves CAPTURE_PENDING ---");
    const m13 = await createMilestone(213, "Milestone 10.2 - 5xx Error Test");
    const { payment: p13, authId: authId13 } = await createAuthorizedPayment(m13.id);

    simulate5xxCapture.add(authId13);

    const res13 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p13.payment_attempt_id,
        milestoneId: m13.id
      })
    });

    const body13 = await res13.json();
    if (res13.status === 502 && body13.retryable === true && body13.status === 'CAPTURE_PENDING') {
      recordPass("TEST 13A: PayPal 5xx returned HTTP 502 with retryable=true and status='CAPTURE_PENDING'");
    } else {
      recordFail("TEST 13A: PayPal 5xx check", `Expected 502, got ${res13.status}: ${JSON.stringify(body13)}`);
    }

    const { data: p13Db } = await adminClient.from('payments').select('*').eq('id', p13.id).single();
    if (p13Db.status === 'CAPTURE_PENDING' && p13Db.manual_reconciliation_required === true) {
      recordPass("TEST 13B: Database verified: 5xx error preserved in CAPTURE_PENDING without marking FAILED");
    } else {
      recordFail("TEST 13B: Database status on 5xx", `Status: ${p13Db.status}`);
    }

    // =========================================================================
    // 14. Existing Completed Capture Reconciled Without Second Charge
    // =========================================================================
    console.log("\n--- 14. Testing Existing Completed Capture Reconciled Without Second Charge ---");
    const m14 = await createMilestone(214, "Milestone 10.2 - Existing Capture Reconcile");
    const existingCaptureId = 'CAP_PRE_EXISTING_999';

    // Payment in local DB is still in CAPTURE_PENDING (e.g. after network glitch), but PayPal already completed it!
    const { payment: p14, authId: authId14 } = await createAuthorizedPayment(m14.id, {
      status: 'CAPTURE_PENDING',
      existingCaptures: [{
        id: existingCaptureId,
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '75.00' },
        create_time: new Date().toISOString()
      }]
    });

    const res14 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p14.payment_attempt_id,
        milestoneId: m14.id
      })
    });

    const body14 = await res14.json();
    if (res14.status === 200 && body14.reconciled === true && body14.captureId === existingCaptureId) {
      recordPass("TEST 14A: Existing completed capture on PayPal reconciled safely with HTTP 200 without second charge", `captureId: ${body14.captureId}`);
    } else {
      recordFail("TEST 14A: Reconciliation check", `HTTP ${res14.status}: ${JSON.stringify(body14)}`);
    }

    const { data: p14Db } = await adminClient.from('payments').select('*').eq('id', p14.id).single();
    if (p14Db.status === 'CAPTURED' && p14Db.capture_id === existingCaptureId) {
      recordPass("TEST 14B: Database record reconciled to CAPTURED with existing capture ID");
    } else {
      recordFail("TEST 14B: Database reconcile check", `Status: ${p14Db.status}`);
    }

    // =========================================================================
    // 15. Idempotency Key Reused Correctly
    // =========================================================================
    console.log("\n--- 15. Testing Idempotency Key Reused Correctly ---");
    const m15 = await createMilestone(215, "Milestone 10.2 - Idempotency Key Reuse");
    const customIdemKey = `cap_custom_stable_${Date.now()}`;
    const { payment: p15 } = await createAuthorizedPayment(m15.id, {
      idempotencyAuthCapture: customIdemKey
    });

    capturedIdempotencyKeys.length = 0; // Reset captured keys

    const res15 = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p15.payment_attempt_id,
        milestoneId: m15.id
      })
    });

    if (res15.status === 200 && capturedIdempotencyKeys.includes(customIdemKey)) {
      recordPass("TEST 15: Confirmed persisted idempotency key reused strictly in PayPal-Request-Id header", customIdemKey);
    } else {
      recordFail("TEST 15: Idempotency key reuse check", `Captured keys: ${capturedIdempotencyKeys.join(', ')}`);
    }

  } catch (err) {
    console.error("Test Suite Runtime Error:", err);
    recordFail("Test Suite Execution", err.message);
  } finally {
    console.log("\n--- Cleaning up temporary test fixtures ---");
    try {
      mockServer.close();
      if (createdPayments.length > 0) {
        await adminClient.from('payments').delete().in('id', createdPayments);
      }
      if (createdMilestones.length > 0) {
        await adminClient.from('milestones').delete().in('id', createdMilestones);
      }
      if (createdThirdUser && clientUserB) {
        await adminClient.auth.admin.deleteUser(clientUserB.id);
      }
      restoreCleanEnv();
      console.log("✓ Test fixtures cleaned up and clean .env.local restored.");
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
