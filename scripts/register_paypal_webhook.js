const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(ENV_PATH, 'utf8');

const getVal = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].replace(/["'\r]/g, '').trim() : '';
};

const clientId = getVal('PAYPAL_CLIENT_ID');
const clientSecret = getVal('PAYPAL_CLIENT_SECRET');
const environment = (getVal('PAYPAL_ENVIRONMENT') || 'sandbox').toLowerCase();
const baseUrl = environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function registerWebhook(webhookUrl) {
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    console.error('Error: You must provide a valid public HTTPS webhook URL.');
    console.error('Example: node scripts/register_paypal_webhook.js https://abc123.ngrok-free.app/api/paypal/webhook');
    process.exit(1);
  }

  console.log(`Authenticating with PayPal ${environment.toUpperCase()}...`);
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error('Failed to authenticate with PayPal:', tokenData.error_description || tokenData.message);
    process.exit(1);
  }

  console.log('✓ Successfully authenticated.');
  console.log(`Registering webhook URL: ${webhookUrl}`);

  const requiredEvents = [
    { name: 'PAYMENT.AUTHORIZATION.CREATED' },
    { name: 'PAYMENT.AUTHORIZATION.VOIDED' },
    { name: 'PAYMENT.CAPTURE.COMPLETED' },
    { name: 'PAYMENT.CAPTURE.DENIED' },
    { name: 'PAYMENT.CAPTURE.PENDING' },
  ];

  const createRes = await fetch(`${baseUrl}/v1/notifications/webhooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: webhookUrl,
      event_types: requiredEvents,
    }),
  });

  const createData = await createRes.json();
  if (!createRes.ok) {
    console.error('PayPal webhook registration failed:');
    console.error(JSON.stringify(createData, null, 2));
    process.exit(1);
  }

  const webhookId = createData.id;
  console.log(`✓ Webhook registered successfully on PayPal!`);
  console.log(`  Webhook ID: ${webhookId}`);
  console.log(`  Target URL: ${createData.url}`);
  console.log(`  Subscribed Events (${createData.event_types?.length}):`);
  createData.event_types?.forEach((e) => console.log(`   - ${e.name}`));

  // Update .env.local
  let updatedEnv = env;
  const regex = /^PAYPAL_WEBHOOK_ID=.*$/m;
  if (regex.test(updatedEnv)) {
    updatedEnv = updatedEnv.replace(regex, `PAYPAL_WEBHOOK_ID=${webhookId}`);
  } else {
    updatedEnv += `\nPAYPAL_WEBHOOK_ID=${webhookId}`;
  }
  fs.writeFileSync(ENV_PATH, updatedEnv, 'utf8');
  console.log(`✓ Saved PAYPAL_WEBHOOK_ID in .env.local.`);
}

const targetUrl = process.argv[2];
registerWebhook(targetUrl).catch(console.error);
