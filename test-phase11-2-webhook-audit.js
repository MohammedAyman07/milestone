/**
 * MILESTONE AI — Phase 11.2: PayPal Webhook Security & Reliability Audit Test Suite
 *
 * Audit Scope:
 * 1. Live Supabase Database Verification (Existence, Columns, Unique Constraint, RLS / Non-Privileged Rejection)
 * 2. Event Ordering & Backward Transition Guards (CAPTURE.COMPLETED followed by AUTH.CREATED, CAPTURE.PENDING, CAPTURE.DENIED, AUTH.VOIDED)
 * 3. Terminal State Immutability (CAPTURED never transitions backwards; SETTLED never inferred)
 * 4. Processing Reliability & Redelivery Retry Recovery (Failed events can be retried upon redelivery)
 * 5. Concurrent In-Flight Execution Guard (Unique constraint safety and duplicate protection)
 * 6. Signature Verification Fail-Closed Security & Certificate URL Validation
 * 7. Live PayPal Sandbox Integration & OAuth2 Verification
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ENV_PATH = path.join(__dirname, '.env.local');
const cleanEnvBackup = fs.readFileSync(ENV_PATH, 'utf8');

let url = '', servKey = '', anonKey = '';
let savedClientId = '', savedClientSecret = '';
cleanEnvBackup.split('\n').forEach(line => {
  const t = line.trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) url = t.split('=')[1].replace(/["'\r]/g, '').trim();
  if (t.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) servKey = t.split('=')[1].replace(/["'\r]/g, '').trim();
  if (t.startsWith('NEXT_PUBLIC_SUPABASE_ANON_KEY=')) anonKey = t.split('=')[1].replace(/["'\r]/g, '').trim();
  if (t.startsWith('PAYPAL_CLIENT_ID=')) savedClientId = t.split('=')[1].replace(/["'\r]/g, '').trim();
  if (t.startsWith('PAYPAL_CLIENT_SECRET=')) savedClientSecret = t.split('=')[1].replace(/["'\r]/g, '').trim();
});

const admin = createClient(url, servKey);
const anon = createClient(url, anonKey);

const MOCK_PORT = 9887;
const WEBHOOK_URL = 'http://localhost:3000/api/paypal/webhook';
const MOCK_WEBHOOK_ID = '85885233K9773200T';

let captureCallsCount = 0;
let verifyCallsCount = 0;

function updateEnv(overrides = {}) {
  let content = cleanEnvBackup || '';
  const merged = {
    PAYPAL_BASE_URL: `http://localhost:${MOCK_PORT}`,
    PAYPAL_WEBHOOK_ID: MOCK_WEBHOOK_ID,
    ...overrides,
  };
  for (const [key, val] of Object.entries(merged)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function restoreEnv() {
  if (cleanEnvBackup) {
    fs.writeFileSync(ENV_PATH, cleanEnvBackup, 'utf8');
  }
}

// Mock PayPal Server for controlled signature and capture tracking
const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString();
    let parsedBody = {};
    try { if (rawBody) parsedBody = JSON.parse(rawBody); } catch {}

    // OAuth2 Token
    if (req.url === '/v1/oauth2/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'mock_webhook_audit_token_9887',
        token_type: 'Bearer',
        expires_in: 32400,
      }));
      return;
    }

    // Signature Verification Endpoint
    if (req.url === '/v1/notifications/verify-webhook-signature' && req.method === 'POST') {
      verifyCallsCount++;
      const sig = parsedBody.transmission_sig;
      if (sig === 'INVALID_SIG') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ verification_status: 'FAILURE' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verification_status: 'SUCCESS' }));
      return;
    }

    // Capture Endpoint (Must NOT be called by webhooks)
    if (req.url.includes('/capture') && req.method === 'POST') {
      captureCallsCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'COMPLETED' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found on mock' }));
  });
});

let passedTests = 0;
let failedTests = 0;

function recordPass(testName, detail = '') {
  console.log(`✓ [PASS] ${testName}${detail ? ` -> ${detail}` : ''}`);
  passedTests++;
}

function recordFail(testName, error) {
  console.error(`✗ [FAIL] ${testName}: ${error}`);
  failedTests++;
}

function sendWebhookRequest(options = {}) {
  return new Promise((resolve, reject) => {
    const payloadStr = JSON.stringify(options.body || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadStr),
      'paypal-transmission-id': options.transmissionId || `trans_${crypto.randomUUID()}`,
      'paypal-transmission-time': options.transmissionTime || new Date().toISOString(),
      'paypal-cert-url': options.certUrl || `http://localhost:${MOCK_PORT}/cert.pem`,
      'paypal-auth-algo': options.authAlgo || 'SHA256withRSA',
      'paypal-transmission-sig': options.transmissionSig !== undefined ? options.transmissionSig : 'VALID_AUDIT_SIG',
      ...(options.extraHeaders || {}),
    };

    if (options.omitHeaders) {
      options.omitHeaders.forEach(h => delete headers[h]);
    }

    const req = http.request(WEBHOOK_URL, {
      method: 'POST',
      headers,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = {};
        try { if (data) json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, data: json, raw: data });
      });
    });

    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });
}

// Fixture helpers
const createdMilestoneIds = [];
const createdPaymentIds = [];
const createdWebhookEventIds = [];

let testProject = null;
let clientUser = null;
let freelancerUser = null;
let nextPhase = 50000 + Math.floor(Math.random() * 40000);

async function setupProjectAndUsers() {
  const { data: usersData } = await admin.auth.admin.listUsers();
  clientUser = usersData.users[0];
  freelancerUser = usersData.users[1];

  const { data: projects } = await admin.from('projects').select('*').limit(1);
  if (!projects || projects.length === 0) {
    throw new Error('No existing project found in Supabase.');
  }
  testProject = projects[0];
}

async function createFixture(opts = {}) {
  const msUid = crypto.randomUUID();

  const { data: milestone, error: mErr } = await admin.from('milestones').insert({
    id: msUid,
    project_id: testProject.id,
    phase: opts.phase || (nextPhase++),
    title: 'Audit Webhook Milestone',
    description: 'Phase 11.2 Audit Scope',
    amount: opts.amount || 150.00,
    currency: 'USD',
    status: opts.milestoneStatus || 'submitted',
    payment_status: opts.milestonePaymentStatus || 'created',
    due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).select().single();

  if (mErr) throw new Error('Milestone fixture creation failed: ' + mErr.message);
  createdMilestoneIds.push(msUid);

  const paymentAttemptId = opts.paymentAttemptId || `att_audit_${crypto.randomUUID().slice(0, 12)}`;
  const { data: payment, error: pErr } = await admin.from('payments').insert({
    milestone_id: msUid,
    project_id: testProject.id,
    payer_id: clientUser.id,
    payee_id: freelancerUser.id,
    amount: opts.amount || 150.00,
    currency: 'USD',
    payment_type: 'order',
    status: opts.initialStatus || 'CREATED',
    payment_attempt_id: paymentAttemptId,
    attempt_number: 1,
    order_id: opts.orderId || `ORD_${crypto.randomUUID().slice(0, 10)}`,
    authorization_id: opts.authorizationId || null,
    capture_id: opts.captureId || null,
    idempotency_order_create: `ord_create_${paymentAttemptId}`,
    idempotency_order_auth: `ord_auth_${paymentAttemptId}`,
    idempotency_auth_capture: `auth_cap_${paymentAttemptId}`,
    idempotency_refund: `refund_${paymentAttemptId}`,
  }).select().single();

  if (pErr) throw new Error('Payment fixture creation failed: ' + pErr.message);
  createdPaymentIds.push(payment.id);

  return { msUid, payment, paymentAttemptId };
}

async function cleanupFixtures() {
  for (const tid of createdWebhookEventIds) {
    await admin.from('paypal_webhook_events').delete().eq('transmission_id', tid);
  }
  for (const pid of createdPaymentIds) {
    await admin.from('payments').delete().eq('id', pid);
  }
  for (const msid of createdMilestoneIds) {
    await admin.from('milestones').delete().eq('id', msid);
  }
}

async function runAuditSuite() {
  console.log('=============================================================================');
  console.log('MILESTONE AI — Phase 11.2: PayPal Webhook Security & Reliability Audit');
  console.log('=============================================================================\n');

  updateEnv();
  await new Promise(r => setTimeout(r, 600));

  await new Promise(resolve => mockServer.listen(MOCK_PORT, resolve));
  console.log(`✓ Mock PayPal Server running on port ${MOCK_PORT}`);

  await setupProjectAndUsers();
  console.log(`✓ Loaded test project ${testProject.id}\n`);

  try {
    // -------------------------------------------------------------------------
    // 1. LIVE SUPABASE DATABASE VERIFICATION
    // -------------------------------------------------------------------------
    console.log('--- 1. Auditing Live Supabase Database ---');
    const testProbeId = `probe_live_${Date.now()}`;
    const nowIso = new Date().toISOString();

    const insertProbe = await admin.from('paypal_webhook_events').insert({
      transmission_id: testProbeId,
      event_type: 'AUDIT.LIVE.PROBE',
      resource_id: 'res_probe_1',
      resource_type: 'probe',
      event_timestamp: nowIso,
      signature_verified: true,
      verification_status: 'VERIFIED',
      verified_at: nowIso,
      payload: { processing_status: 'PROCESSING' },
    }).select().single();

    if (!insertProbe.error && insertProbe.data) {
      const actualCols = Object.keys(insertProbe.data);
      const expectedCols = [
        'id', 'transmission_id', 'event_type', 'resource_id', 'resource_type',
        'event_timestamp', 'signature_verified', 'verification_status', 'verified_at',
        'payload', 'processed_at'
      ];
      const allColsMatch = expectedCols.every(c => actualCols.includes(c));

      if (allColsMatch) {
        recordPass('Database Audit 1A: Table existence & columns', `All 11 required columns verified on live database`);
      } else {
        recordFail('Database Audit 1A: Table existence & columns', `Missing columns: actual=${actualCols.join(',')}`);
      }

      // Test UNIQUE constraint
      const dupInsert = await admin.from('paypal_webhook_events').insert({
        transmission_id: testProbeId,
        event_type: 'AUDIT.DUP',
        resource_id: 'res_dup',
        resource_type: 'probe',
        event_timestamp: nowIso,
      });

      if (dupInsert.error && dupInsert.error.code === '23505') {
        recordPass('Database Audit 1B: PostgreSQL UNIQUE constraint', `Rejected with code 23505: ${dupInsert.error.message}`);
      } else {
        recordFail('Database Audit 1B: PostgreSQL UNIQUE constraint', `Expected 23505 error, got: ${JSON.stringify(dupInsert.error)}`);
      }

      // Test Anonymous User Permissions
      const anonSelect = await anon.from('paypal_webhook_events').select('*').limit(1);
      const anonInsert = await anon.from('paypal_webhook_events').insert({
        transmission_id: `anon_${Date.now()}`,
        event_type: 'HACK',
        resource_id: 'hack',
        resource_type: 'hack',
        event_timestamp: nowIso,
      });

      if (anonSelect.error && anonInsert.error) {
        recordPass('Database Audit 1C: Anonymous access blocked', `RLS/Privileges revoked: select=${anonSelect.error.message}, insert=${anonInsert.error.message}`);
      } else {
        recordFail('Database Audit 1C: Anonymous access blocked', `Anon was not blocked!`);
      }

      // Clean up probe
      await admin.from('paypal_webhook_events').delete().eq('transmission_id', testProbeId);
    } else {
      recordFail('Database Audit 1A: Table existence & columns', insertProbe.error?.message || 'Insert failed');
    }

    // -------------------------------------------------------------------------
    // 2. EVENT ORDERING & BACKWARD TRANSITION PREVENTION
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Auditing Event Ordering & State Immutability ---');

    // Case 2A: CAPTURE.COMPLETED followed by AUTHORIZATION.CREATED
    {
      const authId = `AUTH_ORD_A_${Date.now()}`;
      const capId = `CAP_ORD_A_${Date.now()}`;
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 200.00, authorizationId: authId });

      // Bring to CAPTURED
      await admin.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURED', capture_id: capId }).eq('id', fix.payment.id);

      const evtId = `WH_ORD_A_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      const res = await sendWebhookRequest({
        body: {
          id: evtId,
          event_type: 'PAYMENT.AUTHORIZATION.CREATED',
          resource_type: 'authorization',
          resource: { id: authId, custom_id: fix.paymentAttemptId, amount: { value: '200.00', currency_code: 'USD' } },
        },
      });

      const { data: pAfter } = await admin.from('payments').select('status').eq('id', fix.payment.id).single();
      if (res.status === 200 && res.data.outcome === 'IGNORED_TERMINAL' && pAfter.status === 'CAPTURED') {
        recordPass('Event Ordering 2A: CAPTURE.COMPLETED followed by AUTHORIZATION.CREATED', `Payment remained CAPTURED; did NOT regress to AUTHORIZED`);
      } else {
        recordFail('Event Ordering 2A: CAPTURE.COMPLETED followed by AUTHORIZATION.CREATED', `outcome=${res.data?.outcome}, statusAfter=${pAfter?.status}`);
      }
    }

    // Case 2B: CAPTURE.COMPLETED followed by CAPTURE.PENDING
    {
      const authId = `AUTH_ORD_B_${Date.now()}`;
      const capId = `CAP_ORD_B_${Date.now()}`;
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 175.00, authorizationId: authId });

      await admin.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURED', capture_id: capId }).eq('id', fix.payment.id);

      const evtId = `WH_ORD_B_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      const res = await sendWebhookRequest({
        body: {
          id: evtId,
          event_type: 'PAYMENT.CAPTURE.PENDING',
          resource_type: 'capture',
          resource: { id: capId, custom_id: fix.paymentAttemptId, links: [{ rel: 'up_to', href: `/v2/payments/authorizations/${authId}` }] },
        },
      });

      const { data: pAfter } = await admin.from('payments').select('status').eq('id', fix.payment.id).single();
      if (res.status === 200 && res.data.outcome === 'IGNORED_TERMINAL' && pAfter.status === 'CAPTURED') {
        recordPass('Event Ordering 2B: CAPTURE.COMPLETED followed by CAPTURE.PENDING', `Payment remained CAPTURED; did NOT regress to CAPTURE_PENDING`);
      } else {
        recordFail('Event Ordering 2B: CAPTURE.COMPLETED followed by CAPTURE.PENDING', `outcome=${res.data?.outcome}, statusAfter=${pAfter?.status}`);
      }
    }

    // Case 2C: CAPTURE.COMPLETED followed by CAPTURE.DENIED
    {
      const authId = `AUTH_ORD_C_${Date.now()}`;
      const capId = `CAP_ORD_C_${Date.now()}`;
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 210.00, authorizationId: authId });

      await admin.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURED', capture_id: capId }).eq('id', fix.payment.id);

      const evtId = `WH_ORD_C_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      const res = await sendWebhookRequest({
        body: {
          id: evtId,
          event_type: 'PAYMENT.CAPTURE.DENIED',
          resource_type: 'capture',
          resource: { id: capId, custom_id: fix.paymentAttemptId, status_details: { reason: 'CARD_DECLINED' }, links: [{ rel: 'authorization', href: `/v2/payments/authorizations/${authId}` }] },
        },
      });

      const { data: pAfter } = await admin.from('payments').select('status').eq('id', fix.payment.id).single();
      if (res.status === 200 && res.data.outcome === 'IGNORED_TERMINAL' && pAfter.status === 'CAPTURED') {
        recordPass('Event Ordering 2C: CAPTURE.COMPLETED followed by CAPTURE.DENIED', `Payment remained CAPTURED; did NOT regress to FAILED`);
      } else {
        recordFail('Event Ordering 2C: CAPTURE.COMPLETED followed by CAPTURE.DENIED', `outcome=${res.data?.outcome}, statusAfter=${pAfter?.status}`);
      }
    }

    // Case 2D: AUTHORIZATION.VOIDED after CAPTURED
    {
      const authId = `AUTH_ORD_D_${Date.now()}`;
      const capId = `CAP_ORD_D_${Date.now()}`;
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 320.00, authorizationId: authId });

      await admin.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURED', capture_id: capId }).eq('id', fix.payment.id);

      const evtId = `WH_ORD_D_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      const res = await sendWebhookRequest({
        body: {
          id: evtId,
          event_type: 'PAYMENT.AUTHORIZATION.VOIDED',
          resource_type: 'authorization',
          resource: { id: authId, custom_id: fix.paymentAttemptId },
        },
      });

      const { data: pAfter } = await admin.from('payments').select('status').eq('id', fix.payment.id).single();
      if (res.status === 200 && res.data.outcome === 'IGNORED_TERMINAL' && pAfter.status === 'CAPTURED') {
        recordPass('Event Ordering 2D: AUTHORIZATION.VOIDED after CAPTURED', `Payment remained CAPTURED; did NOT regress to VOIDED`);
      } else {
        recordFail('Event Ordering 2D: AUTHORIZATION.VOIDED after CAPTURED', `outcome=${res.data?.outcome}, statusAfter=${pAfter?.status}`);
      }
    }

    // Case 2E: SETTLED is NEVER inferred from CAPTURE.COMPLETED
    {
      const authId = `AUTH_NO_SETTLE_${Date.now()}`;
      const capId = `CAP_NO_SETTLE_${Date.now()}`;
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 160.00, authorizationId: authId });

      await admin.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);

      const evtId = `WH_NO_SETTLE_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      const res = await sendWebhookRequest({
        body: {
          id: evtId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: { id: capId, custom_id: fix.paymentAttemptId, amount: { value: '160.00', currency_code: 'USD' }, links: [{ rel: 'up_to', href: `/v2/payments/authorizations/${authId}` }] },
        },
      });

      const { data: pAfter } = await admin.from('payments').select('status').eq('id', fix.payment.id).single();
      if (res.status === 200 && pAfter.status === 'CAPTURED' && pAfter.status !== 'SETTLED') {
        recordPass('Event Ordering 2E: SETTLED never inferred from capture', `Status is strictly CAPTURED (merchant settlement is distinct from freelancer payout)`);
      } else {
        recordFail('Event Ordering 2E: SETTLED never inferred from capture', `Status: ${pAfter?.status}`);
      }
    }

    // -------------------------------------------------------------------------
    // 3. EVENT PROCESSING RELIABILITY & REDELIVERY RETRY RECOVERY
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Auditing Processing Reliability & Retry Recovery ---');

    // Case 3A: Event is stored in DB BEFORE processing
    {
      const evtId = `WH_STORE_FIRST_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      // Trigger simulated transient error
      const res = await sendWebhookRequest({
        body: {
          id: evtId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          debug_simulate_error: true,
          resource: { id: 'CAP_STORE_TEST' },
        },
      });

      // Verify event record was persisted in database despite processing failure
      const { data: dbEvt } = await admin
        .from('paypal_webhook_events')
        .select('*')
        .eq('transmission_id', evtId)
        .maybeSingle();

      if (res.status === 500 && dbEvt && dbEvt.payload?.processing_status === 'FAILED') {
        recordPass('Reliability 3A: Events persisted before processing', `HTTP 500 returned, event persisted in DB with status=FAILED`);
      } else {
        recordFail('Reliability 3A: Events persisted before processing', `res=${res.status}, dbEvt=${JSON.stringify(dbEvt)}`);
      }
    }

    // Case 3B: Redelivery of previously failed event is retried (NOT discarded as duplicate)
    {
      const authId = `AUTH_RETRY_REC_${Date.now()}`;
      const capId = `CAP_RETRY_REC_${Date.now()}`;
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 130.00, authorizationId: authId });

      await admin.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await admin.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);

      const evtId = `WH_RETRY_EVT_${Date.now()}`;
      createdWebhookEventIds.push(evtId);

      const payload = {
        id: evtId,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource_type: 'capture',
        resource: {
          id: capId,
          custom_id: fix.paymentAttemptId,
          amount: { value: '130.00', currency_code: 'USD' },
          links: [{ rel: 'up_to', href: `/v2/payments/authorizations/${authId}` }],
        },
      };

      // 1st delivery: simulate transient error
      const res1 = await sendWebhookRequest({
        body: { ...payload, debug_simulate_error: true },
      });

      // Verify DB event status is FAILED
      const { data: dbEvt1 } = await admin.from('paypal_webhook_events').select('*').eq('transmission_id', evtId).single();

      // 2nd delivery (PayPal redelivery of the same event without simulated failure):
      const res2 = await sendWebhookRequest({ body: payload });

      const { data: dbEvt2 } = await admin.from('paypal_webhook_events').select('*').eq('transmission_id', evtId).single();
      const { data: pAfter } = await admin.from('payments').select('status, capture_id').eq('id', fix.payment.id).single();

      if (res1.status === 500 && res2.status === 200 && dbEvt2.payload?.processing_status === 'PROCESSED' && pAfter.status === 'CAPTURED') {
        recordPass('Reliability 3B: Redelivery of failed event retries successfully', `First returned 500, second redelivery retried and completed reconciliation to CAPTURED`);
      } else {
        recordFail('Reliability 3B: Redelivery of failed event retries successfully', `res1=${res1.status}, res2=${res2.status}, dbStatus=${dbEvt2?.payload?.processing_status}, payStatus=${pAfter?.status}`);
      }
    }

    // -------------------------------------------------------------------------
    // 4. SIGNATURE VERIFICATION FAIL-CLOSED & SECURITY GUARDS
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Auditing Signature Verification & Security Guards ---');

    // Case 4A: Missing transmission headers
    {
      const res = await sendWebhookRequest({ omitHeaders: ['paypal-transmission-sig'] });
      if (res.status === 400 && res.data.error?.includes('Missing required PayPal webhook headers')) {
        recordPass('Security 4A: Missing headers fail closed', `HTTP 400 Bad Request`);
      } else {
        recordFail('Security 4A: Missing headers fail closed', `status=${res.status}`);
      }
    }

    // Case 4B: Malformed / non-HTTPS cert URL rejected
    {
      const res = await sendWebhookRequest({ certUrl: 'http://evil.com/fake_cert.pem' });
      if (res.status === 400 && res.data.error?.includes('Invalid certificate URL')) {
        recordPass('Security 4B: Non-HTTPS / untrusted cert URL rejected', `HTTP 400 Bad Request`);
      } else {
        recordFail('Security 4B: Non-HTTPS / untrusted cert URL rejected', `status=${res.status}, res=${res.raw}`);
      }
    }

    // Case 4C: Invalid signature fails closed
    {
      const res = await sendWebhookRequest({ transmissionSig: 'INVALID_SIG' });
      if (res.status === 400 && res.data.error?.includes('Invalid webhook signature')) {
        recordPass('Security 4C: Invalid signature fails closed', `HTTP 400 Bad Request`);
      } else {
        recordFail('Security 4C: Invalid signature fails closed', `status=${res.status}`);
      }
    }

    // -------------------------------------------------------------------------
    // 5. LIVE PAYPAL SANDBOX INTEGRATION AUDIT
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Auditing Live PayPal Sandbox Environment ---');
    try {
      const auth = Buffer.from(`${savedClientId}:${savedClientSecret}`).toString('base64');
      const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        recordPass('PayPal Sandbox 5A: OAuth2 Client Credentials', `Access token generated successfully (App ID: ${tokenData.app_id || 'valid'})`);

        // Query registered webhooks on PayPal Sandbox
        const listRes = await fetch('https://api-m.sandbox.paypal.com/v1/notifications/webhooks', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (listRes.ok) {
          const listData = await listRes.json();
          const registeredWebhooks = listData.webhooks || [];
          recordPass('PayPal Sandbox 5B: Webhook Registration Query', `Queried PayPal Sandbox: ${registeredWebhooks.length} webhooks currently registered`);

          // Test PayPal's official signature verification API with live token
          const liveVerifyRes = await fetch('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              auth_algo: 'SHA256withRSA',
              cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-39c05e19',
              transmission_id: 'audit_test_transmission_id',
              transmission_sig: 'dummy_invalid_signature',
              transmission_time: new Date().toISOString(),
              webhook_id: '85885233K9773200T',
              webhook_event: { id: 'WH-AUDIT-123', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
            }),
          });

          const liveVerifyData = await liveVerifyRes.json();
          if (liveVerifyRes.ok && liveVerifyData.verification_status === 'FAILURE') {
            recordPass('PayPal Sandbox 5C: Live Signature Verification Endpoint', `PayPal returned verification_status=FAILURE for invalid signature (fails closed as expected)`);
          } else {
            recordFail('PayPal Sandbox 5C: Live Signature Verification Endpoint', `Status: ${liveVerifyRes.status}, Body: ${JSON.stringify(liveVerifyData)}`);
          }
        } else {
          recordFail('PayPal Sandbox 5B: Webhook Registration Query', `Status: ${listRes.status}`);
        }
      } else {
        recordFail('PayPal Sandbox 5A: OAuth2 Client Credentials', `Token request failed: ${tokenRes.status}`);
      }
    } catch (sbxErr) {
      recordFail('PayPal Sandbox Audit: Live API call failed', sbxErr.message);
    }

  } catch (err) {
    console.error('Unhandled audit suite error:', err);
    failedTests++;
  } finally {
    console.log('\nCleaning up audit fixtures and restoring environment...');
    await cleanupFixtures();
    restoreEnv();
    mockServer.close();
  }

  console.log('\n=============================================================================');
  console.log(`Phase 11.2 Audit Test Summary: ${passedTests} Passed, ${failedTests} Failed`);
  console.log('=============================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAuditSuite();
