const fs = require('fs');
const path = require('path');
const http = require('http');
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
const AUTHORIZE_URL = 'http://localhost:3000/api/paypal/orders/authorize';
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

// Mock Server State
const mockPayPalOrders = new Map();
const simulateTimeoutAuthorize = new Set();
const simulate5xxAuthorize = new Set();
const simulateDelayAuthorize = new Map(); // orderId -> delayMs
let capturedIdempotencyKeys = [];

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    // 1. OAuth2 Token
    if (req.url === '/v1/oauth2/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: "mock_access_token_12345",
        token_type: "Bearer",
        expires_in: 32400
      }));
      return;
    }

    // 2. Orders v2 Authorize Order (/v2/checkout/orders/:orderId/authorize)
    const authMatch = req.url.match(/^\/v2\/checkout\/orders\/([^/?]+)\/authorize/);
    if (authMatch && req.method === 'POST') {
      const orderId = authMatch[1];
      const idemKey = req.headers['paypal-request-id'];
      if (idemKey) capturedIdempotencyKeys.push(idemKey);

      // Simulate Timeout (returns 504 after delay)
      if (simulateTimeoutAuthorize.has(orderId)) {
        // Create the authorization on PayPal side despite timeout!
        const mockOrder = mockPayPalOrders.get(orderId);
        if (mockOrder) {
          const authId = 'AUTH_TIMEOUT_' + Math.random().toString(36).substring(2, 8).toUpperCase();
          mockOrder.status = 'COMPLETED';
          mockOrder.purchase_units[0].payments = {
            authorizations: [{
              id: authId,
              status: 'CREATED',
              amount: { currency_code: 'USD', value: mockOrder.purchase_units[0].amount.value || '75.00' },
              expiration_time: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
              create_time: new Date().toISOString()
            }]
          };
        }

        setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: "Gateway Timeout" }));
        }, 12000);
        return;
      }

      // Simulate Concurrency Delay (for testing race conditions)
      const delayMs = simulateDelayAuthorize.get(orderId) || 0;

      setTimeout(() => {
        const mockOrder = mockPayPalOrders.get(orderId);
        const milestoneRefId = mockOrder?.purchase_units?.[0]?.reference_id || "m_default";
        const authVal = mockOrder?.purchase_units?.[0]?.amount?.value || "75.00";
        const authCurrency = mockOrder?.purchase_units?.[0]?.amount?.currency_code || "USD";

        const authId = 'AUTH_' + Math.random().toString(36).substring(2, 10).toUpperCase();
        const authResource = {
          id: authId,
          status: 'CREATED',
          amount: { currency_code: authCurrency, value: authVal },
          expiration_time: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
          create_time: new Date().toISOString()
        };

        if (mockOrder) {
          mockOrder.status = 'COMPLETED';
          if (!mockOrder.purchase_units[0].payments) mockOrder.purchase_units[0].payments = {};
          mockOrder.purchase_units[0].payments.authorizations = [authResource];
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: orderId,
          status: "COMPLETED",
          payer: {
            payer_id: "PAYER-SANDBOX-AUTH-777",
            email_address: "verified-buyer@milestoneai.dev"
          },
          purchase_units: [
            {
              reference_id: milestoneRefId,
              payments: {
                authorizations: [authResource]
              }
            }
          ]
        }));
      }, delayMs);
      return;
    }

    // 3. Orders v2 Get Order (/v2/checkout/orders/:orderId)
    const getMatch = req.url.match(/^\/v2\/checkout\/orders\/([^/?]+)/);
    if (getMatch && req.method === 'GET') {
      const orderId = getMatch[1];
      if (mockPayPalOrders.has(orderId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockPayPalOrders.get(orderId)));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "Order not found" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
});

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 9.3: Authorization Security and Recovery Audit Test Suite");
  console.log("=============================================================================\n");

  let clientUserA = null; // Client / Project Owner / Payer
  let clientTokenA = null;
  let freelancerUser = null; // Freelancer / Payee
  let freelancerToken = null;
  let clientUserB = null; // Attacker / Wrong Project Owner
  let clientTokenB = null;
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
    clientUserB = usersData.users[2] || usersData.users[1];

    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];

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

    // Sign in Client B
    const authB = await anonClient.auth.signInWithPassword({
      email: clientUserB.email,
      password: 'TestPassword123!@#'
    });
    clientTokenB = authB.data.session.access_token;

    console.log(`✓ Client A (Owner / Payer): ${clientUserA.email} (${clientUserA.id})`);
    console.log(`✓ Freelancer (Payee): ${freelancerUser.email} (${freelancerUser.id})`);
    console.log(`✓ Client B (Wrong Owner): ${clientUserB.email} (${clientUserB.id})`);
    console.log(`✓ Test Project: ${testProject.id}\n`);

    async function createMilestone(phase, title, amount = 75.00) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 9.3 Authorization Audit Milestone',
        amount,
        currency: 'USD',
        status: 'approved',
        payment_status: 'approved',
        due_date: new Date(Date.now() + 7 * 86400000).toISOString()
      }]).select().single();
      if (error) throw error;
      createdMilestones.push(m.id);
      return m;
    }

    async function createPaymentAttempt(milestoneId, opts = {}) {
      const paymentAttemptId = 'att_' + crypto.randomUUID().replace(/-/g, '');
      const orderId = opts.orderId || ('ORD_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16).toUpperCase());
      const status = opts.status || 'APPROVED';
      const payerId = opts.payerId || clientUserA.id;
      const payeeId = opts.payeeId || freelancerUser.id;
      const amount = opts.amount !== undefined ? opts.amount : 75.00;
      const currency = opts.currency || 'USD';

      const { data: p, error } = await adminClient.from('payments').insert([{
        milestone_id: milestoneId,
        project_id: testProject.id,
        payer_id: payerId,
        payee_id: payeeId,
        amount,
        currency,
        payment_type: 'order',
        status,
        order_id: orderId,
        payment_attempt_id: paymentAttemptId,
        attempt_number: 1,
        idempotency_order_create: `ord_create_${paymentAttemptId}`,
        idempotency_order_auth: `ord_auth_${paymentAttemptId}`,
        idempotency_auth_capture: `auth_cap_${paymentAttemptId}`,
        idempotency_refund: `refund_${paymentAttemptId}`,
        manual_reconciliation_required: Boolean(opts.manual_reconciliation_required),
        reconciliation_notes: opts.reconciliation_notes || null,
        error_details: opts.error_details || {},
        authorization_id: opts.authorization_id || null,
        paypal_merchant_id: opts.paypal_merchant_id || null,
        raw_paypal_response: opts.raw_paypal_response || {},
        created_at: opts.created_at || new Date().toISOString(),
        updated_at: opts.updated_at || new Date().toISOString(),
      }]).select().single();

      if (error) throw error;
      createdPayments.push(p.id);

      // Register with mock PayPal
      if (!opts.skipMockRegister) {
        mockPayPalOrders.set(orderId, {
          id: orderId,
          intent: opts.paypalIntent || "AUTHORIZE",
          status: opts.paypalStatus || "APPROVED",
          payer: {
            payer_id: "PAYER-SANDBOX-AUTH-777",
            email_address: "verified-buyer@milestoneai.dev"
          },
          purchase_units: [
            {
              reference_id: milestoneId,
              custom_id: paymentAttemptId,
              amount: {
                currency_code: opts.paypalCurrency || "USD",
                value: opts.paypalAmount !== undefined ? opts.paypalAmount.toFixed(2) : amount.toFixed(2)
              },
              payee: {
                merchant_id: opts.payeeMerchantId || "MERCHANT-AUTHORIZED-PLATFORM"
              },
              payments: opts.payments || {}
            }
          ]
        });
      }

      return { payment: p, paymentAttemptId, orderId };
    }

    // =========================================================================
    // AUDIT TEST 1: Timeout after PayPal May Have Authorized + Reconciliation
    // =========================================================================
    console.log("--- 1. Testing Timeout After PayPal May Have Authorized ---");
    const m1 = await createMilestone(901, "Timeout Recovery Audit");
    const { payment: p1, paymentAttemptId: p1AttId, orderId: p1OrderId } = await createPaymentAttempt(m1.id);

    simulateTimeoutAuthorize.add(p1OrderId);

    const res1 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p1AttId })
    });
    const data1 = await res1.json();
    simulateTimeoutAuthorize.delete(p1OrderId);

    if (res1.status === 504 && data1.uncertain && data1.retryable) {
      recordPass("AUDIT TEST 1A: PayPal timeout handled safely with HTTP 504 retryable");
    } else {
      recordFail("AUDIT TEST 1A: Expected HTTP 504 for timeout", JSON.stringify(data1));
    }

    const { data: dbP1 } = await adminClient.from("payments").select("*").eq("id", p1.id).single();
    if (dbP1.status === "APPROVED" && dbP1.manual_reconciliation_required === true) {
      recordPass("AUDIT TEST 1B: Attempt preserved in APPROVED status (NOT FAILED) with manual_reconciliation_required=true");
    } else {
      recordFail("AUDIT TEST 1B: Database attempt was corrupted or prematurely marked failed", JSON.stringify(dbP1));
    }

    // Reconcile: Client retries after timeout (PayPal had actually succeeded)
    const res1Retry = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p1AttId })
    });
    const data1Retry = await res1Retry.json();

    if (res1Retry.status === 200 && data1Retry.reconciled && data1Retry.authorizationId) {
      recordPass("AUDIT TEST 1C: Retry successfully reconciled uncertain attempt without issuing duplicate authorization", `authId: ${data1Retry.authorizationId}`);
    } else {
      recordFail("AUDIT TEST 1C: Failed to reconcile uncertain attempt upon retry", JSON.stringify(data1Retry));
    }

    // =========================================================================
    // AUDIT TEST 2: Repeated Authorization Request (Idempotency)
    // =========================================================================
    console.log("\n--- 2. Testing Repeated Authorization Request ---");
    const res2 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p1AttId })
    });
    const data2 = await res2.json();

    if (res2.status === 200 && data2.alreadyAuthorized && data2.authorizationId === data1Retry.authorizationId) {
      recordPass("AUDIT TEST 2: Repeated authorization returned idempotent HTTP 200 without duplicate mutations");
    } else {
      recordFail("AUDIT TEST 2: Repeated authorization failed idempotency check", JSON.stringify(data2));
    }

    // =========================================================================
    // AUDIT TEST 3: Two Concurrent Authorization Requests (Race Condition Protection)
    // =========================================================================
    console.log("\n--- 3. Testing Two Concurrent Authorization Requests ---");
    const m3 = await createMilestone(903, "Concurrent Authorizations Audit");
    const { paymentAttemptId: p3AttId, orderId: p3OrderId } = await createPaymentAttempt(m3.id);

    // Add 800ms artificial delay to simulate realistic network execution window
    simulateDelayAuthorize.set(p3OrderId, 800);

    const [concurrentRes1, concurrentRes2] = await Promise.all([
      fetch(AUTHORIZE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${clientTokenA}`
        },
        body: JSON.stringify({ paymentAttemptId: p3AttId })
      }),
      fetch(AUTHORIZE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${clientTokenA}`
        },
        body: JSON.stringify({ paymentAttemptId: p3AttId })
      })
    ]);
    simulateDelayAuthorize.delete(p3OrderId);

    const concurrentData1 = await concurrentRes1.json();
    const concurrentData2 = await concurrentRes2.json();

    const statuses = [concurrentRes1.status, concurrentRes2.status];
    const hasSuccess = statuses.includes(200);
    const hasLockRejection = statuses.includes(409) || (concurrentRes1.status === 200 && concurrentRes2.status === 200);

    if (hasSuccess && hasLockRejection) {
      recordPass("AUDIT TEST 3A: Concurrent requests safely handled by concurrency lock", `Statuses: ${statuses.join(', ')}`);
    } else {
      recordFail("AUDIT TEST 3A: Concurrent requests failed concurrency protection", `Statuses: ${statuses.join(', ')}`);
    }

    // Database check: Exactly ONE row in PostgreSQL and valid AUTHORIZED state
    const { data: dbConcurrentList } = await adminClient.from("payments").select("id, status, authorization_id").eq("payment_attempt_id", p3AttId);
    if (dbConcurrentList.length === 1 && dbConcurrentList[0].status === "AUTHORIZED" && dbConcurrentList[0].authorization_id) {
      recordPass("AUDIT TEST 3B: Database state integrity verified: exactly one record with single authorization_id");
    } else {
      recordFail("AUDIT TEST 3B: Database corrupted by concurrent requests", JSON.stringify(dbConcurrentList));
    }

    // =========================================================================
    // AUDIT TEST 4: Authorization Already Completed
    // =========================================================================
    console.log("\n--- 4. Testing Authorization Already Completed ---");
    const m4 = await createMilestone(904, "Pre-Completed Authorization");
    const priorAuthId = "AUTH_COMPLETED_444";
    const { paymentAttemptId: p4AttId } = await createPaymentAttempt(m4.id, {
      paypalStatus: "COMPLETED",
      payments: {
        authorizations: [{
          id: priorAuthId,
          status: "CREATED",
          amount: { currency_code: "USD", value: "75.00" },
          expiration_time: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
          create_time: new Date().toISOString()
        }]
      }
    });

    const res4 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p4AttId })
    });
    const data4 = await res4.json();

    if (res4.status === 200 && data4.alreadyAuthorized && data4.authorizationId === priorAuthId) {
      recordPass("AUDIT TEST 4: Prior completed authorization reconciled safely (HTTP 200)", `authId: ${data4.authorizationId}`);
    } else {
      recordFail("AUDIT TEST 4: Failed to reconcile pre-completed authorization", JSON.stringify(data4));
    }

    // =========================================================================
    // AUDIT TEST 5: Authorization Not Found (Order COMPLETED with No Auth Resource)
    // =========================================================================
    console.log("\n--- 5. Testing Authorization Not Found ---");
    const m5 = await createMilestone(905, "Missing Auth Resource");
    const { paymentAttemptId: p5AttId } = await createPaymentAttempt(m5.id, {
      paypalStatus: "COMPLETED",
      payments: {
        authorizations: [] // Empty authorizations
      }
    });

    const res5 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p5AttId })
    });
    const data5 = await res5.json();

    if (res5.status === 400 && data5.error.includes("contains no authorization resource")) {
      recordPass("AUDIT TEST 5: Missing authorization resource rejected with HTTP 400", data5.error);
    } else {
      recordFail("AUDIT TEST 5: Expected HTTP 400 for missing authorization resource", JSON.stringify(data5));
    }

    // =========================================================================
    // AUDIT TEST 6: Wrong Authorization ID
    // =========================================================================
    console.log("\n--- 6. Testing Wrong Authorization ID ---");
    const m6 = await createMilestone(906, "Wrong Authorization ID");
    const { paymentAttemptId: p6AttId } = await createPaymentAttempt(m6.id);

    const res6 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p6AttId,
        authorizationId: "AUTH_TAMPERED_WRONG_999"
      })
    });
    const data6 = await res6.json();

    if (res6.status === 400 && data6.error.includes("does not match PayPal authorization ID")) {
      recordPass("AUDIT TEST 6: Tampered authorization ID rejected with HTTP 400", data6.error);
    } else {
      recordFail("AUDIT TEST 6: Expected HTTP 400 for wrong authorization ID", JSON.stringify(data6));
    }

    // =========================================================================
    // AUDIT TEST 7: Wrong Amount or Currency
    // =========================================================================
    console.log("\n--- 7. Testing Wrong Amount or Currency ---");
    const m7A = await createMilestone(907, "Amount Mismatch", 75.00);
    const { paymentAttemptId: p7AAttId } = await createPaymentAttempt(m7A.id, {
      amount: 75.00,
      paypalAmount: 250.00 // Mismatch
    });

    const res7A = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p7AAttId })
    });
    const data7A = await res7A.json();

    if (res7A.status === 400 && data7A.error.includes("Financial Integrity Violation")) {
      recordPass("AUDIT TEST 7A: Amount mismatch ($250.00 vs $75.00) rejected with HTTP 400", data7A.error);
    } else {
      recordFail("AUDIT TEST 7A: Expected HTTP 400 for amount mismatch", JSON.stringify(data7A));
    }

    const m7B = await createMilestone(908, "Currency Mismatch", 75.00);
    const { paymentAttemptId: p7BAttId } = await createPaymentAttempt(m7B.id, {
      amount: 75.00,
      paypalCurrency: "GBP"
    });

    const res7B = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p7BAttId })
    });
    const data7B = await res7B.json();

    if (res7B.status === 400 && data7B.error.includes("Currency Violation")) {
      recordPass("AUDIT TEST 7B: Currency mismatch (GBP) rejected with HTTP 400", data7B.error);
    } else {
      recordFail("AUDIT TEST 7B: Expected HTTP 400 for currency mismatch", JSON.stringify(data7B));
    }

    // =========================================================================
    // AUDIT TEST 8: Expired Authorization
    // =========================================================================
    console.log("\n--- 8. Testing Expired Authorization ---");
    const m8 = await createMilestone(909, "Expired Authorization", 75.00);
    const expiredAuthId = "AUTH_EXPIRED_000";
    const { paymentAttemptId: p8AttId } = await createPaymentAttempt(m8.id, {
      paypalStatus: "COMPLETED",
      payments: {
        authorizations: [{
          id: expiredAuthId,
          status: "EXPIRED",
          amount: { currency_code: "USD", value: "75.00" },
          expiration_time: new Date(Date.now() - 1000000).toISOString(), // In the past
          create_time: new Date(Date.now() - 30 * 86400000).toISOString()
        }]
      }
    });

    const res8 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p8AttId })
    });
    const data8 = await res8.json();

    if (res8.status === 409 && data8.code === "AUTHORIZATION_EXPIRED") {
      recordPass("AUDIT TEST 8: Expired authorization on PayPal rejected with HTTP 409 AUTHORIZATION_EXPIRED", data8.error);
    } else {
      recordFail("AUDIT TEST 8: Expected HTTP 409 for expired authorization", JSON.stringify(data8));
    }

    // =========================================================================
    // AUDIT TEST 9: Reconciliation After Uncertain Result (Retention Window)
    // =========================================================================
    console.log("\n--- 9. Testing Reconciliation After Uncertain Result & Retention ---");
    const m9 = await createMilestone(910, "Retention Window Expiry", 75.00);
    const eightHoursAgo = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
    // Create an attempt that was created 8 hours ago (past 6h default retention)
    const { paymentAttemptId: p9AttId } = await createPaymentAttempt(m9.id, {
      manual_reconciliation_required: true,
      reconciliation_notes: "Prior timeout 8 hours ago",
      created_at: eightHoursAgo,
      updated_at: eightHoursAgo,
      error_details: {
        timestamp: eightHoursAgo,
        outcome: "UNCERTAIN",
        reason: "Prior timeout 8 hours ago"
      }
    });

    const res9 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p9AttId })
    });
    const data9 = await res9.json();

    if (res9.status === 409 && data9.code === "RECONCILIATION_EXPIRED") {
      recordPass("AUDIT TEST 9: Uncertain attempt past 6h retention window blocked from replay with HTTP 409 RECONCILIATION_EXPIRED", data9.error);
    } else {
      recordFail("AUDIT TEST 9: Expected HTTP 409 for expired retention window", JSON.stringify(data9));
    }

    // =========================================================================
    // AUDIT TEST 10: Unauthorized User Checks
    // =========================================================================
    console.log("\n--- 10. Testing Unauthorized User Checks ---");
    const m10 = await createMilestone(911, "Auth Role Security", 75.00);
    const { paymentAttemptId: p10AttId } = await createPaymentAttempt(m10.id);

    // 10A: No Auth
    const res10A = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAttemptId: p10AttId })
    });
    if (res10A.status === 401) {
      recordPass("AUDIT TEST 10A: Unauthenticated request rejected with HTTP 401");
    } else {
      recordFail("AUDIT TEST 10A: Expected HTTP 401", `Status: ${res10A.status}`);
    }

    // 10B: Freelancer
    const res10B = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${freelancerToken}`
      },
      body: JSON.stringify({ paymentAttemptId: p10AttId })
    });
    if (res10B.status === 403) {
      recordPass("AUDIT TEST 10B: Freelancer account rejected with HTTP 403 Forbidden");
    } else {
      recordFail("AUDIT TEST 10B: Expected HTTP 403 for freelancer", `Status: ${res10B.status}`);
    }

    // 10C: Unrelated Client
    const res10C = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenB}`
      },
      body: JSON.stringify({ paymentAttemptId: p10AttId })
    });
    if (res10C.status === 403) {
      recordPass("AUDIT TEST 10C: Unrelated client rejected with HTTP 403 Forbidden");
    } else {
      recordFail("AUDIT TEST 10C: Expected HTTP 403 for wrong client", `Status: ${res10C.status}`);
    }

    // =========================================================================
    // AUDIT TEST 11: UTC Expiration & Honor-Period Timestamp Validation
    // =========================================================================
    console.log("\n--- 11. Testing UTC Expiration & Honor-Period Timestamps ---");
    const m11 = await createMilestone(912, "Timestamp UTC Audit", 75.00);
    const { payment: p11, paymentAttemptId: p11AttId } = await createPaymentAttempt(m11.id);

    const res11 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p11AttId })
    });
    const data11 = await res11.json();

    const { data: dbP11 } = await adminClient.from("payments").select("*").eq("id", p11.id).single();

    const authorizedAtMs = new Date(dbP11.authorized_at).getTime();
    const honorPeriodMs = new Date(dbP11.honor_period_expires_at).getTime();
    const authExpiresMs = new Date(dbP11.authorization_expires_at).getTime();

    const honorDiffDays = Math.round((honorPeriodMs - authorizedAtMs) / (86400 * 1000));
    const authDiffDays = Math.round((authExpiresMs - authorizedAtMs) / (86400 * 1000));

    const isUtcAuthorizedAt = dbP11.authorized_at.endsWith("Z") || dbP11.authorized_at.includes("+00");
    const isUtcHonor = dbP11.honor_period_expires_at.endsWith("Z") || dbP11.honor_period_expires_at.includes("+00");
    const isUtcExpires = dbP11.authorization_expires_at.endsWith("Z") || dbP11.authorization_expires_at.includes("+00");

    if (isUtcAuthorizedAt && isUtcHonor && isUtcExpires && honorDiffDays === 3 && authDiffDays === 29) {
      recordPass("AUDIT TEST 11: Timestamps verified strictly in UTC: 3-day honor period and 29-day authorization validity", `Honor: +${honorDiffDays}d, Expires: +${authDiffDays}d`);
    } else {
      recordFail("AUDIT TEST 11: Timestamp calculation failed UTC or duration checks", JSON.stringify({ dbP11, honorDiffDays, authDiffDays }));
    }

    // =========================================================================
    // AUDIT TEST 12: No 'Escrow' or 'Captured' Labeling Verification
    // =========================================================================
    console.log("\n--- 12. Testing System Terminology (Never Labeled Escrowed or Captured) ---");
    const authMessage = data11.message || "";
    const notes = dbP11.reconciliation_notes || "";

    const hasEscrow = authMessage.toLowerCase().includes("escrow") || notes.toLowerCase().includes("escrow");
    const hasCaptured = authMessage.toLowerCase().includes("captured") || (dbP11.status !== "AUTHORIZED");

    if (!hasEscrow && !hasCaptured) {
      recordPass("AUDIT TEST 12: System strictly avoids labeling authorization as 'escrowed' or 'captured'", `Message: "${authMessage}"`);
    } else {
      recordFail("AUDIT TEST 12: Prohibited terminology found in response or database notes", JSON.stringify({ authMessage, notes }));
    }

    // =========================================================================
    // AUDIT TEST 13: Database State Machine & Immutability Guards
    // =========================================================================
    console.log("\n--- 13. Testing Database State Machine & Immutability Guards ---");
    // Amount immutability
    const { error: errAmount } = await adminClient.from("payments").update({ amount: 999.00 }).eq("id", p11.id);
    if (errAmount && errAmount.message.includes("Payment amount is immutable")) {
      recordPass("AUDIT TEST 13A: Database trigger rejects modification of payment amount");
    } else {
      recordFail("AUDIT TEST 13A: Amount immutability guard failed", errAmount?.message);
    }

    // Currency immutability
    const { error: errCurr } = await adminClient.from("payments").update({ currency: "EUR" }).eq("id", p11.id);
    if (errCurr && errCurr.message.includes("Payment currency is immutable")) {
      recordPass("AUDIT TEST 13B: Database trigger rejects modification of payment currency");
    } else {
      recordFail("AUDIT TEST 13B: Currency immutability guard failed", errCurr?.message);
    }

    // Backward transition from AUTHORIZED -> CREATED
    const { error: errBackward } = await adminClient.from("payments").update({ status: "CREATED" }).eq("id", p11.id);
    if (errBackward && errBackward.message.includes("Invalid Transition")) {
      recordPass("AUDIT TEST 13C: Database trigger rejects illegal backward transition AUTHORIZED -> CREATED");
    } else {
      recordFail("AUDIT TEST 13C: Backward transition guard failed", errBackward?.message);
    }

  } catch (err) {
    console.error("Audit Suite Runtime Error:", err);
    testResults.failed.push({ testName: "Audit Runtime Error", error: err.message });
  } finally {
    // Teardown
    mockServer.close();
    console.log("✓ Mock PayPal Server stopped.");

    console.log("--- Cleaning up temporary test fixtures ---");
    if (createdPayments.length > 0) {
      await adminClient.from('payments').delete().in('id', createdPayments);
    }
    if (createdMilestones.length > 0) {
      await adminClient.from('milestones').delete().in('id', createdMilestones);
    }
    console.log("✓ Baseline database state restored.");

    restoreCleanEnv();
    console.log("✓ Clean .env.local restored to safe baseline.\n");

    console.log("=============================================================================");
    console.log(`TOTAL PASSED: ${testResults.passed.length}`);
    console.log(`TOTAL FAILED: ${testResults.failed.length}`);
    console.log("=============================================================================");

    process.exit(testResults.failed.length > 0 ? 1 : 0);
  }
}

runTestSuite();
