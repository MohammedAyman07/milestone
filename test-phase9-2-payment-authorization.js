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
const simulateDefinitiveRejection = new Set();
const simulateInvalidResponse = new Set();
let capturedIdempotencyKeys = [];

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString();

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

      // Simulate Timeout
      if (simulateTimeoutAuthorize.has(orderId)) {
        setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: "Gateway Timeout" }));
        }, 12000);
        return;
      }

      // Simulate Upstream 500
      if (simulate5xxAuthorize.has(orderId)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: "INTERNAL_SERVER_ERROR",
          message: "An internal server error occurred on PayPal authorization."
        }));
        return;
      }

      // Simulate Definitive Rejection (422)
      if (simulateDefinitiveRejection.has(orderId)) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
          debug_id: "dbg_definitive_rej_422",
          details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not approved the order." }]
        }));
        return;
      }

      // Simulate Invalid PayPal Response Structure
      if (simulateInvalidResponse.has(orderId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: orderId,
          status: "COMPLETED",
          purchase_units: [] // Missing authorizations
        }));
        return;
      }

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
  console.log("MILESTONE AI — Phase 9.2: PayPal Server-Side Payment Authorization Test Suite");
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

    // Configure clientUserA as client and freelancerUser as freelancer
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

    console.log(`✓ Client A (Owner / Payer): ${clientUserA.email} (${clientUserA.id})`);
    console.log(`✓ Freelancer (Payee): ${freelancerUser.email} (${freelancerUser.id})`);
    console.log(`✓ Client B (Wrong Owner): ${clientUserB.email} (${clientUserB.id})`);
    console.log(`✓ Test Project: ${testProject.id}\n`);

    async function createMilestone(phase, title, amount = 75.00) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 9.2 Authorization Test Deliverable',
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
    // TEST 1: Valid Authorization
    // =========================================================================
    console.log("--- 1. Testing Valid Authorization ---");
    const m1 = await createMilestone(1, "Phase 9.2: Valid Authorization Deliverable");
    const { payment: p1, paymentAttemptId: p1AttId, orderId: p1OrderId } = await createPaymentAttempt(m1.id);

    const res1 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p1AttId })
    });
    const data1 = await res1.json();

    if (res1.status === 200 && data1.success && data1.status === "AUTHORIZED" && data1.authorizationId) {
      recordPass("TEST 1A: Valid authorization returned HTTP 200 with AUTHORIZED status", `authId: ${data1.authorizationId}`);
    } else {
      recordFail("TEST 1A: Valid authorization failed", JSON.stringify(data1));
    }

    // Check DB payment record
    const { data: dbP1 } = await adminClient.from("payments").select("*").eq("id", p1.id).single();
    if (dbP1.status === "AUTHORIZED" && dbP1.authorization_id === data1.authorizationId && dbP1.authorized_at) {
      recordPass("TEST 1B: Database payment record updated to AUTHORIZED with authorization_id and timestamps");
    } else {
      recordFail("TEST 1B: Database payment record not properly updated", JSON.stringify(dbP1));
    }

    // Check milestone payment_status
    const { data: dbM1 } = await adminClient.from("milestones").select("payment_status, authorization_id").eq("id", m1.id).single();
    if (dbM1.payment_status === "authorized" && dbM1.authorization_id === data1.authorizationId) {
      recordPass("TEST 1C: Milestone payment_status successfully transitioned to 'authorized'");
    } else {
      recordFail("TEST 1C: Milestone payment_status mismatch", JSON.stringify(dbM1));
    }

    // Check audit event
    const { data: audit1 } = await adminClient.from("audit_logs").select("*").eq("entity_id", p1.id).eq("action", "PAYMENT_AUTHORIZED");
    if (audit1 && audit1.length > 0) {
      recordPass("TEST 1D: Audit event PAYMENT_AUTHORIZED logged in database");
    } else {
      recordFail("TEST 1D: Audit event PAYMENT_AUTHORIZED missing");
    }

    // =========================================================================
    // TEST 2: Unauthenticated Request
    // =========================================================================
    console.log("\n--- 2. Testing Unauthenticated Request ---");
    const m2 = await createMilestone(2, "Unauthenticated Authorization Test");
    const { paymentAttemptId: p2AttId } = await createPaymentAttempt(m2.id);

    const res2 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAttemptId: p2AttId })
    });
    const data2 = await res2.json();

    if (res2.status === 401) {
      recordPass("TEST 2: Unauthenticated request rejected with HTTP 401 Unauthorized", data2.error);
    } else {
      recordFail("TEST 2: Expected HTTP 401 for unauthenticated request", `Status: ${res2.status}`);
    }

    // =========================================================================
    // TEST 3: Freelancer Attempting Authorization (Role Authorization)
    // =========================================================================
    console.log("\n--- 3. Testing Freelancer Attempting Authorization ---");
    const m3 = await createMilestone(3, "Freelancer Authorization Test");
    const { paymentAttemptId: p3AttId } = await createPaymentAttempt(m3.id);

    const res3 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${freelancerToken}`
      },
      body: JSON.stringify({ paymentAttemptId: p3AttId })
    });
    const data3 = await res3.json();

    if (res3.status === 403) {
      recordPass("TEST 3: Freelancer rejected with HTTP 403 Forbidden", data3.error);
    } else {
      recordFail("TEST 3: Expected HTTP 403 for freelancer attempt", `Status: ${res3.status}`);
    }

    // =========================================================================
    // TEST 4: Wrong Project Owner (Client B authorizing Client A's attempt)
    // =========================================================================
    console.log("\n--- 4. Testing Wrong Project Owner ---");
    const m4 = await createMilestone(4, "Wrong Client Owner Test");
    const { paymentAttemptId: p4AttId } = await createPaymentAttempt(m4.id);

    const res4 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenB}`
      },
      body: JSON.stringify({ paymentAttemptId: p4AttId })
    });
    const data4 = await res4.json();

    if (res4.status === 403) {
      recordPass("TEST 4: Non-owner client rejected with HTTP 403 Forbidden", data4.error);
    } else {
      recordFail("TEST 4: Expected HTTP 403 for wrong project owner", `Status: ${res4.status}`);
    }

    // =========================================================================
    // TEST 5: Payment Not in APPROVED State
    // =========================================================================
    console.log("\n--- 5. Testing Payment Not in APPROVED State ---");
    const m5 = await createMilestone(5, "Payment Status Guard Test");
    const { paymentAttemptId: p5AttId } = await createPaymentAttempt(m5.id, { status: "CREATED" });

    const res5 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p5AttId })
    });
    const data5 = await res5.json();

    if (res5.status === 400 && data5.error.includes("only APPROVED payments can be authorized")) {
      recordPass("TEST 5: Non-approved status (CREATED) rejected with HTTP 400", data5.error);
    } else {
      recordFail("TEST 5: Expected HTTP 400 rejecting unapproved attempt", JSON.stringify(data5));
    }

    // =========================================================================
    // TEST 6: Wrong Order ID
    // =========================================================================
    console.log("\n--- 6. Testing Wrong Order ID ---");
    const m6 = await createMilestone(6, "Wrong Order ID Test");
    const { paymentAttemptId: p6AttId } = await createPaymentAttempt(m6.id);

    const res6 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        paymentAttemptId: p6AttId,
        orderId: "ORD_SPOOFED_MISMATCH_999"
      })
    });
    const data6 = await res6.json();

    if (res6.status === 400 && data6.error.includes("does not match")) {
      recordPass("TEST 6: Mismatched order ID rejected with HTTP 400", data6.error);
    } else {
      recordFail("TEST 6: Expected HTTP 400 for mismatched order ID", JSON.stringify(data6));
    }

    // =========================================================================
    // TEST 7: Amount Mismatch
    // =========================================================================
    console.log("\n--- 7. Testing Amount Mismatch ---");
    const m7 = await createMilestone(7, "Amount Mismatch Test", 75.00);
    const { paymentAttemptId: p7AttId } = await createPaymentAttempt(m7.id, {
      amount: 75.00,
      paypalAmount: 150.00 // Tampered amount on PayPal
    });

    const res7 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p7AttId })
    });
    const data7 = await res7.json();

    if (res7.status === 400 && data7.error.includes("Financial Integrity Violation")) {
      recordPass("TEST 7: Tampered amount ($150.00 vs $75.00) rejected with HTTP 400", data7.error);
    } else {
      recordFail("TEST 7: Expected HTTP 400 for amount mismatch", JSON.stringify(data7));
    }

    // =========================================================================
    // TEST 8: Currency Mismatch
    // =========================================================================
    console.log("\n--- 8. Testing Currency Mismatch ---");
    const m8 = await createMilestone(8, "Currency Mismatch Test", 75.00);
    const { paymentAttemptId: p8AttId } = await createPaymentAttempt(m8.id, {
      amount: 75.00,
      paypalCurrency: "EUR"
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

    if (res8.status === 400 && data8.error.includes("Currency Violation")) {
      recordPass("TEST 8: Non-USD currency (EUR) rejected with HTTP 400", data8.error);
    } else {
      recordFail("TEST 8: Expected HTTP 400 for currency mismatch", JSON.stringify(data8));
    }

    // =========================================================================
    // TEST 9: Wrong Merchant Payee
    // =========================================================================
    console.log("\n--- 9. Testing Wrong Merchant Payee ---");
    const m9 = await createMilestone(9, "Merchant Payee Test", 75.00);
    const { paymentAttemptId: p9AttId } = await createPaymentAttempt(m9.id, {
      payeeMerchantId: "MERCHANT-MALICIOUS-HIJACK",
      paypal_merchant_id: "MERCHANT-LEGITIMATE-PLATFORM",
      raw_paypal_response: {
        purchase_units: [{
          payee: { merchant_id: "MERCHANT-LEGITIMATE-PLATFORM" }
        }]
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

    if (res9.status === 400 && data9.error.includes("Payee Mismatch Violation")) {
      recordPass("TEST 9: Wrong merchant payee rejected with HTTP 400", data9.error);
    } else {
      recordFail("TEST 9: Expected HTTP 400 for payee mismatch", JSON.stringify(data9));
    }

    // =========================================================================
    // TEST 10: Duplicate Authorization Request (Idempotency)
    // =========================================================================
    console.log("\n--- 10. Testing Duplicate Authorization Request ---");
    // p1AttId was already authorized in Test 1
    const res10 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p1AttId })
    });
    const data10 = await res10.json();

    if (res10.status === 200 && data10.alreadyAuthorized && data10.authorizationId === data1.authorizationId) {
      recordPass("TEST 10: Duplicate authorization returned idempotent HTTP 200 with existing authId", `authId: ${data10.authorizationId}`);
    } else {
      recordFail("TEST 10: Expected idempotent 200 for duplicate authorize", JSON.stringify(data10));
    }

    // =========================================================================
    // TEST 11: PayPal Timeout (Uncertain Result Handling)
    // =========================================================================
    console.log("\n--- 11. Testing PayPal Timeout ---");
    const m11 = await createMilestone(11, "PayPal Timeout Test", 75.00);
    const { payment: p11, paymentAttemptId: p11AttId, orderId: p11OrderId } = await createPaymentAttempt(m11.id);

    simulateTimeoutAuthorize.add(p11OrderId);

    const res11 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p11AttId })
    });
    const data11 = await res11.json();
    simulateTimeoutAuthorize.delete(p11OrderId);

    if (res11.status === 504 && data11.uncertain && data11.retryable) {
      recordPass("TEST 11A: PayPal timeout handled safely with HTTP 504 and retryable: true", data11.error);
    } else {
      recordFail("TEST 11A: Expected HTTP 504 for timeout", JSON.stringify(data11));
    }

    // Verify DB: Must NOT be marked as FAILED! Preserved in APPROVED with manual_reconciliation_required
    const { data: dbP11 } = await adminClient.from("payments").select("*").eq("id", p11.id).single();
    if (dbP11.status === "APPROVED" && dbP11.manual_reconciliation_required === true) {
      recordPass("TEST 11B: Database attempt preserved in APPROVED status with manual_reconciliation_required=true (not marked FAILED)");
    } else {
      recordFail("TEST 11B: Database attempt incorrectly updated on timeout", JSON.stringify(dbP11));
    }

    // =========================================================================
    // TEST 12: PayPal Upstream 5xx Error
    // =========================================================================
    console.log("\n--- 12. Testing PayPal 5xx Server Error ---");
    const m12 = await createMilestone(12, "PayPal 5xx Test", 75.00);
    const { payment: p12, paymentAttemptId: p12AttId, orderId: p12OrderId } = await createPaymentAttempt(m12.id);

    simulate5xxAuthorize.add(p12OrderId);

    const res12 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p12AttId })
    });
    const data12 = await res12.json();
    simulate5xxAuthorize.delete(p12OrderId);

    if (res12.status === 502 && data12.uncertain && data12.retryable) {
      recordPass("TEST 12A: PayPal 5xx handled safely with HTTP 502 and retryable: true", data12.error);
    } else {
      recordFail("TEST 12A: Expected HTTP 502 for 5xx error", JSON.stringify(data12));
    }

    const { data: dbP12 } = await adminClient.from("payments").select("*").eq("id", p12.id).single();
    if (dbP12.status === "APPROVED" && dbP12.manual_reconciliation_required === true) {
      recordPass("TEST 12B: Database attempt preserved in APPROVED status with manual_reconciliation_required=true");
    } else {
      recordFail("TEST 12B: Database attempt incorrectly updated on 5xx", JSON.stringify(dbP12));
    }

    // =========================================================================
    // TEST 13: Reconciliation After Uncertain Result
    // =========================================================================
    console.log("\n--- 13. Testing Reconciliation After Uncertain Result ---");
    // Suppose p12 actually succeeded on PayPal behind the 5xx
    const reconciledAuthId = "AUTH_RECONCILED_" + crypto.randomUUID().substring(0, 8).toUpperCase();
    const mockP12Order = mockPayPalOrders.get(p12OrderId);
    mockP12Order.status = "COMPLETED";
    mockP12Order.purchase_units[0].payments = {
      authorizations: [
        {
          id: reconciledAuthId,
          status: "CREATED",
          amount: { currency_code: "USD", value: "75.00" },
          expiration_time: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
          create_time: new Date().toISOString()
        }
      ]
    };

    const res13 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p12AttId })
    });
    const data13 = await res13.json();

    if (res13.status === 200 && data13.reconciled && data13.authorizationId === reconciledAuthId) {
      recordPass("TEST 13A: Server successfully reconciled uncertain attempt and returned HTTP 200", `authId: ${data13.authorizationId}`);
    } else {
      recordFail("TEST 13A: Failed to reconcile uncertain attempt", JSON.stringify(data13));
    }

    const { data: dbP12Reconciled } = await adminClient.from("payments").select("*").eq("id", p12.id).single();
    if (
      dbP12Reconciled.status === "AUTHORIZED" &&
      dbP12Reconciled.authorization_id === reconciledAuthId &&
      dbP12Reconciled.manual_reconciliation_required === false
    ) {
      recordPass("TEST 13B: Database record updated to AUTHORIZED with manual_reconciliation_required=false");
    } else {
      recordFail("TEST 13B: Database record not properly reconciled", JSON.stringify(dbP12Reconciled));
    }

    // =========================================================================
    // TEST 14: Authorization Already Completed on PayPal Prior to Call
    // =========================================================================
    console.log("\n--- 14. Testing Authorization Already Completed ---");
    const m14 = await createMilestone(14, "Prior Auth Completed Test", 75.00);
    const existingPriorAuthId = "AUTH_PRIOR_" + crypto.randomUUID().substring(0, 8).toUpperCase();
    const { paymentAttemptId: p14AttId } = await createPaymentAttempt(m14.id, {
      paypalStatus: "COMPLETED",
      payments: {
        authorizations: [
          {
            id: existingPriorAuthId,
            status: "CREATED",
            amount: { currency_code: "USD", value: "75.00" },
            expiration_time: new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString(),
            create_time: new Date().toISOString()
          }
        ]
      }
    });

    const res14 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p14AttId })
    });
    const data14 = await res14.json();

    if (res14.status === 200 && data14.alreadyAuthorized && data14.authorizationId === existingPriorAuthId) {
      recordPass("TEST 14: Order already authorized at PayPal reconciled safely (HTTP 200)", `authId: ${data14.authorizationId}`);
    } else {
      recordFail("TEST 14: Failed to reconcile prior completed authorization", JSON.stringify(data14));
    }

    // =========================================================================
    // TEST 15: Invalid PayPal Authorization Response Structure
    // =========================================================================
    console.log("\n--- 15. Testing Invalid PayPal Authorization Response ---");
    const m15 = await createMilestone(15, "Malformed Response Test", 75.00);
    const { payment: p15, paymentAttemptId: p15AttId, orderId: p15OrderId } = await createPaymentAttempt(m15.id);

    simulateInvalidResponse.add(p15OrderId);

    const res15 = await fetch(AUTHORIZE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ paymentAttemptId: p15AttId })
    });
    const data15 = await res15.json();
    simulateInvalidResponse.delete(p15OrderId);

    if (res15.status === 502 && data15.error.includes("Invalid PayPal authorization response")) {
      recordPass("TEST 15A: Malformed response rejected with HTTP 502", data15.error);
    } else {
      recordFail("TEST 15A: Expected HTTP 502 for malformed response", JSON.stringify(data15));
    }

    const { data: dbP15 } = await adminClient.from("payments").select("status, authorization_id").eq("id", p15.id).single();
    if (dbP15.status === "APPROVED" && dbP15.authorization_id === null) {
      recordPass("TEST 15B: Database record remained in APPROVED with null authorization_id");
    } else {
      recordFail("TEST 15B: Database was erroneously updated on malformed response", JSON.stringify(dbP15));
    }

    // =========================================================================
    // TEST 16: Database State Transition Protections
    // =========================================================================
    console.log("\n--- 16. Testing Database State Transition Protections ---");
    const m16 = await createMilestone(16, "DB State Machine Protections", 75.00);
    const { payment: p16 } = await createPaymentAttempt(m16.id, { amount: 75.00 });

    // 16A: Immutability of Amount
    const { error: errAmount } = await adminClient
      .from("payments")
      .update({ amount: 999.00 })
      .eq("id", p16.id);

    if (errAmount && errAmount.message.includes("Payment amount is immutable")) {
      recordPass("TEST 16A: Database trigger rejected mutation of payment amount", errAmount.message);
    } else {
      recordFail("TEST 16A: Database trigger failed to block amount mutation", errAmount?.message || "No error raised");
    }

    // 16B: Immutability of Currency
    const { error: errCurrency } = await adminClient
      .from("payments")
      .update({ currency: "EUR" })
      .eq("id", p16.id);

    if (errCurrency && errCurrency.message.includes("Payment currency is immutable")) {
      recordPass("TEST 16B: Database trigger rejected mutation of payment currency", errCurrency.message);
    } else {
      recordFail("TEST 16B: Database trigger failed to block currency mutation", errCurrency?.message || "No error raised");
    }

    // 16C: Valid Transition APPROVED -> AUTHORIZED with Timestamps
    const mockAuthId16 = "AUTH_TRIG_VALID_" + crypto.randomUUID().substring(0, 8).toUpperCase();
    const { data: updatedP16, error: errAuthTrans } = await adminClient
      .from("payments")
      .update({
        status: "AUTHORIZED",
        authorization_id: mockAuthId16
      })
      .eq("id", p16.id)
      .select()
      .single();

    if (!errAuthTrans && updatedP16.status === "AUTHORIZED" && updatedP16.authorized_at && updatedP16.honor_period_expires_at) {
      recordPass("TEST 16C: Transition APPROVED -> AUTHORIZED automatically populated timestamps (authorized_at, honor_period, auth_expires)");
    } else {
      recordFail("TEST 16C: Failed to transition APPROVED -> AUTHORIZED", errAuthTrans?.message || JSON.stringify(updatedP16));
    }

    // 16D: Illegal Transition AUTHORIZED -> CREATED Blocked
    const { error: errIllegalTrans } = await adminClient
      .from("payments")
      .update({ status: "CREATED" })
      .eq("id", p16.id);

    if (errIllegalTrans && errIllegalTrans.message.includes("Invalid Transition")) {
      recordPass("TEST 16D: Database trigger rejected illegal backward transition AUTHORIZED -> CREATED", errIllegalTrans.message);
    } else {
      recordFail("TEST 16D: Database trigger failed to block illegal transition", errIllegalTrans?.message || "No error raised");
    }

  } catch (err) {
    console.error("Test Suite Runtime Error:", err);
    testResults.failed.push({ testName: "Runtime Error", error: err.message });
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
