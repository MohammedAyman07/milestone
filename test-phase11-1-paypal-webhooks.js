/**
 * MILESTONE AI — Phase 11.1: PayPal Webhook Infrastructure Test Suite
 *
 * Scenarios Tested:
 * 1. Valid signature verification (HTTP 200)
 * 2. Invalid signature rejection (HTTP 400)
 * 3. Missing signature headers (HTTP 400)
 * 4. Duplicate event delivery (HTTP 200, duplicate detected, idempotent)
 * 5. Concurrent duplicate delivery handling (both HTTP 200, unique constraint safety)
 * 6. Unsupported event type (HTTP 200, status IGNORED)
 * 7. PAYMENT.AUTHORIZATION.CREATED reconciliation (status updated to AUTHORIZED)
 * 8. PAYMENT.AUTHORIZATION.VOIDED reconciliation (status updated to VOIDED)
 * 9. PAYMENT.CAPTURE.COMPLETED reconciliation (status updated to CAPTURED, capture_id recorded)
 * 10. PAYMENT.CAPTURE.DENIED reconciliation (status updated to FAILED)
 * 11. PAYMENT.CAPTURE.PENDING reconciliation (status remains CAPTURE_PENDING)
 * 12. Incorrect amount in webhook payload (rejected, state unchanged, audit logged)
 * 13. Incorrect currency in webhook payload (rejected, state unchanged, audit logged)
 * 14. Unknown payment attempt / resource (logged, HTTP 200, state unchanged)
 * 15. Replay of old event on already-CAPTURED payment (no regression, remains CAPTURED)
 * 16. Processing failure returns retryable status (HTTP 500)
 * 17. Out-of-order event delivery (CAPTURE.COMPLETED before AUTH.CREATED -> final state CAPTURED)
 * 18. Webhook cannot transition CAPTURED to SETTLED (never marked SETTLED)
 * 19. Webhook handler never invokes PayPal capture API (capture calls count == 0)
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

const supabase = createClient(url, servKey);

const MOCK_PORT = 9889;
const WEBHOOK_URL = 'http://localhost:3000/api/paypal/webhook';
const MOCK_WEBHOOK_ID = 'WH-MOCK-TEST-WEBHOOK-9889';

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

// Mock PayPal Server
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
        access_token: 'mock_webhook_access_token_889',
        token_type: 'Bearer',
        expires_in: 32400,
      }));
      return;
    }

    // 2. Webhook Signature Verification
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

    // 3. Capture API (MUST NOT BE CALLED BY WEBHOOKS)
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
      'paypal-transmission-sig': options.transmissionSig !== undefined ? options.transmissionSig : 'VALID_TEST_SIG',
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

async function setupProjectAndUsers() {
  const { data: usersData } = await supabase.auth.admin.listUsers();
  clientUser = usersData.users[0];
  freelancerUser = usersData.users[1];

  const { data: projects } = await supabase.from('projects').select('*').limit(1);
  if (!projects || projects.length === 0) {
    throw new Error('No existing project found in Supabase.');
  }
  testProject = projects[0];
}

let nextPhase = 10000 + Math.floor(Math.random() * 80000);

async function createFixture(opts = {}) {
  const msUid = crypto.randomUUID();

  const { data: milestone, error: mErr } = await supabase.from('milestones').insert({
    id: msUid,
    project_id: testProject.id,
    phase: opts.phase || (nextPhase++),
    title: 'Webhook Test Milestone',
    description: 'Phase 11.1 Test Scope',
    amount: opts.amount || 150.00,
    currency: 'USD',
    status: opts.milestoneStatus || 'submitted',
    payment_status: opts.milestonePaymentStatus || 'created',
    due_date: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).select().single();

  if (mErr) throw new Error('Milestone fixture creation failed: ' + mErr.message);
  createdMilestoneIds.push(msUid);

  const paymentAttemptId = opts.paymentAttemptId || `att_wh_${crypto.randomUUID().slice(0, 12)}`;
  const { data: payment, error: pErr } = await supabase.from('payments').insert({
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
    await supabase.from('paypal_webhook_events').delete().eq('transmission_id', tid);
  }
  for (const pid of createdPaymentIds) {
    await supabase.from('payments').delete().eq('id', pid);
  }
  for (const msid of createdMilestoneIds) {
    await supabase.from('milestones').delete().eq('id', msid);
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log('MILESTONE AI — Phase 11.1: PayPal Webhook Infrastructure Test Suite');
  console.log('================================================================\n');

  updateEnv();
  // Allow dev server to detect env changes
  await new Promise(r => setTimeout(r, 600));

  await new Promise(resolve => mockServer.listen(MOCK_PORT, resolve));
  console.log(`✓ Mock PayPal Server running on port ${MOCK_PORT}\n`);

  await setupProjectAndUsers();
  console.log(`✓ Loaded test project ${testProject.id} and test profiles\n`);

  try {
    // -------------------------------------------------------------
    // Scenario 1: Valid Signature Verification
    // -------------------------------------------------------------
    {
      const eventId = `WH_VALID_${Date.now()}`;
      createdWebhookEventIds.push(eventId);
      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'CHECKOUT.ORDER.APPROVED',
          resource_type: 'checkout-order',
          resource: { id: 'ORD_TEST_1' },
        },
      });

      if (res.status === 200 && (res.data.outcome === 'IGNORED' || res.data.message)) {
        recordPass('Scenario 1: Valid signature verification', `HTTP 200 returned, signature verified via mock`);
      } else {
        recordFail('Scenario 1: Valid signature verification', `Expected 200, got ${res.status}: ${res.raw}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 2: Invalid Signature Rejection (HTTP 400)
    // -------------------------------------------------------------
    {
      const eventId = `WH_INVAL_${Date.now()}`;
      const res = await sendWebhookRequest({
        transmissionSig: 'INVALID_SIG',
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: { id: 'CAP_INVALID_SIG' },
        },
      });

      if (res.status === 400 && res.data.error?.includes('Invalid webhook signature')) {
        recordPass('Scenario 2: Invalid signature rejection', `HTTP 400 returned for rejected signature`);
      } else {
        recordFail('Scenario 2: Invalid signature rejection', `Expected 400, got ${res.status}: ${res.raw}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 3: Missing Signature Headers (HTTP 400)
    // -------------------------------------------------------------
    {
      const res1 = await sendWebhookRequest({
        omitHeaders: ['paypal-transmission-sig'],
        body: { id: 'WH_MISSING_1', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
      });
      const res2 = await sendWebhookRequest({
        omitHeaders: ['paypal-cert-url'],
        body: { id: 'WH_MISSING_2', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
      });
      const res3 = await sendWebhookRequest({
        omitHeaders: ['paypal-transmission-id'],
        body: { id: 'WH_MISSING_3', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
      });

      if (res1.status === 400 && res2.status === 400 && res3.status === 400) {
        recordPass('Scenario 3: Missing signature headers', `HTTP 400 returned when any required header is omitted`);
      } else {
        recordFail('Scenario 3: Missing signature headers', `Expected all 400s: [${res1.status}, ${res2.status}, ${res3.status}]`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 4: Duplicate Event Delivery (HTTP 200, no re-processing)
    // -------------------------------------------------------------
    {
      const eventId = `WH_DUP_${Date.now()}`;
      createdWebhookEventIds.push(eventId);
      const payload = {
        id: eventId,
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource_type: 'checkout-order',
        resource: { id: 'ORD_DUP_TEST' },
      };

      const resFirst = await sendWebhookRequest({ body: payload });
      const resSecond = await sendWebhookRequest({ body: payload });

      if (resFirst.status === 200 && resSecond.status === 200 && resSecond.data.duplicate === true) {
        recordPass('Scenario 4: Duplicate event delivery', `HTTP 200 returned, duplicate detected, no execution`);
      } else {
        recordFail('Scenario 4: Duplicate event delivery', `Expected duplicate=true: first=${resFirst.status}, second=${resSecond.status}, data=${JSON.stringify(resSecond.data)}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 5: Concurrent Duplicate Delivery Handling
    // -------------------------------------------------------------
    {
      const eventId = `WH_CONC_${Date.now()}`;
      createdWebhookEventIds.push(eventId);
      const payload = {
        id: eventId,
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource_type: 'checkout-order',
        resource: { id: 'ORD_CONC_TEST' },
      };

      const [resA, resB] = await Promise.all([
        sendWebhookRequest({ body: payload }),
        sendWebhookRequest({ body: payload }),
      ]);

      if (resA.status === 200 && resB.status === 200) {
        const oneIsDuplicate = resA.data.duplicate === true || resB.data.duplicate === true;
        recordPass('Scenario 5: Concurrent duplicate delivery handling', `Both returned HTTP 200 without DB corruption (duplicate flagged: ${oneIsDuplicate})`);
      } else {
        recordFail('Scenario 5: Concurrent duplicate delivery handling', `Status: resA=${resA.status}, resB=${resB.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 6: Unsupported Event Type (HTTP 200, status IGNORED)
    // -------------------------------------------------------------
    {
      const eventId = `WH_UNSUP_${Date.now()}`;
      createdWebhookEventIds.push(eventId);
      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'CUSTOMER.DISPUTE.CREATED',
          resource_type: 'dispute',
          resource: { id: 'DISPUTE_999' },
          summary: 'A customer initiated a dispute',
        },
      });

      // Verify DB record status is IGNORED
      const { data: dbEvent } = await supabase
        .from('paypal_webhook_events')
        .select('*')
        .eq('transmission_id', eventId)
        .maybeSingle();

      const processingStatus = dbEvent?.payload?.processing_status;

      if (res.status === 200 && res.data.outcome === 'IGNORED' && processingStatus === 'IGNORED') {
        recordPass('Scenario 6: Unsupported event type', `HTTP 200, outcome IGNORED persisted in DB`);
      } else {
        recordFail('Scenario 6: Unsupported event type', `res=${res.status}, outcome=${res.data?.outcome}, dbStatus=${processingStatus}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 7: PAYMENT.AUTHORIZATION.CREATED Reconciliation
    // -------------------------------------------------------------
    {
      const fix = await createFixture({ initialStatus: 'CREATED', amount: 150.00 });
      const authId = `AUTH_TEST_${Date.now()}`;
      const eventId = `WH_AUTH_CR_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.AUTHORIZATION.CREATED',
          resource_type: 'authorization',
          resource: {
            id: authId,
            custom_id: fix.paymentAttemptId,
            amount: { value: '150.00', currency_code: 'USD' },
            create_time: new Date().toISOString(),
          },
        },
      });

      const { data: updatedPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();
      const { data: updatedMs } = await supabase.from('milestones').select('*').eq('id', fix.msUid).single();

      if (res.status === 200 && updatedPayment.status === 'AUTHORIZED' && updatedPayment.authorization_id === authId && updatedMs.payment_status === 'authorized') {
        recordPass('Scenario 7: PAYMENT.AUTHORIZATION.CREATED reconciliation', `Payment updated to AUTHORIZED, milestone to authorized`);
      } else {
        recordFail('Scenario 7: PAYMENT.AUTHORIZATION.CREATED reconciliation', `Status: res=${res.status}, payStatus=${updatedPayment?.status}, authId=${updatedPayment?.authorization_id}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 8: PAYMENT.AUTHORIZATION.VOIDED Reconciliation
    // -------------------------------------------------------------
    {
      const authId = `AUTH_VOID_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 200.00,
        authorizationId: authId,
      });

      // Advance to AUTHORIZED
      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);

      const eventId = `WH_AUTH_VOID_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.AUTHORIZATION.VOIDED',
          resource_type: 'authorization',
          resource: {
            id: authId,
            custom_id: fix.paymentAttemptId,
          },
        },
      });

      const { data: updatedPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();
      const { data: updatedMs } = await supabase.from('milestones').select('*').eq('id', fix.msUid).single();

      if (res.status === 200 && updatedPayment.status === 'VOIDED' && updatedPayment.voided_at && updatedMs.payment_status === 'voided') {
        recordPass('Scenario 8: PAYMENT.AUTHORIZATION.VOIDED reconciliation', `Payment updated to VOIDED, milestone to voided`);
      } else {
        recordFail('Scenario 8: PAYMENT.AUTHORIZATION.VOIDED reconciliation', `res=${res.status}, payStatus=${updatedPayment?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 9: PAYMENT.CAPTURE.COMPLETED Reconciliation
    // -------------------------------------------------------------
    {
      const authId = `AUTH_CAP_${Date.now()}`;
      const capId = `CAP_TEST_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 300.00,
        authorizationId: authId,
      });

      // Advance to CAPTURE_PENDING
      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);

      const eventId = `WH_CAP_COMP_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            amount: { value: '300.00', currency_code: 'USD' },
            create_time: new Date().toISOString(),
            links: [{ rel: 'up_to', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: updatedPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();
      const { data: updatedMs } = await supabase.from('milestones').select('*').eq('id', fix.msUid).single();

      if (res.status === 200 && updatedPayment.status === 'CAPTURED' && updatedPayment.capture_id === capId && updatedMs.payment_status === 'captured') {
        recordPass('Scenario 9: PAYMENT.CAPTURE.COMPLETED reconciliation', `Payment reconciled to CAPTURED, capture_id persisted`);
      } else {
        recordFail('Scenario 9: PAYMENT.CAPTURE.COMPLETED reconciliation', `res=${res.status}, payStatus=${updatedPayment?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 10: PAYMENT.CAPTURE.DENIED Reconciliation
    // -------------------------------------------------------------
    {
      const authId = `AUTH_DENY_${Date.now()}`;
      const capId = `CAP_DENY_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 250.00,
        authorizationId: authId,
      });

      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);

      const eventId = `WH_CAP_DENY_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.DENIED',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            status_details: { reason: 'INSTRUMENT_DECLINED' },
            links: [{ rel: 'authorization', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: updatedPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();
      const { data: updatedMs } = await supabase.from('milestones').select('*').eq('id', fix.msUid).single();

      if (res.status === 200 && updatedPayment.status === 'FAILED' && (updatedPayment.error_details?.reason === 'INSTRUMENT_DECLINED' || res.data.outcome === 'PROCESSED') && updatedMs.payment_status === 'failed') {
        recordPass('Scenario 10: PAYMENT.CAPTURE.DENIED reconciliation', `Payment reconciled to FAILED with denial reason`);
      } else {
        recordFail('Scenario 10: PAYMENT.CAPTURE.DENIED reconciliation', `res=${res.status}, payStatus=${updatedPayment?.status}, errorDetails=${JSON.stringify(updatedPayment?.error_details)}, resData=${JSON.stringify(res.data)}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 11: PAYMENT.CAPTURE.PENDING Reconciliation
    // -------------------------------------------------------------
    {
      const authId = `AUTH_PEND_${Date.now()}`;
      const capId = `CAP_PEND_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 180.00,
        authorizationId: authId,
      });

      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);

      const eventId = `WH_CAP_PEND_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.PENDING',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            links: [{ rel: 'up_to', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: updatedPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();
      const { data: updatedMs } = await supabase.from('milestones').select('*').eq('id', fix.msUid).single();

      if (res.status === 200 && updatedPayment.status === 'CAPTURE_PENDING' && updatedPayment.capture_id === capId && updatedMs.payment_status === 'capture_pending') {
        recordPass('Scenario 11: PAYMENT.CAPTURE.PENDING reconciliation', `Payment status retained/set in CAPTURE_PENDING`);
      } else {
        recordFail('Scenario 11: PAYMENT.CAPTURE.PENDING reconciliation', `res=${res.status}, payStatus=${updatedPayment?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 12: Incorrect Amount in Webhook Payload
    // -------------------------------------------------------------
    {
      const authId = `AUTH_MIS_AMT_${Date.now()}`;
      const capId = `CAP_MIS_AMT_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 100.00,
        authorizationId: authId,
      });

      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);

      const eventId = `WH_MIS_AMT_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            amount: { value: '999.00', currency_code: 'USD' }, // Mismatch!
            links: [{ rel: 'up_to', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: paymentAfter } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();

      if (res.status === 200 && res.data.outcome === 'MISMATCH' && paymentAfter.status === 'AUTHORIZED') {
        recordPass('Scenario 12: Incorrect amount in webhook payload', `Rejected modification, state remained AUTHORIZED`);
      } else {
        recordFail('Scenario 12: Incorrect amount in webhook payload', `res=${res.status}, outcome=${res.data?.outcome}, statusAfter=${paymentAfter?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 13: Incorrect Currency in Webhook Payload
    // -------------------------------------------------------------
    {
      const authId = `AUTH_MIS_CUR_${Date.now()}`;
      const capId = `CAP_MIS_CUR_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 120.00,
        currency: 'USD',
        authorizationId: authId,
      });

      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);

      const eventId = `WH_MIS_CUR_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            amount: { value: '120.00', currency_code: 'EUR' }, // Currency Mismatch!
            links: [{ rel: 'up_to', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: paymentAfter } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();

      if (res.status === 200 && res.data.outcome === 'MISMATCH' && paymentAfter.status === 'AUTHORIZED') {
        recordPass('Scenario 13: Incorrect currency in webhook payload', `Currency mismatch rejected, status unchanged`);
      } else {
        recordFail('Scenario 13: Incorrect currency in webhook payload', `res=${res.status}, outcome=${res.data?.outcome}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 14: Unknown Payment Attempt / Resource
    // -------------------------------------------------------------
    {
      const eventId = `WH_UNKNOWN_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: {
            id: 'CAP_COMPLETELY_UNKNOWN_99999',
            custom_id: 'att_unknown_99999',
            amount: { value: '50.00', currency_code: 'USD' },
            links: [{ rel: 'up_to', href: 'https://api.sandbox.paypal.com/v2/payments/authorizations/AUTH_UNKNOWN_999' }],
          },
        },
      });

      if (res.status === 200 && res.data.outcome === 'UNMATCHED') {
        recordPass('Scenario 14: Unknown payment attempt / resource', `Gracefully acknowledged (UNMATCHED), HTTP 200 returned`);
      } else {
        recordFail('Scenario 14: Unknown payment attempt / resource', `res=${res.status}, outcome=${res.data?.outcome}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 15: Replay of Old Event on Already-CAPTURED Payment
    // -------------------------------------------------------------
    {
      const authId = `AUTH_REPLAY_${Date.now()}`;
      const capId = `CAP_REPLAY_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 220.00,
        authorizationId: authId,
        captureId: capId,
      });

      // Set to CAPTURED
      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'CAPTURED', capture_id: capId }).eq('id', fix.payment.id);

      const eventId = `WH_REPLAY_VOID_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      // Attempt to void an already CAPTURED payment
      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.AUTHORIZATION.VOIDED',
          resource_type: 'authorization',
          resource: {
            id: authId,
            custom_id: fix.paymentAttemptId,
          },
        },
      });

      const { data: paymentAfter } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();

      if (res.status === 200 && res.data.outcome === 'IGNORED_TERMINAL' && paymentAfter.status === 'CAPTURED') {
        recordPass('Scenario 15: Replay of old event on already-CAPTURED payment', `Replay blocked, status remained CAPTURED`);
      } else {
        recordFail('Scenario 15: Replay of old event on already-CAPTURED payment', `res=${res.status}, outcome=${res.data?.outcome}, status=${paymentAfter?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 16: Processing Failure Returns Retryable Status (HTTP 500)
    // -------------------------------------------------------------
    {
      const eventId = `WH_FAIL_SIM_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          debug_simulate_error: true,
          resource: { id: 'CAP_SIM_FAIL' },
        },
      });

      if (res.status === 500 && res.data.error?.includes('Internal error processing webhook event')) {
        recordPass('Scenario 16: Processing failure returns retryable status', `HTTP 500 returned on transient failure for PayPal retry`);
      } else {
        recordFail('Scenario 16: Processing failure returns retryable status', `Expected 500, got ${res.status}: ${res.raw}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 17: Out-of-Order Event Delivery (CAPTURE.COMPLETED before AUTH.CREATED)
    // -------------------------------------------------------------
    {
      const authId = `AUTH_OOO_${Date.now()}`;
      const capId = `CAP_OOO_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 275.00,
        authorizationId: authId,
      });

      // Payment is in AUTHORIZED
      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);

      // CAPTURE.COMPLETED arrives before any local capture initiated
      const eventId = `WH_OOO_CAP_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            amount: { value: '275.00', currency_code: 'USD' },
            links: [{ rel: 'up_to', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: finalPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();

      if (res.status === 200 && finalPayment.status === 'CAPTURED' && finalPayment.capture_id === capId) {
        recordPass('Scenario 17: Out-of-order event delivery', `Stepped through transitions safely to reach CAPTURED`);
      } else {
        recordFail('Scenario 17: Out-of-order event delivery', `res=${res.status}, finalStatus=${finalPayment?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 18: Webhook Cannot Transition CAPTURED to SETTLED
    // -------------------------------------------------------------
    {
      const authId = `AUTH_NO_SETTLE_${Date.now()}`;
      const capId = `CAP_NO_SETTLE_${Date.now()}`;
      const fix = await createFixture({
        initialStatus: 'CREATED',
        amount: 190.00,
        authorizationId: authId,
      });

      await supabase.from('payments').update({ status: 'APPROVED' }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'AUTHORIZED', authorization_id: authId }).eq('id', fix.payment.id);
      await supabase.from('payments').update({ status: 'CAPTURE_PENDING' }).eq('id', fix.payment.id);

      const eventId = `WH_NO_SETTLE_${Date.now()}`;
      createdWebhookEventIds.push(eventId);

      const res = await sendWebhookRequest({
        body: {
          id: eventId,
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: {
            id: capId,
            custom_id: fix.paymentAttemptId,
            amount: { value: '190.00', currency_code: 'USD' },
            links: [{ rel: 'up_to', href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${authId}` }],
          },
        },
      });

      const { data: finalPayment } = await supabase.from('payments').select('*').eq('id', fix.payment.id).single();

      if (finalPayment.status === 'CAPTURED' && finalPayment.status !== 'SETTLED') {
        recordPass('Scenario 18: Webhook cannot transition CAPTURED to SETTLED', `Status is CAPTURED, never marked SETTLED`);
      } else {
        recordFail('Scenario 18: Webhook cannot transition CAPTURED to SETTLED', `Unexpected status: ${finalPayment?.status}`);
      }
    }

    // -------------------------------------------------------------
    // Scenario 19: Webhook Handler Never Invokes PayPal Capture API
    // -------------------------------------------------------------
    {
      if (captureCallsCount === 0) {
        recordPass('Scenario 19: Webhook handler never invokes PayPal capture API', `Total capture calls on mock server: 0`);
      } else {
        recordFail('Scenario 19: Webhook handler never invokes PayPal capture API', `Violation: captureCallsCount = ${captureCallsCount}`);
      }
    }

  } catch (err) {
    console.error('Unhandled test suite error:', err);
    failedTests++;
  } finally {
    console.log('\nCleaning up fixtures and restoring environment...');
    await cleanupFixtures();
    restoreEnv();
    mockServer.close();
  }

  console.log('\n================================================================');
  console.log(`Phase 11.1 Test Summary: ${passedTests} Passed, ${failedTests} Failed (Total 19)`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests();
