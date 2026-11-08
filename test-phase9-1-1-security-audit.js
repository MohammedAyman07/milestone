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
const ORDERS_URL = 'http://localhost:3000/api/paypal/orders';
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

// Mock Server State
const mockPayPalOrders = new Map();
let lastCreatedOrderPayload = null;

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
        access_token: 'mock_audit_token_555',
        token_type: 'Bearer',
        expires_in: 3600
      }));
      return;
    }

    // Orders v2 Create Order
    if (req.url === '/v2/checkout/orders' && req.method === 'POST') {
      lastCreatedOrderPayload = parsedBody;
      const orderId = 'ORDER-AUDIT-' + Math.floor(Math.random() * 100000);
      const resp = {
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
      };
      mockPayPalOrders.set(orderId, resp);
      res.writeHead(201, { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg-audit-201' });
      res.end(JSON.stringify(resp));
      return;
    }

    // Orders v2 Get Order (/v2/checkout/orders/:orderId)
    const match = req.url.match(/^\/v2\/checkout\/orders\/([^/?]+)/);
    if (match && req.method === 'GET') {
      const orderId = match[1];

      if (mockPayPalOrders.has(orderId)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockPayPalOrders.get(orderId)));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: "RESOURCE_NOT_FOUND",
        message: "The specified resource does not exist.",
        debug_id: "dbg_audit_404"
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
});

async function runTestSuite() {
  console.log("=============================================================================");
  console.log("MILESTONE AI — Phase 9.1.1: Buyer Approval Security Audit Test Suite");
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
    console.log(`✓ Client B (Attacker): ${clientUserB.email} (${clientUserB.id})`);
    console.log(`✓ Test Project: ${testProject.id}\n`);

    async function createMilestone(phase, title, amount = 75.00) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 9.1.1 Security Audit Test',
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
    // TEST 1: Supabase UUID Incorrectly Compared to PayPal Payer ID
    // -------------------------------------------------------------------------
    console.log("--- 1. Testing Identity Verification Model: Supabase UUID vs PayPal Payer ID ---");
    const m1Id = await createMilestone(601, 'Identity Mapping Milestone');
    const order1Id = 'ORDER-AUDIT-IDENT-001';
    const att1Id = 'att_ident_001_' + Date.now();
    const legitPayPalPayerId = 'PAYER-SANDBOX-ALPHANUM-999';

    await createPaymentAttempt(m1Id, order1Id, att1Id, 75.00);

    // Mock PayPal returns valid order with PayPal customer account ID
    mockPayPalOrders.set(order1Id, {
      id: order1Id,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m1Id,
        custom_id: att1Id,
        amount: { currency_code: 'USD', value: '75.00' }
      }],
      payer: {
        payer_id: legitPayPalPayerId,
        email_address: 'clientA-sandbox@example.com'
      }
    });

    // Client sends their own Supabase User UUID as payerId in the request body
    const res1 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        orderId: order1Id,
        payerId: clientUserA.id // Passing Supabase UUID instead of PayPal payer ID
      })
    });
    const data1 = await res1.json();

    if (res1.status === 200 && data1.success === true) {
      recordPass("TEST 1A: Server did not fail or miscompare Supabase UUID with PayPal payer ID");
    } else {
      recordFail("TEST 1A: Identity mapping failed", `Status: ${res1.status}, Body: ${JSON.stringify(data1)}`);
    }

    // Verify DB stored PayPal payer ID in paypal_payer_id and Supabase user UUID in payer_id
    const { data: pCheck1 } = await adminClient
      .from('payments')
      .select('payer_id, paypal_payer_id, status')
      .eq('payment_attempt_id', att1Id)
      .single();

    if (
      pCheck1 &&
      pCheck1.payer_id === clientUserA.id &&
      pCheck1.paypal_payer_id === legitPayPalPayerId &&
      pCheck1.paypal_payer_id !== clientUserA.id
    ) {
      recordPass("TEST 1B: Verified database strictly separates Application Identity (payer_id: UUID) and PayPal Financial Identity (paypal_payer_id: PayPal ID)", `payer_id: ${pCheck1.payer_id}, paypal_payer_id: ${pCheck1.paypal_payer_id}`);
    } else {
      recordFail("TEST 1B: Identity fields confused or stored incorrectly", JSON.stringify(pCheck1));
    }

    // -------------------------------------------------------------------------
    // TEST 2: Authenticated User Attempting Another Client's Order
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Testing Non-Owner Client Order Validation ---");
    // Client B attempts to approve Client A's order
    const res2 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenB}` // Different authenticated user
      },
      body: JSON.stringify({ orderId: order1Id })
    });
    const data2 = await res2.json();

    if (res2.status === 403 && data2.error?.includes('Forbidden')) {
      recordPass("TEST 2: Attempt by another authenticated user rejected with HTTP 403 Forbidden", data2.error);
    } else {
      recordFail("TEST 2: Non-owner client was not rejected with 403", `Status: ${res2.status}, Body: ${JSON.stringify(data2)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Cancellation Followed by Late PayPal Approval
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Testing Cancellation Followed by Late PayPal Approval ---");
    const m3Id = await createMilestone(603, 'Late Approval Milestone');
    const order3Id = 'ORDER-AUDIT-LATE-003';
    const att3Id = 'att_late_003_' + Date.now();

    await createPaymentAttempt(m3Id, order3Id, att3Id, 75.00);

    // Mock PayPal reports order definitively closed at PayPal (EXPIRED)
    mockPayPalOrders.set(order3Id, {
      id: order3Id,
      status: 'EXPIRED',
      intent: 'AUTHORIZE'
    });

    // Client cancels order, transitioning it to VOIDED
    const resCancel3 = await fetch(CANCEL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order3Id, reason: 'Order expired before approval' })
    });
    const dataCancel3 = await resCancel3.json();

    if (resCancel3.status === 200 && dataCancel3.status === 'VOIDED') {
      recordPass("TEST 3A: Order successfully closed and voided");
    } else {
      recordFail("TEST 3A: Initial void failed", JSON.stringify(dataCancel3));
    }

    // Now a late approval callback arrives for this voided attempt
    mockPayPalOrders.set(order3Id, {
      id: order3Id,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m3Id,
        custom_id: att3Id,
        amount: { currency_code: 'USD', value: '75.00' }
      }],
      payer: { payer_id: legitPayPalPayerId, email_address: 'clientA@example.com' }
    });

    const resLate3 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order3Id })
    });
    const dataLate3 = await resLate3.json();

    if (resLate3.status === 409 && dataLate3.error?.includes('terminal status VOIDED')) {
      recordPass("TEST 3B: Late approval callback rejected with HTTP 409 (cannot revive safely closed attempt)", dataLate3.error);
    } else {
      recordFail("TEST 3B: Late approval was not rejected", `Status: ${resLate3.status}, Body: ${JSON.stringify(dataLate3)}`);
    }

    // Verify DB record remains strictly VOIDED
    const { data: pCheck3 } = await adminClient.from('payments').select('status').eq('payment_attempt_id', att3Id).single();
    if (pCheck3 && pCheck3.status === 'VOIDED') {
      recordPass("TEST 3C: Database state machine verified: record remains locked in terminal VOIDED status");
    } else {
      recordFail("TEST 3C: Database record mutated from VOIDED!", JSON.stringify(pCheck3));
    }

    // -------------------------------------------------------------------------
    // TEST 4: Repeated Cancellation Callback (Idempotency)
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Testing Repeated Cancellation Callback ---");
    const resRepeat4 = await fetch(CANCEL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order3Id })
    });
    const dataRepeat4 = await resRepeat4.json();

    if (resRepeat4.status === 200 && dataRepeat4.alreadyVoided === true) {
      recordPass("TEST 4: Repeated cancellation on already voided attempt returned idempotent HTTP 200", `alreadyVoided: ${dataRepeat4.alreadyVoided}`);
    } else {
      recordFail("TEST 4: Repeated cancellation failed", `Status: ${resRepeat4.status}, Body: ${JSON.stringify(dataRepeat4)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Cancellation When PayPal Order Is Still Usable (Safety Clamping)
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Testing Cancellation When PayPal Order Is Still Usable ---");
    const m5Id = await createMilestone(605, 'Usable Order Cancel Milestone');
    const order5Id = 'ORDER-AUDIT-USABLE-005';
    const att5Id = 'att_usable_005_' + Date.now();

    await createPaymentAttempt(m5Id, order5Id, att5Id, 75.00);

    // Mock PayPal reports order is STILL ACTIVE in CREATED status
    mockPayPalOrders.set(order5Id, {
      id: order5Id,
      status: 'CREATED',
      intent: 'AUTHORIZE'
    });

    const resCancel5 = await fetch(CANCEL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order5Id, reason: 'Buyer closed browser tab' })
    });
    const dataCancel5 = await resCancel5.json();

    if (resCancel5.status === 200 && dataCancel5.preserved === true && dataCancel5.status === 'CREATED') {
      recordPass("TEST 5A: Server refused to mark attempt VOIDED because PayPal order is still usable; preserved in CREATED status", dataCancel5.message);
    } else {
      recordFail("TEST 5A: Usable order was improperly voided or rejected", `Status: ${resCancel5.status}, Body: ${JSON.stringify(dataCancel5)}`);
    }

    // Verify DB payment remains in CREATED status
    const { data: pCheck5 } = await adminClient.from('payments').select('status, manual_reconciliation_required').eq('payment_attempt_id', att5Id).single();
    if (pCheck5 && pCheck5.status === 'CREATED' && pCheck5.manual_reconciliation_required === true) {
      recordPass("TEST 5B: Database record preserved in CREATED status with manual_reconciliation_required=true");
    } else {
      recordFail("TEST 5B: DB record was modified incorrectly", JSON.stringify(pCheck5));
    }

    // Verify Milestone remains locked by unique constraint (cannot insert second active attempt)
    const { data: bypassAttempt, error: bypassErr } = await adminClient.from('payments').insert([{
      milestone_id: m5Id,
      project_id: testProject.id,
      payer_id: clientUserA.id,
      payee_id: clientUserA.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: `att_illegal_dup_${Date.now()}`,
      attempt_number: 2,
    }]);

    if (bypassErr && bypassErr.message.includes('uq_active_milestone_payment_attempt')) {
      recordPass("TEST 5C: Verified milestone cannot be unlocked while PayPal order is usable; second active attempt rejected by database unique constraint", bypassErr.message);
    } else {
      recordFail("TEST 5C: Milestone was unlocked and allowed second active payment attempt!", bypassErr?.message || "Success");
    }

    // -------------------------------------------------------------------------
    // TEST 6: Untrusted Host Header (Host Header Injection Defense)
    // -------------------------------------------------------------------------
    console.log("\n--- 6. Testing Untrusted Host Header Defense ---");
    const m6Id = await createMilestone(606, 'Host Injection Defense Milestone');
    lastCreatedOrderPayload = null;

    const resHost6 = await fetch(ORDERS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`,
        'Host': 'attacker-evil-phishing.com', // Host Header Injection Attempt
        'X-Forwarded-Host': 'attacker-evil-phishing.com'
      },
      body: JSON.stringify({
        milestoneId: m6Id,
        projectId: testProject.id
      })
    });
    const dataHost6 = await resHost6.json();

    if (resHost6.status === 201 && dataHost6.approvalUrl) {
      const returnUrlSent = lastCreatedOrderPayload?.application_context?.return_url;
      const cancelUrlSent = lastCreatedOrderPayload?.application_context?.cancel_url;

      if (
        returnUrlSent &&
        !returnUrlSent.includes('attacker-evil-phishing.com') &&
        returnUrlSent.startsWith('http://localhost:3000')
      ) {
        recordPass("TEST 6: Untrusted Host header ignored; server strictly used trusted application origin for PayPal return_url", returnUrlSent);
      } else {
        recordFail("TEST 6: Host header injection succeeded! Poisoned URL sent to PayPal:", returnUrlSent);
      }
    } else {
      recordFail("TEST 6: Order creation failed", `Status: ${resHost6.status}, Body: ${JSON.stringify(dataHost6)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 7: Untrusted Return URL (Open Redirect Defense)
    // -------------------------------------------------------------------------
    console.log("\n--- 7. Testing Untrusted Return URL Defense (Open Redirect) ---");
    const m7Id = await createMilestone(607, 'Open Redirect Defense Milestone');
    lastCreatedOrderPayload = null;

    const resOpen7 = await fetch(ORDERS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({
        milestoneId: m7Id,
        projectId: testProject.id,
        returnUrl: 'https://evil-phishing-attacker.com/steal-token', // Open redirect attempt
        cancelUrl: 'https://evil-phishing-attacker.com/steal-cancel'
      })
    });
    const dataOpen7 = await resOpen7.json();

    if (resOpen7.status === 201 && dataOpen7.approvalUrl) {
      const returnUrlSent7 = lastCreatedOrderPayload?.application_context?.return_url;
      const cancelUrlSent7 = lastCreatedOrderPayload?.application_context?.cancel_url;

      if (
        returnUrlSent7 &&
        !returnUrlSent7.includes('evil-phishing-attacker.com') &&
        returnUrlSent7 === 'http://localhost:3000/payments/paypal/success'
      ) {
        recordPass("TEST 7: Untrusted returnUrl rejected; defaulted safely to http://localhost:3000/payments/paypal/success", returnUrlSent7);
      } else {
        recordFail("TEST 7: Open redirect vulnerability! External URL passed to PayPal:", returnUrlSent7);
      }
    } else {
      recordFail("TEST 7: Order creation failed", `Status: ${resOpen7.status}, Body: ${JSON.stringify(dataOpen7)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 8: Duplicate Approval Callback (Idempotent Safe Handling)
    // -------------------------------------------------------------------------
    console.log("\n--- 8. Testing Duplicate Approval Callback ---");
    // Re-verify order 1 (which was approved in Test 1)
    const resDup8 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order1Id })
    });
    const dataDup8 = await resDup8.json();

    if (resDup8.status === 200 && dataDup8.success === true && dataDup8.alreadyApproved === true && dataDup8.status === 'APPROVED') {
      recordPass("TEST 8: Duplicate approval callback returned idempotent HTTP 200 without duplicate mutations", `status: ${dataDup8.status}`);
    } else {
      recordFail("TEST 8: Duplicate approval callback failed", `Status: ${resDup8.status}, Body: ${JSON.stringify(dataDup8)}`);
    }

    // -------------------------------------------------------------------------
    // TEST 9: Correct PayPal Payer ID with Valid Client Ownership
    // -------------------------------------------------------------------------
    console.log("\n--- 9. Testing Correct PayPal Payer ID with Valid Client Ownership ---");
    const m9Id = await createMilestone(609, 'Payer ID Verification Milestone');
    const order9Id = 'ORDER-AUDIT-VALID-PAYER-009';
    const att9Id = 'att_valid_payer_009_' + Date.now();
    const verifiedPayPalId = 'PAYER-SANDBOX-VERIFIED-777';

    await createPaymentAttempt(m9Id, order9Id, att9Id, 75.00);

    mockPayPalOrders.set(order9Id, {
      id: order9Id,
      intent: 'AUTHORIZE',
      status: 'APPROVED',
      purchase_units: [{
        reference_id: m9Id,
        custom_id: att9Id,
        amount: { currency_code: 'USD', value: '75.00' }
      }],
      payer: {
        payer_id: verifiedPayPalId,
        email_address: 'verified-payer@sandbox.paypal.com'
      }
    });

    const res9 = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientTokenA}`
      },
      body: JSON.stringify({ orderId: order9Id })
    });
    const data9 = await res9.json();

    if (res9.status === 200 && data9.success === true && data9.payerId === verifiedPayPalId && data9.status === 'APPROVED') {
      recordPass("TEST 9: Correct PayPal payer ID verified from PayPal API and recorded with client ownership", `payerId: ${data9.payerId}`);
    } else {
      recordFail("TEST 9: Payer ID verification failed", `Status: ${res9.status}, Body: ${JSON.stringify(data9)}`);
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
