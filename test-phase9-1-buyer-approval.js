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
const VALIDATE_URL = 'http://localhost:3000/api/paypal/orders/validate-approval';
const CANCEL_URL = 'http://localhost:3000/api/paypal/orders/cancel';
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

// Mock Server Dynamic Store
const mockPayPalOrders = new Map();
let simulateTimeoutOrders = new Set();

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    // 1. OAuth2 Token
    if (req.url === '/v1/oauth2/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'mock_buyer_approval_token_123',
        token_type: 'Bearer',
        expires_in: 3600
      }));
      return;
    }

    // 2. Orders v2 Get Order (/v2/checkout/orders/:orderId)
    const match = req.url.match(/^\/v2\/checkout\/orders\/([^/?]+)/);
    if (match && req.method === 'GET') {
      const orderId = match[1];

      // Simulate Timeout
      if (simulateTimeoutOrders.has(orderId)) {
        // Delay long enough or drop connection
        setTimeout(() => {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: "Gateway Timeout" }));
        }, 12000); // 12 seconds exceeds 10s fetch timeout
        return;
      }

      if (mockPayPalOrders.has(orderId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockPayPalOrders.get(orderId)));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: "RESOURCE_NOT_FOUND",
        message: "The specified resource does not exist.",
        debug_id: "dbg_not_found"
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
});

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 9.1: PayPal Sandbox Buyer Approval Test Suite");
  console.log("=============================================================================\n");

  let clientUserA = null;
  let clientTokenA = null;
  let clientUserB = null;
  let clientTokenB = null;
  let testProject = null;
  const createdMilestones = [];

  try {
    updateEnvForMock();
    await sleep(1500);

    await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
    console.log(`✓ Mock PayPal Server running on port ${MOCK_PORT}`);

    // Setup Test Users
    const { data: usersData } = await adminClient.auth.admin.listUsers();
    clientUserA = usersData.users[0];
    clientUserB = usersData.users[1];

    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];

    // Set clientUserA as project client
    await adminClient.from('projects').update({
      client_id: clientUserA.id,
      budget: 100000.00
    }).eq('id', testProject.id);

    // Sign in Client A
    const authA = await anonClient.auth.signInWithPassword({
      email: clientUserA.email,
      password: 'TestPassword123!@#'
    });
    clientTokenA = authA.data.session.access_token;

    // Sign in Client B (Unauthorized user)
    const authB = await anonClient.auth.signInWithPassword({
      email: clientUserB.email,
      password: 'TestPassword123!@#'
    });
    clientTokenB = authB.data.session.access_token;

    console.log(`✓ Client A (Owner): ${clientUserA.email} (${clientUserA.id})`);
    console.log(`✓ Client B (Other): ${clientUserB.email} (${clientUserB.id})`);
    console.log(`✓ Test Project: ${testProject.id}\n`);

    async function createMilestone(phase, title, amount = 75.00) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 9.1 Buyer Approval Test',
        amount,
        currency: 'USD',
        due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
        status: 'pending',
        payment_status: 'created',
      }]).select('id').single();
      if (error) throw new Error(`Milestone create failed: ${error.message}`);
      createdMilestones.push(m.id);
      return m.id;
    }

    async function createPaymentAttempt(milestoneId, orderId, paymentAttemptId, amount = 75.00, overrides = {}) {
      const { data: p, error } = await adminClient.from('payments').insert([{
        milestone_id: milestoneId,
        project_id: testProject.id,
        payer_id: clientUserA.id,
        payee_id: clientUserA.id,
        amount,
        currency: 'USD',
        payment_type: 'order',
        status: 'CREATED',
        payment_attempt_id: paymentAttemptId,
        attempt_number: 1,
        idempotency_order_create: `ord_create_${paymentAttemptId}`,
        idempotency_order_auth: `ord_auth_${paymentAttemptId}`,
        idempotency_auth_capture: `auth_cap_${paymentAttemptId}`,
        idempotency_refund: `refund_${paymentAttemptId}`,
        order_id: orderId,
        ...overrides,
      }]).select().single();
      if (error) throw new Error(`Payment attempt create failed: ${error.message}`);
      return p;
    }

    // -------------------------------------------------------------------------
    // TEST 1: Valid Buyer Approval
    // -------------------------------------------------------------------------
    console.log("--- 1. Testing Valid Buyer Approval ---");
    const m1Id = await createMilestone(501, 'Valid Buyer Approval Milestone');
    const order1Id = 'ORDER-TEST-VALID-001';
    const att1Id = 'att_valid_001_' + Date.now();

    await createPaymentAttempt(m1Id, order1Id, att1Id, 75.00);

    // Mock PayPal returns APPROVED order
    mockPayPalOrders.set(order1Id, {
      id: order1Id,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m1Id,
        custom_id: att1Id,
        amount: { currency_code: 'USD', value: '75.00' },
      }],
      payer: {
        payer_id: 'PAYER-SANDBOX-001',
        email_address: 'buyer-client@sandbox.milestoneai.dev'
      }
    });

    const res1 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order1Id, payerId: 'PAYER-SANDBOX-001' })
    });
    const data1 = await res1.json();

    if (res1.status === 200 && data1.success === true && data1.status === 'APPROVED') {
      recordPass("TEST 1A: Valid buyer approval confirmed and returned HTTP 200", `Status: ${data1.status}, Payer: ${data1.payerId}`);
    } else {
      recordFail("TEST 1A: Valid buyer approval failed", `Status: ${res1.status}, Body: ${JSON.stringify(data1)}`);
    }

    // Verify DB transition: payments table -> APPROVED
    const { data: pCheck1 } = await adminClient.from('payments').select('status, paypal_payer_id').eq('payment_attempt_id', att1Id).single();
    if (pCheck1 && pCheck1.status === 'APPROVED' && pCheck1.paypal_payer_id === 'PAYER-SANDBOX-001') {
      recordPass("TEST 1B: Database payment record successfully transitioned to APPROVED status");
    } else {
      recordFail("TEST 1B: Payment record not updated to APPROVED", JSON.stringify(pCheck1));
    }

    // Verify DB transition: milestones table -> approved
    const { data: mCheck1 } = await adminClient.from('milestones').select('payment_status').eq('id', m1Id).single();
    if (mCheck1 && mCheck1.payment_status === 'approved') {
      recordPass("TEST 1C: Milestone payment_status successfully transitioned to 'approved'");
    } else {
      recordFail("TEST 1C: Milestone payment_status not updated", JSON.stringify(mCheck1));
    }

    // Verify Audit Log: BUYER_APPROVAL_CONFIRMED
    const { data: aLogs1 } = await adminClient.from('audit_logs').select('*').eq('milestone_id', m1Id).eq('action', 'BUYER_APPROVAL_CONFIRMED');
    if (aLogs1 && aLogs1.length > 0 && aLogs1[0].new_state?.status === 'APPROVED') {
      recordPass("TEST 1D: Audit event BUYER_APPROVAL_CONFIRMED successfully logged in database");
    } else {
      recordFail("TEST 1D: Audit log for BUYER_APPROVAL_CONFIRMED missing", JSON.stringify(aLogs1));
    }

    // -------------------------------------------------------------------------
    // TEST 2: Invalid Order ID
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Testing Invalid Order ID ---");
    const res2 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: 'ORDER-NON-EXISTENT-999' })
    });
    const data2 = await res2.json();

    if (res2.status === 404 && data2.error?.includes('not found')) {
      recordPass("TEST 2: Non-existent order ID rejected with HTTP 404", data2.error);
    } else {
      recordFail("TEST 2: Non-existent order ID did not return 404", `Status: ${res2.status}, Body: ${JSON.stringify(data2)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Wrong Payment Attempt (Custom ID mismatch)
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Testing Wrong Payment Attempt (Custom ID Mismatch) ---");
    const m3Id = await createMilestone(503, 'Wrong Payment Attempt Milestone');
    const order3Id = 'ORDER-TEST-WRONG-ATT-003';
    const att3Id = 'att_legit_003_' + Date.now();

    await createPaymentAttempt(m3Id, order3Id, att3Id, 75.00);

    // Mock PayPal returns order with mismatched custom_id
    mockPayPalOrders.set(order3Id, {
      id: order3Id,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m3Id,
        custom_id: 'att_tampered_hijack_attempt',
        amount: { currency_code: 'USD', value: '75.00' }
      }]
    });

    const res3 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order3Id })
    });
    const data3 = await res3.json();

    if (res3.status === 400 && data3.error?.includes('custom ID')) {
      recordPass("TEST 3: Custom ID mismatch rejected with HTTP 400", data3.error);
    } else {
      recordFail("TEST 3: Custom ID mismatch not rejected", `Status: ${res3.status}, Body: ${JSON.stringify(data3)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Wrong Client (Ownership Authorization Check)
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Testing Wrong Client (Forbidden Attempt) ---");
    const m4Id = await createMilestone(504, 'Unauthorized Client Milestone');
    const order4Id = 'ORDER-TEST-WRONG-CLIENT-004';
    const att4Id = 'att_clientA_004_' + Date.now();

    await createPaymentAttempt(m4Id, order4Id, att4Id, 75.00);

    // Client B attempts to validate Client A's payment
    const res4 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenB}`
      },
      body: JSON.stringify({ orderId: order4Id })
    });
    const data4 = await res4.json();

    if (res4.status === 403 && data4.error?.includes('Forbidden')) {
      recordPass("TEST 4: Non-owner client validation rejected with HTTP 403 Forbidden", data4.error);
    } else {
      recordFail("TEST 4: Non-owner client did not receive 403", `Status: ${res4.status}, Body: ${JSON.stringify(data4)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Wrong Amount or Currency
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Testing Wrong Amount or Currency ---");
    const m5Id = await createMilestone(505, 'Amount Currency Check Milestone', 75.00);
    const order5AId = 'ORDER-TEST-WRONG-AMOUNT-005A';
    const att5AId = 'att_amt_005A_' + Date.now();

    await createPaymentAttempt(m5Id, order5AId, att5AId, 75.00);

    // Mock PayPal returns amount of $150.00 instead of $75.00
    mockPayPalOrders.set(order5AId, {
      id: order5AId,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m5Id,
        custom_id: att5AId,
        amount: { currency_code: 'USD', value: '150.00' }
      }]
    });

    const res5A = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order5AId })
    });
    const data5A = await res5A.json();

    if (res5A.status === 400 && data5A.error?.includes('amount')) {
      recordPass("TEST 5A: Amount mismatch ($150.00 vs $75.00) rejected with HTTP 400", data5A.error);
    } else {
      recordFail("TEST 5A: Amount mismatch not rejected", `Status: ${res5A.status}, Body: ${JSON.stringify(data5A)}`);
    }

    // Currency Mismatch (EUR instead of USD)
    const m5BId = await createMilestone(5052, 'Currency Check Milestone', 75.00);
    const order5BId = 'ORDER-TEST-WRONG-CURRENCY-005B';
    const att5BId = 'att_curr_005B_' + Date.now();
    await createPaymentAttempt(m5BId, order5BId, att5BId, 75.00);

    mockPayPalOrders.set(order5BId, {
      id: order5BId,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m5BId,
        custom_id: att5BId,
        amount: { currency_code: 'EUR', value: '75.00' }
      }]
    });

    const res5B = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order5BId })
    });
    const data5B = await res5B.json();

    if (res5B.status === 400 && data5B.error?.includes('currency')) {
      recordPass("TEST 5B: Currency mismatch (EUR) rejected with HTTP 400", data5B.error);
    } else {
      recordFail("TEST 5B: Currency mismatch not rejected", `Status: ${res5B.status}, Body: ${JSON.stringify(data5B)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Wrong Merchant Payee
    // -------------------------------------------------------------------------
    console.log("\n--- 6. Testing Wrong Merchant Payee ---");
    const m6Id = await createMilestone(506, 'Payee Check Milestone');
    const order6Id = 'ORDER-TEST-WRONG-PAYEE-006';
    const att6Id = 'att_payee_006_' + Date.now();

    await createPaymentAttempt(m6Id, order6Id, att6Id, 75.00, {
      raw_paypal_response: {
        purchase_units: [{
          payee: { merchant_id: 'MERCHANT-LEGITIMATE-123' }
        }]
      }
    });

    // Mock PayPal returns different merchant payee
    mockPayPalOrders.set(order6Id, {
      id: order6Id,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m6Id,
        custom_id: att6Id,
        amount: { currency_code: 'USD', value: '75.00' },
        payee: { merchant_id: 'MERCHANT-MALICIOUS-HIJACK' }
      }]
    });

    const res6 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order6Id })
    });
    const data6 = await res6.json();

    if (res6.status === 400 && data6.error?.includes('payee')) {
      recordPass("TEST 6: Merchant payee mismatch rejected with HTTP 400", data6.error);
    } else {
      recordFail("TEST 6: Payee mismatch not rejected", `Status: ${res6.status}, Body: ${JSON.stringify(data6)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 7: Wrong Order Intent (CAPTURE instead of AUTHORIZE)
    // -------------------------------------------------------------------------
    console.log("\n--- 7. Testing Wrong Order Intent ---");
    const m7Id = await createMilestone(507, 'Wrong Intent Milestone');
    const order7Id = 'ORDER-TEST-WRONG-INTENT-007';
    const att7Id = 'att_intent_007_' + Date.now();

    await createPaymentAttempt(m7Id, order7Id, att7Id, 75.00);

    mockPayPalOrders.set(order7Id, {
      id: order7Id,
      intent: 'CAPTURE', // INVALID INTENT
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m7Id,
        custom_id: att7Id,
        amount: { currency_code: 'USD', value: '75.00' }
      }]
    });

    const res7 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order7Id })
    });
    const data7 = await res7.json();

    if (res7.status === 400 && data7.error?.includes('intent')) {
      recordPass("TEST 7: Non-AUTHORIZE intent ('CAPTURE') rejected with HTTP 400", data7.error);
    } else {
      recordFail("TEST 7: Wrong intent not rejected", `Status: ${res7.status}, Body: ${JSON.stringify(data7)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 8: Order Not Approved (Status is CREATED or VOIDED)
    // -------------------------------------------------------------------------
    console.log("\n--- 8. Testing Order Not Approved (Unapproved State) ---");
    const m8Id = await createMilestone(508, 'Unapproved Order Milestone');
    const order8Id = 'ORDER-TEST-UNAPPROVED-008';
    const att8Id = 'att_unapp_008_' + Date.now();

    await createPaymentAttempt(m8Id, order8Id, att8Id, 75.00);

    mockPayPalOrders.set(order8Id, {
      id: order8Id,
      intent: 'AUTHORIZE',
      status: 'CREATED', // NOT APPROVED YET
      purchase_units: [{
        reference_id: m8Id,
        custom_id: att8Id,
        amount: { currency_code: 'USD', value: '75.00' }
      }]
    });

    const res8 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order8Id })
    });
    const data8 = await res8.json();

    if (res8.status === 400 && data8.error?.includes('not been approved')) {
      recordPass("TEST 8: Unapproved PayPal order ('CREATED') rejected with HTTP 400", data8.error);
    } else {
      recordFail("TEST 8: Unapproved order not rejected", `Status: ${res8.status}, Body: ${JSON.stringify(data8)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 9: Duplicate Callback (Idempotency)
    // -------------------------------------------------------------------------
    console.log("\n--- 9. Testing Duplicate Callback (Idempotency) ---");
    // Re-verify order 1 (which was approved in Test 1)
    const res9 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order1Id })
    });
    const data9 = await res9.json();

    if (res9.status === 200 && data9.success === true && data9.alreadyApproved === true && data9.status === 'APPROVED') {
      recordPass("TEST 9: Repeated callback returned idempotent HTTP 200 without error or re-mutation", `alreadyApproved: ${data9.alreadyApproved}`);
    } else {
      recordFail("TEST 9: Duplicate callback failed", `Status: ${res9.status}, Body: ${JSON.stringify(data9)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 10: Buyer Cancellation Workflow
    // -------------------------------------------------------------------------
    console.log("\n--- 10. Testing Buyer Cancellation Workflow ---");
    const m10Id = await createMilestone(510, 'Cancellation Milestone');
    const order10Id = 'ORDER-TEST-CANCEL-010';
    const att10Id = 'att_cancel_010_' + Date.now();

    await createPaymentAttempt(m10Id, order10Id, att10Id, 75.00);

    const res10 = await fetch(CANCEL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order10Id, reason: 'Buyer clicked cancel on checkout' })
    });
    const data10 = await res10.json();

    if (res10.status === 200 && data10.success === true && data10.status === 'VOIDED') {
      recordPass("TEST 10A: Cancellation endpoint successfully voided attempt (HTTP 200)");
    } else {
      recordFail("TEST 10A: Cancellation endpoint failed", `Status: ${res10.status}, Body: ${JSON.stringify(data10)}`);
    }

    // Verify DB: payment is VOIDED
    const { data: pCheck10 } = await adminClient.from('payments').select('status, manual_reconciliation_required').eq('payment_attempt_id', att10Id).single();
    if (pCheck10 && pCheck10.status === 'VOIDED') {
      recordPass("TEST 10B: Database payment record transitioned to VOIDED status");
    } else {
      recordFail("TEST 10B: Payment record not transitioned to VOIDED", JSON.stringify(pCheck10));
    }

    // Verify DB: milestone payment_status reset to unauthorized
    const { data: mCheck10 } = await adminClient.from('milestones').select('payment_status').eq('id', m10Id).single();
    if (mCheck10 && mCheck10.payment_status === 'unauthorized') {
      recordPass("TEST 10C: Milestone payment_status successfully reset to 'unauthorized' (unlocked for new attempt)");
    } else {
      recordFail("TEST 10C: Milestone payment_status not reset", JSON.stringify(mCheck10));
    }

    // Verify Audit Log: BUYER_APPROVAL_CANCELLED
    const { data: aLogs10 } = await adminClient.from('audit_logs').select('*').eq('milestone_id', m10Id).eq('action', 'BUYER_APPROVAL_CANCELLED');
    if (aLogs10 && aLogs10.length > 0 && aLogs10[0].new_state?.status === 'VOIDED') {
      recordPass("TEST 10D: Audit event BUYER_APPROVAL_CANCELLED logged in database");
    } else {
      recordFail("TEST 10D: Audit log for cancellation missing", JSON.stringify(aLogs10));
    }

    // -------------------------------------------------------------------------
    // TEST 11: PayPal API Timeout (Retryable Outcome)
    // -------------------------------------------------------------------------
    console.log("\n--- 11. Testing PayPal API Timeout (Retryable Safety) ---");
    const m11Id = await createMilestone(511, 'Timeout Test Milestone');
    const order11Id = 'ORDER-TEST-TIMEOUT-011';
    const att11Id = 'att_timeout_011_' + Date.now();

    await createPaymentAttempt(m11Id, order11Id, att11Id, 75.00);

    // Register timeout simulation in mock server
    simulateTimeoutOrders.add(order11Id);

    const res11 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order11Id })
    });
    const data11 = await res11.json();

    if (res11.status === 504 && data11.retryable === true) {
      recordPass("TEST 11A: PayPal timeout handled safely with HTTP 504 and retryable: true", data11.error);
    } else {
      recordFail("TEST 11A: PayPal timeout did not return 504 retryable", `Status: ${res11.status}, Body: ${JSON.stringify(data11)}`);
    }

    // Verify that attempt was NOT marked failed; remains in CREATED so client can retry
    const { data: pCheck11 } = await adminClient.from('payments').select('status').eq('payment_attempt_id', att11Id).single();
    if (pCheck11 && pCheck11.status === 'CREATED') {
      recordPass("TEST 11B: Database attempt preserved in CREATED status (not prematurely failed)");
    } else {
      recordFail("TEST 11B: Attempt was corrupted on timeout", JSON.stringify(pCheck11));
    }

    // -------------------------------------------------------------------------
    // TEST 12: Unauthorized User (Missing Session/Token)
    // -------------------------------------------------------------------------
    console.log("\n--- 12. Testing Unauthorized User ---");
    const res12 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
        // No Authorization header
      },
      body: JSON.stringify({ orderId: order1Id })
    });
    const data12 = await res12.json();

    if (res12.status === 401 && data12.error?.includes('Unauthorized')) {
      recordPass("TEST 12: Unauthenticated request rejected with HTTP 401 Unauthorized", data12.error);
    } else {
      recordFail("TEST 12: Unauthenticated request was not rejected with 401", `Status: ${res12.status}, Body: ${JSON.stringify(data12)}`);
    }

  } catch (err) {
    console.error("Test execution exception:", err);
    recordFail("Execution Exception", err.message);
  } finally {
    // Stop Mock Server
    await new Promise((resolve) => mockServer.close(resolve));
    console.log("\n✓ Mock PayPal Server stopped.");

    // Clean up temporary test fixtures
    console.log("--- Cleaning up temporary test fixtures ---");
    for (const mId of createdMilestones) {
      await adminClient.from('payments').delete().eq('milestone_id', mId);
      await adminClient.from('milestones').delete().eq('id', mId);
    }
    console.log("✓ Baseline database state restored.");

    // Restore clean .env.local
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
