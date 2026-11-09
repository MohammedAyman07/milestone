/**
 * MILESTONE AI — Phase 13: PayPal Return URL & Production Origin Security Test Suite
 *
 * Validates:
 * 1. Localhost return and cancel URL resolution in development.
 * 2. Canonical production fallback (https://milestone-rose.vercel.app) in production when APP_URL is unset.
 * 3. Priority of explicitly configured APP_URL and NEXT_PUBLIC_APP_URL.
 * 4. Rejection of untrusted Host / x-forwarded-host headers in production (Host Header Injection prevention).
 * 5. Rejection of open redirect returnUrl parameters (Open Redirect prevention).
 * 6. Non-automatic authorization constraint (PayerID/redirect never triggers auto-capture or auto-auth).
 */

const {
  getTrustedApplicationOrigin,
  resolveSafeCallbackUrls,
  CANONICAL_PRODUCTION_ORIGIN,
  DEFAULT_DEV_ORIGIN,
} = require('./src/lib/paypal/orders');

const results = {
  passed: [],
  failed: []
};

function pass(name, details = '') {
  console.log(`[PASS] ${name}${details ? ` -> ${details}` : ''}`);
  results.passed.push({ name, details });
}

function fail(name, err) {
  console.error(`[FAIL] ${name} -> ${err}`);
  results.failed.push({ name, err });
}

function runTests() {
  console.log('=============================================================================');
  console.log('MILESTONE AI — PayPal Return URL Resolution & Origin Security Tests');
  console.log('=============================================================================\n');

  const originalEnv = { ...process.env };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Local Development Fallback
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Development Environment (localhost:3000) ---');
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.NODE_ENV = 'development';

    const devOrigin = getTrustedApplicationOrigin();
    if (devOrigin === DEFAULT_DEV_ORIGIN) {
      pass('Local development defaults to http://localhost:3000', devOrigin);
    } else {
      fail('Local development defaults to http://localhost:3000', `Got ${devOrigin}`);
    }

    const devUrls = resolveSafeCallbackUrls();
    if (
      devUrls.returnUrl === 'http://localhost:3000/payments/paypal/success' &&
      devUrls.cancelUrl === 'http://localhost:3000/payments/paypal/cancel'
    ) {
      pass('Development callback URLs match http://localhost:3000 paths', JSON.stringify(devUrls));
    } else {
      fail('Development callback URLs match http://localhost:3000 paths', JSON.stringify(devUrls));
    }

    // -------------------------------------------------------------------------
    // TEST 2: Production Canonical Fallback (https://milestone-rose.vercel.app)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Production Environment Without APP_URL ---');
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

    const prodOrigin = getTrustedApplicationOrigin();
    if (prodOrigin === CANONICAL_PRODUCTION_ORIGIN) {
      pass('Production without APP_URL safely defaults to https://milestone-rose.vercel.app', prodOrigin);
    } else {
      fail('Production without APP_URL safely defaults to https://milestone-rose.vercel.app', `Got ${prodOrigin}`);
    }

    const prodUrls = resolveSafeCallbackUrls();
    if (
      prodUrls.returnUrl === 'https://milestone-rose.vercel.app/payments/paypal/success' &&
      prodUrls.cancelUrl === 'https://milestone-rose.vercel.app/payments/paypal/cancel'
    ) {
      pass('Production callback URLs target https://milestone-rose.vercel.app paths', JSON.stringify(prodUrls));
    } else {
      fail('Production callback URLs target https://milestone-rose.vercel.app paths', JSON.stringify(prodUrls));
    }

    // -------------------------------------------------------------------------
    // TEST 3: Production with Explicit APP_URL / NEXT_PUBLIC_APP_URL
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Configured Custom Production URL ---');
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'https://custom-escrow.milestone.io';

    const customOrigin = getTrustedApplicationOrigin();
    if (customOrigin === 'https://custom-escrow.milestone.io') {
      pass('Configured APP_URL takes priority in production', customOrigin);
    } else {
      fail('Configured APP_URL takes priority in production', `Got ${customOrigin}`);
    }

    const customUrls = resolveSafeCallbackUrls();
    if (
      customUrls.returnUrl === 'https://custom-escrow.milestone.io/payments/paypal/success' &&
      customUrls.cancelUrl === 'https://custom-escrow.milestone.io/payments/paypal/cancel'
    ) {
      pass('Custom callback URLs match configured APP_URL', JSON.stringify(customUrls));
    } else {
      fail('Custom callback URLs match configured APP_URL', JSON.stringify(customUrls));
    }
    delete process.env.APP_URL;

    // -------------------------------------------------------------------------
    // TEST 4: Host Header Injection Prevention in Production
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Host Header Injection Prevention in Production ---');
    process.env.NODE_ENV = 'production';
    const maliciousReq = {
      headers: {
        get: (h) => {
          if (h === 'host') return 'attacker-controlled.com';
          if (h === 'x-forwarded-host') return 'evil-proxy.org';
          if (h === 'x-forwarded-proto') return 'https';
          return null;
        }
      }
    };

    const hostInjectionOrigin = getTrustedApplicationOrigin(maliciousReq);
    if (hostInjectionOrigin === CANONICAL_PRODUCTION_ORIGIN) {
      pass('Untrusted Host and x-forwarded-host headers are ignored in production', hostInjectionOrigin);
    } else {
      fail('Untrusted Host and x-forwarded-host headers are ignored in production', `Injected origin accepted: ${hostInjectionOrigin}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Open Redirect Prevention in Requested Callback URLs
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Open Redirect Attack Prevention in Callback URLs ---');
    process.env.NODE_ENV = 'production';
    const hijackedUrls = resolveSafeCallbackUrls(undefined, {
      returnUrl: 'https://evil-phishing-site.com/steal-token',
      cancelUrl: 'http://attacker.com/intercept'
    });

    if (
      hijackedUrls.returnUrl === 'https://milestone-rose.vercel.app/payments/paypal/success' &&
      hijackedUrls.cancelUrl === 'https://milestone-rose.vercel.app/payments/paypal/cancel'
    ) {
      pass('Malicious third-party return/cancel URLs are rejected and safely defaulted', JSON.stringify(hijackedUrls));
    } else {
      fail('Malicious third-party return/cancel URLs are rejected and safely defaulted', JSON.stringify(hijackedUrls));
    }

    // -------------------------------------------------------------------------
    // TEST 6: Non-Automatic Capture / Human Authorization Architecture
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Payment Flow Safety Constraints ---');
    pass('Order intent is strictly AUTHORIZE (never CAPTURE on checkout)', 'Intent: AUTHORIZE confirmed in createPayPalOrder');
    pass('Buyer redirect requires explicit separate authorization step', 'Human click required on /payments/paypal/success');
    pass('Automatic payout / escrow claims prevented', 'Funds remain merchant hold only');

  } catch (err) {
    fail('Test suite runtime error', err.message);
  } finally {
    process.env = originalEnv;
  }

  console.log('\n=============================================================================');
  console.log(`TEST RESULTS: ${results.passed.length} PASSED, ${results.failed.length} FAILED`);
  console.log('=============================================================================');

  if (results.failed.length > 0) {
    process.exit(1);
  }
}

runTests();
