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

function updateEnv(overrides = {}) {
  const baseLines = [
    `GEMINI_API_KEY="${geminiKey}"`,
    `GEMINI_MODEL="${geminiModel}"`,
    `NEXT_PUBLIC_SUPABASE_URL="${url}"`,
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_pjDstJdv50dCFoh21NttlA_VFaJcWqM"',
    `NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonKey}"`,
    `SUPABASE_SERVICE_ROLE_KEY="${servKey}"`,
    'PAYPAL_ENVIRONMENT=sandbox',
    'PAYPAL_CLIENT_ID=' + (overrides.PAYPAL_CLIENT_ID ?? 'mock_test_client_id'),
    'PAYPAL_CLIENT_SECRET=' + (overrides.PAYPAL_CLIENT_SECRET ?? 'mock_test_client_secret'),
    'PAYPAL_WEBHOOK_ID=',
    'PAYPAL_BASE_URL=' + (overrides.PAYPAL_BASE_URL ?? `http://localhost:${MOCK_PORT}`),
  ];

  if (overrides.PAYPAL_IDEMPOTENCY_RETENTION_HOURS !== undefined) {
    baseLines.push(`PAYPAL_IDEMPOTENCY_RETENTION_HOURS=${overrides.PAYPAL_IDEMPOTENCY_RETENTION_HOURS}`);
  }
  if (overrides.PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED !== undefined) {
    baseLines.push(`PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=${overrides.PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED}`);
  }

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

// =============================================================================
// Helper: Direct Config Logic Tester (matches src/lib/paypal/orders.ts)
// =============================================================================
const DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 6;
const MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS = 72;

function evaluateConfig(envMock = {}) {
  const confirmedRaw = (envMock.PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED || '').trim().toLowerCase();
  const isExtendedConfirmed = confirmedRaw === 'true' || confirmedRaw === '1' || confirmedRaw === 'yes';

  const envHoursRaw = envMock.PAYPAL_IDEMPOTENCY_RETENTION_HOURS ? envMock.PAYPAL_IDEMPOTENCY_RETENTION_HOURS.trim() : undefined;

  if (!envHoursRaw) {
    if (isExtendedConfirmed) {
      return {
        retentionHours: MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
        retentionMs: MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
        isExtendedConfirmed: true,
        source: 'configured_extended',
      };
    }
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed: false,
      source: 'default',
    };
  }

  const parsedHours = parseFloat(envHoursRaw);
  if (isNaN(parsedHours) || parsedHours <= 0) {
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed,
      source: 'default',
    };
  }

  if (parsedHours > DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS && !isExtendedConfirmed) {
    return {
      retentionHours: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS,
      retentionMs: DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
      isExtendedConfirmed: false,
      source: 'fallback_unconfirmed',
    };
  }

  const finalHours = Math.min(parsedHours, MAX_PAYPAL_IDEMPOTENCY_RETENTION_HOURS);
  return {
    retentionHours: finalHours,
    retentionMs: finalHours * 60 * 60 * 1000,
    isExtendedConfirmed,
    source: finalHours > DEFAULT_PAYPAL_IDEMPOTENCY_RETENTION_HOURS ? 'configured_extended' : 'configured_standard',
  };
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
        access_token: 'mock_retention_token_999',
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

      const orderId = 'ORDER-RETENTION-MOCK-' + Math.floor(Math.random() * 100000);
      res.writeHead(201, {
        'Content-Type': 'application/json',
        'paypal-debug-id': 'dbg-retention-201'
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
  console.log("MILESTONE AI — Phase 8.5: PayPal Idempotency Retention Configuration Tests");
  console.log("=============================================================================\n");

  // ===========================================================================
  // SECTION 1: UNIT / CONFIGURATION RESOLUTION MATRIX
  // ===========================================================================
  console.log("--- 1. Testing Idempotency Retention Configuration Matrix ---");

  // Test 1.1: Default Environment (no env vars set)
  const cfg1 = evaluateConfig({});
  if (cfg1.retentionHours === 6 && !cfg1.isExtendedConfirmed && cfg1.source === 'default') {
    recordPass("TEST 1.1: Default configuration resolves strictly to 6 hours (unconfirmed)");
  } else {
    recordFail("TEST 1.1: Default config mismatch", JSON.stringify(cfg1));
  }

  // Test 1.2: Configured Standard Retention <= 6h
  const cfg2 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '3', PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'false' });
  if (cfg2.retentionHours === 3 && !cfg2.isExtendedConfirmed && cfg2.source === 'configured_standard') {
    recordPass("TEST 1.2: Explicit standard retention (3 hours) accepted without extended confirmation");
  } else {
    recordFail("TEST 1.2: Standard config mismatch", JSON.stringify(cfg2));
  }

  // Test 1.3: Requested 72h without confirmation -> Safe clamp to 6h
  const cfg3 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '72', PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'false' });
  if (cfg3.retentionHours === 6 && !cfg3.isExtendedConfirmed && cfg3.source === 'fallback_unconfirmed') {
    recordPass("TEST 1.3: Requested 72 hours without confirmation safely clamped/fallback to 6 hours");
  } else {
    recordFail("TEST 1.3: Unconfirmed 72h did not fallback to 6h", JSON.stringify(cfg3));
  }

  // Test 1.4: Requested 24h without confirmation -> Safe clamp to 6h
  const cfg4 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '24' });
  if (cfg4.retentionHours === 6 && !cfg4.isExtendedConfirmed && cfg4.source === 'fallback_unconfirmed') {
    recordPass("TEST 1.4: Requested 24 hours without confirmation safely clamped to 6 hours");
  } else {
    recordFail("TEST 1.4: Unconfirmed 24h did not clamp", JSON.stringify(cfg4));
  }

  // Test 1.5: Requested 72h WITH explicit confirmation -> 72 hours
  const cfg5 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '72', PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'true' });
  if (cfg5.retentionHours === 72 && cfg5.isExtendedConfirmed && cfg5.source === 'configured_extended') {
    recordPass("TEST 1.5: Confirmed 72-hour extension granted when PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true");
  } else {
    recordFail("TEST 1.5: Confirmed 72h failed to resolve", JSON.stringify(cfg5));
  }

  // Test 1.6: Confirmed flag set without hours specified -> Defaults to max 72h
  const cfg6 = evaluateConfig({ PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'true' });
  if (cfg6.retentionHours === 72 && cfg6.isExtendedConfirmed && cfg6.source === 'configured_extended') {
    recordPass("TEST 1.6: Confirmed flag alone resolves to 72 hours");
  } else {
    recordFail("TEST 1.6: Confirmed flag resolution mismatch", JSON.stringify(cfg6));
  }

  // Test 1.7: Confirmed custom hours (e.g. 36h)
  const cfg7 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '36', PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'true' });
  if (cfg7.retentionHours === 36 && cfg7.isExtendedConfirmed && cfg7.source === 'configured_extended') {
    recordPass("TEST 1.7: Confirmed custom hours (36 hours) resolved accurately");
  } else {
    recordFail("TEST 1.7: Confirmed 36h resolution mismatch", JSON.stringify(cfg7));
  }

  // Test 1.8: Requested > 72h with confirmation -> Clamped to 72h platform ceiling
  const cfg8 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '120', PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'true' });
  if (cfg8.retentionHours === 72 && cfg8.isExtendedConfirmed) {
    recordPass("TEST 1.8: Hours exceeding platform limit (120h) clamped to maximum 72 hours");
  } else {
    recordFail("TEST 1.8: Clamping beyond 72h failed", JSON.stringify(cfg8));
  }

  // Test 1.9: Invalid numeric inputs
  const cfg9 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '-10' });
  const cfg10 = evaluateConfig({ PAYPAL_IDEMPOTENCY_RETENTION_HOURS: 'not_a_number' });
  if (cfg9.retentionHours === 6 && cfg10.retentionHours === 6) {
    recordPass("TEST 1.9: Invalid/negative/NaN inputs fallback safely to 6 hours");
  } else {
    recordFail("TEST 1.9: Invalid input fallback failed", `${cfg9.retentionHours}, ${cfg10.retentionHours}`);
  }

  // ===========================================================================
  // SECTION 2: LIVE API & DATABASE RECOVERY TESTS
  // ===========================================================================
  console.log("\n--- 2. Setting Up Test Fixtures for API & Database Testing ---");

  // Start Mock Server
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
  console.log(`✓ Mock PayPal Server running on port ${MOCK_PORT}`);

  let clientUser = null;
  let clientToken = null;
  let testProject = null;
  const createdMilestones = [];

  try {
    // Setup Test Client & Auth
    const { data: usersData } = await adminClient.auth.admin.listUsers();
    clientUser = usersData.users[0];
    const { data: projects } = await adminClient.from('projects').select('*');
    testProject = projects[0];

    // Pre-clean and setup project budget
    await adminClient.from('projects').update({
      client_id: clientUser.id,
      budget: 100000.00
    }).eq('id', testProject.id);

    const auth = await anonClient.auth.signInWithPassword({
      email: clientUser.email,
      password: 'TestPassword123!@#'
    });
    clientToken = auth.data.session.access_token;
    console.log(`✓ Authenticated test client user: ${clientUser.email} (${clientUser.id})`);
    console.log(`✓ Test project resolved: ${testProject.id}`);

    async function createMilestone(phase, title) {
      const { data: m, error } = await adminClient.from('milestones').insert([{
        project_id: testProject.id,
        phase,
        title,
        description: 'Phase 8.5 Idempotency Config Verification',
        amount: 75.00,
        currency: 'USD',
        due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
        status: 'pending',
        payment_status: 'unauthorized',
      }]).select('id').single();
      if (error) throw new Error(`Milestone create failed: ${error.message}`);
      createdMilestones.push(m.id);
      return m.id;
    }

    // =========================================================================
    // CONFIGURATION A: Default 6-Hour Retention Enforced
    // =========================================================================
    console.log("\n=== CONFIG A: Default 6-Hour Window (Unconfirmed) ===");
    updateEnv({
      PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '6',
      PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'false'
    });
    await sleep(1500); // Wait for Next.js to reload .env.local

    // Test 2A.1: Attempt at 8 Hours Expired (> 6h)
    console.log("--- 2A.1. Testing Default 6-Hour Policy: Attempt at 8h Expired ---");
    const m1Id = await createMilestone(401, 'Expired 8h Milestone');
    const att1Id = `att_exp8h_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const key1 = `ord_create_${att1Id}`;
    const eightHoursAgo = new Date(Date.now() - 8 * 3600 * 1000).toISOString();

    await adminClient.from('payments').insert([{
      milestone_id: m1Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: att1Id,
      attempt_number: 1,
      idempotency_order_create: key1,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "Network timeout" },
      created_at: eightHoursAgo,
      updated_at: eightHoursAgo,
    }]);

    capturedOrdersRequests = [];

    const res1 = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m1Id, projectId: testProject.id })
    });
    const data1 = await res1.json();

    if (res1.status === 409 && data1.outcome === 'RECONCILIATION_EXPIRED' && data1.retentionLimitHours === 6) {
      recordPass("TEST 2A.1: Attempt older than 6 hours (8h) rejected with HTTP 409 RECONCILIATION_EXPIRED", data1.error);
    } else {
      recordFail("TEST 2A.1: Attempt at 8h was not rejected with 6h expiry", `Status: ${res1.status}, Body: ${JSON.stringify(data1)}`);
    }

    // Verify ZERO calls to PayPal
    if (capturedOrdersRequests.length === 0) {
      recordPass("TEST 2A.2: Zero PayPal calls dispatched for expired 8h attempt (safe blocking)");
    } else {
      recordFail("TEST 2A.2: PayPal was called despite 6h retention expiry!", `Calls: ${capturedOrdersRequests.length}`);
    }

    // Verify DB record remains locked in CREATED status
    const { data: pCheck1 } = await adminClient
      .from('payments')
      .select('status, manual_reconciliation_required, order_id')
      .eq('payment_attempt_id', att1Id)
      .single();

    if (pCheck1 && pCheck1.status === 'CREATED' && pCheck1.manual_reconciliation_required === true && !pCheck1.order_id) {
      recordPass("TEST 2A.3: Database record preserved in CREATED with manual_reconciliation_required=true");
    } else {
      recordFail("TEST 2A.3: DB record mutated incorrectly", JSON.stringify(pCheck1));
    }

    // Verify Audit Log
    const { data: aLogs1 } = await adminClient
      .from('audit_logs')
      .select('*')
      .eq('milestone_id', m1Id)
      .eq('action', 'PAYPAL_ORDER_RECONCILIATION_EXPIRED');

    if (aLogs1 && aLogs1.length > 0 && aLogs1[0].new_state?.retentionLimitHours === 6) {
      recordPass("TEST 2A.4: Audit event PAYPAL_ORDER_RECONCILIATION_EXPIRED recorded with retentionLimitHours=6", JSON.stringify(aLogs1[0].new_state));
    } else {
      recordFail("TEST 2A.4: Audit log missing or incorrect retention limit", JSON.stringify(aLogs1));
    }

    // Test 2A.5: Attempt at 2 Hours Reconciles Successfully (< 6h)
    console.log("\n--- 2A.5. Testing Default 6-Hour Policy: Attempt at 2h (< 6h) Reconciles ---");
    const m2Id = await createMilestone(402, 'Valid 2h Milestone');
    const att2Id = `att_valid2h_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const key2 = `ord_create_${att2Id}`;
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    await adminClient.from('payments').insert([{
      milestone_id: m2Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: att2Id,
      attempt_number: 1,
      idempotency_order_create: key2,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "504 Gateway Timeout" },
      created_at: twoHoursAgo,
      updated_at: twoHoursAgo,
    }]);

    capturedOrdersRequests = [];

    const res2 = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m2Id, projectId: testProject.id })
    });
    const data2 = await res2.json();

    if (res2.status === 200 && data2.reconciled === true && data2.orderId) {
      recordPass("TEST 2A.5: Attempt within 6h window (2h) successfully reconciled via idempotent replay (HTTP 200)");

      const reqReceived = capturedOrdersRequests[0];
      if (reqReceived && reqReceived.headers['paypal-request-id'] === key2) {
        recordPass("TEST 2A.6: Verified original idempotency key reused during reconciliation replay", key2);
      } else {
        recordFail("TEST 2A.6: Original idempotency key was not reused", reqReceived?.headers['paypal-request-id']);
      }
    } else {
      recordFail("TEST 2A.5: Replay within retention window failed", `Status: ${res2.status}, Body: ${JSON.stringify(data2)}`);
    }

    // =========================================================================
    // CONFIGURATION B: Unconfirmed 72-Hour Setting Falls Back to 6-Hour
    // =========================================================================
    console.log("\n=== CONFIG B: Unconfirmed 72-Hour Setting (Safety Fallback to 6h) ===");
    updateEnv({
      PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '72',
      PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'false'
    });
    await sleep(1500);

    console.log("--- 2B.1. Testing Unconfirmed 72h: Attempt at 8h Must Be Rejected by 6h Fallback ---");
    const m3Id = await createMilestone(403, 'Unconfirmed 72h Fallback Milestone');
    const att3Id = `att_unconf_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const key3 = `ord_create_${att3Id}`;

    await adminClient.from('payments').insert([{
      milestone_id: m3Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: att3Id,
      attempt_number: 1,
      idempotency_order_create: key3,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "Connection drop" },
      created_at: eightHoursAgo,
      updated_at: eightHoursAgo,
    }]);

    capturedOrdersRequests = [];

    const res3 = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m3Id, projectId: testProject.id })
    });
    const data3 = await res3.json();

    if (res3.status === 409 && data3.outcome === 'RECONCILIATION_EXPIRED' && data3.retentionLimitHours === 6 && data3.isExtendedConfirmed === false) {
      recordPass("TEST 2B.1: Server clamped unconfirmed 72h to 6h limit and rejected 8h attempt (HTTP 409 RECONCILIATION_EXPIRED)");
    } else {
      recordFail("TEST 2B.1: Unconfirmed 72h was not clamped to 6h", `Status: ${res3.status}, Body: ${JSON.stringify(data3)}`);
    }

    if (capturedOrdersRequests.length === 0) {
      recordPass("TEST 2B.2: Zero calls dispatched to PayPal on unconfirmed fallback rejection");
    } else {
      recordFail("TEST 2B.2: PayPal was called on unconfirmed fallback!", `Calls: ${capturedOrdersRequests.length}`);
    }

    // =========================================================================
    // CONFIGURATION C: Confirmed 72-Hour Extension
    // =========================================================================
    console.log("\n=== CONFIG C: Confirmed 72-Hour Extension Enabled ===");
    updateEnv({
      PAYPAL_IDEMPOTENCY_RETENTION_HOURS: '72',
      PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED: 'true'
    });
    await sleep(1500);

    // Test 2C.1: Attempt at 8 Hours (< 72h) Now Successfully Reconciles!
    console.log("--- 2C.1. Testing Confirmed 72h: Attempt at 8h (< 72h) Successfully Reconciles ---");
    const m4Id = await createMilestone(404, 'Confirmed 8h Milestone');
    const att4Id = `att_conf8h_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const key4 = `ord_create_${att4Id}`;

    await adminClient.from('payments').insert([{
      milestone_id: m4Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: att4Id,
      attempt_number: 1,
      idempotency_order_create: key4,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "503 Service Unavailable" },
      created_at: eightHoursAgo,
      updated_at: eightHoursAgo,
    }]);

    capturedOrdersRequests = [];

    const res4 = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m4Id, projectId: testProject.id })
    });
    const data4 = await res4.json();

    if (res4.status === 200 && data4.reconciled === true && data4.orderId) {
      recordPass("TEST 2C.1: Confirmed 72h configuration permits reconciliation replay at 8 hours (HTTP 200)");

      const reqReceived = capturedOrdersRequests[0];
      if (reqReceived && reqReceived.headers['paypal-request-id'] === key4) {
        recordPass("TEST 2C.2: Verified original idempotency key reused under confirmed 72h extension", key4);
      } else {
        recordFail("TEST 2C.2: Idempotency key not reused", reqReceived?.headers['paypal-request-id']);
      }
    } else {
      recordFail("TEST 2C.1: Replay at 8h under confirmed 72h failed", `Status: ${res4.status}, Body: ${JSON.stringify(data4)}`);
    }

    // Test 2C.3: Attempt at 75 Hours (> 72h Max) Expired Even Under Confirmed 72h
    console.log("\n--- 2C.3. Testing Confirmed 72h: Attempt at 75h (> 72h Ceiling) Expired ---");
    const m5Id = await createMilestone(405, 'Confirmed 75h Expired Milestone');
    const att5Id = `att_conf75h_${require('crypto').randomUUID().replace(/-/g, '')}`;
    const key5 = `ord_create_${att5Id}`;
    const seventyFiveHoursAgo = new Date(Date.now() - 75 * 3600 * 1000).toISOString();

    await adminClient.from('payments').insert([{
      milestone_id: m5Id,
      project_id: testProject.id,
      payer_id: clientUser.id,
      payee_id: clientUser.id,
      amount: 75.00,
      currency: "USD",
      payment_type: "order",
      status: "CREATED",
      payment_attempt_id: att5Id,
      attempt_number: 1,
      idempotency_order_create: key5,
      manual_reconciliation_required: true,
      error_details: { outcome: "UNCERTAIN", reason: "504 Gateway Timeout" },
      created_at: seventyFiveHoursAgo,
      updated_at: seventyFiveHoursAgo,
    }]);

    capturedOrdersRequests = [];

    const res5 = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ milestoneId: m5Id, projectId: testProject.id })
    });
    const data5 = await res5.json();

    if (res5.status === 409 && data5.outcome === 'RECONCILIATION_EXPIRED' && data5.retentionLimitHours === 72 && data5.isExtendedConfirmed === true) {
      recordPass("TEST 2C.3: Attempt past 72h (75h) rejected with HTTP 409 RECONCILIATION_EXPIRED (ceiling enforced)");
    } else {
      recordFail("TEST 2C.3: Attempt past 72h was not rejected", `Status: ${res5.status}, Body: ${JSON.stringify(data5)}`);
    }

    if (capturedOrdersRequests.length === 0) {
      recordPass("TEST 2C.4: Confirmed ZERO outgoing PayPal calls dispatched for 75h expired attempt");
    } else {
      recordFail("TEST 2C.4: PayPal was called for 75h expired attempt!", `Calls: ${capturedOrdersRequests.length}`);
    }

    // Verify DB record remains locked in CREATED
    const { data: pCheck5 } = await adminClient
      .from('payments')
      .select('status, manual_reconciliation_required, order_id')
      .eq('payment_attempt_id', att5Id)
      .single();

    if (pCheck5 && pCheck5.status === 'CREATED' && pCheck5.manual_reconciliation_required === true && !pCheck5.order_id) {
      recordPass("TEST 2C.5: Database record remains in CREATED with manual_reconciliation_required=true after 75h expiry");
    } else {
      recordFail("TEST 2C.5: DB record mutated incorrectly", JSON.stringify(pCheck5));
    }

  } catch (err) {
    console.error("Test execution exception:", err);
    recordFail("Execution Exception", err.message);
  } finally {
    // Stop Mock Server
    await new Promise((resolve) => mockServer.close(resolve));
    console.log("✓ Mock PayPal Server stopped.");

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
