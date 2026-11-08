# MILESTONE AI — PayPal Sandbox Setup & Configuration Guide

This guide walks you through setting up a **PayPal Developer Sandbox environment** to test payment authorizations, holds, and captures in **MILESTONE AI** without using real funds.

---

## 1. Overview & Architecture

MILESTONE AI uses a 2-step escrow workflow:
1. **Authorization (Order & Hold):** When a client funds a milestone, funds are authorized and placed on hold in the client's PayPal account.
2. **Capture (Release):** Upon successful Gemini AI deliverable verification and client approval, the server captures the authorized funds to the merchant account.

```
[ Client / Buyer ]                 [ MILESTONE AI Server ]                 [ PayPal Sandbox ]
       │                                     │                                     │
       │─── 1. Click "Authorize Payment" ───>│                                     │
       │                                     │─── 2. Orders v2 (intent=AUTHORIZE) >│
       │<── 3. Redirect to Approval URL ─────│<── 4. Returns approval link ────────│
       │                                     │                                     │
       │─── 5. Authenticate & Approve ────────────────────────────────────────────>│
       │                                                                           │
       │<── 6. Redirect to Return URL ─────────────────────────────────────────────│
       │─── 7. Finalize Authorization ──────>│                                     │
       │                                     │─── 8. Authorize Payment (v2) ──────>│
       │                                     │<── 9. Status: AUTHORIZED ───────────│
       │<── 10. Milestone Funded (Escrow) ───│                                     │
```

---

## 2. Prerequisites

- A standard PayPal account (personal or business) to log in to the PayPal Developer Portal.
- Web browser.
- Access to your local MILESTONE AI project repository.

---

## 3. Step-by-Step Setup Instructions

### Step 3.1: Log into PayPal Developer Portal
1. Navigate to [https://developer.paypal.com/dashboard/](https://developer.paypal.com/dashboard/).
2. Click **Log In to Dashboard** in the top right corner and sign in with your standard PayPal credentials.

---

### Step 3.2: Create Sandbox Test Accounts (Buyer & Merchant)

PayPal provides simulated test accounts under **Testing Tools > Sandbox Accounts**:

1. In the left navigation menu, click **Testing Tools** > **Sandbox Accounts**.
2. By default, PayPal automatically creates one **Personal** (buyer) and one **Business** (merchant) account. You may use those or create dedicated ones:
   - **Merchant Account (Platform / Escrow Payee):**
     - Click **Create account**.
     - Select **Business (Merchant)**.
     - Country: **United States** (Recommended for USD MVP).
     - Click **Create account**.
     - View account details (three dots `...` > **View/edit account**): Note the generated email and password.
   - **Buyer Account (Client Testing):**
     - Click **Create account**.
     - Select **Personal (Buyer Account)**.
     - Country: **United States**.
     - Set initial balance: e.g. `$5,000.00 USD`.
     - Click **Create account**.
     - View account details: Note the simulated buyer email and password. You will use these test credentials to approve payments when redirected to the PayPal checkout window.

> [!NOTE]
> All emails and phone numbers generated in the Sandbox are simulated. PayPal will not send real emails or SMS messages.

---

### Step 3.3: Create a REST API Sandbox App

To obtain your `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`:

1. In the left navigation menu, click **Apps & Credentials**.
2. At the top of the page, ensure the toggle is set to **Sandbox** (do NOT select Live).
3. Click the blue **Create App** button.
4. Enter the application details:
   - **App Name:** `MilestoneAI-Sandbox`
   - **App Type:** `Merchant`
   - **Sandbox Business Account:** Select the Business account created in Step 3.2.
5. Click **Create App**.
6. The app details page will open:
   - Copy the **Client ID**.
   - Under **Secret Key**, click **Show** and copy the **Secret Key**.

> [!CAUTION]
> Treat the PayPal Client Secret like a private key. Never commit it to Git, never include it in client-side components (`"use client"`), and never share it in public channels.

---

### Step 3.4: Configure Webhooks (Optional for Initial Local Testing)

If you wish to test real-time PayPal webhook notifications locally:

1. On your app details page under **Sandbox Webhooks**, click **Add Webhook**.
2. **Webhook URL:** Enter your public HTTPS tunneling URL (e.g., via `ngrok` or `localtunnel`):
   ```
   https://<your-ngrok-subdomain>.ngrok-free.app/api/webhooks/paypal
   ```
3. **Event Types:** Select the following events:
   - `Checkout order approved` (`CHECKOUT.ORDER.APPROVED`)
   - `Payment authorization created` (`PAYMENT.AUTHORIZATION.CREATED`)
   - `Payment authorization voided` (`PAYMENT.AUTHORIZATION.VOIDED`)
   - `Payment capture completed` (`PAYMENT.CAPTURE.COMPLETED`)
   - `Payment capture denied` (`PAYMENT.CAPTURE.DENIED`)
   - `Payment capture refunded` (`PAYMENT.CAPTURE.REFUNDED`)
4. Click **Save**.
5. Copy the generated **Webhook ID** displayed in the table.

---

### Step 3.5: Configure Local Environment Variables

Open or create `.env.local` in the project root directory and add the following lines:

```bash
# =============================================================================
# PayPal Sandbox Configuration (Server-Side Only)
# =============================================================================
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_CLIENT_ID=your_sandbox_client_id_here
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret_here
PAYPAL_WEBHOOK_ID=your_sandbox_webhook_id_here

# =============================================================================
# PayPal Orders v2 Idempotency Retention (Server-Side Only)
# =============================================================================
# Default retention is 6 hours. Do NOT set extended confirmation to true
# unless explicitly enabled on your PayPal merchant account by an Account Manager.
PAYPAL_IDEMPOTENCY_RETENTION_HOURS=6
PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=false
```

> [!IMPORTANT]
> - Do NOT add `NEXT_PUBLIC_` prefix to any PayPal variable.
> - Ensure `.env.local` is listed in `.gitignore` (it is already ignored by default).
> - Never switch `PAYPAL_ENVIRONMENT` to `live` without completing legal merchant onboarding and compliance approvals.

---

## 4. Verification Checklist

Before running payment tests in subsequent phases, verify your setup:

1. **Environment:** `PAYPAL_ENVIRONMENT=sandbox` is set in `.env.local`.
2. **Client ID & Secret:** Non-empty values copied from the Sandbox tab in PayPal Developer.
3. **Sandbox Accounts:**
   - Buyer login credentials ready for checkout authentication.
   - Merchant account linked to the Sandbox REST API App.
4. **Currency:** Accounts configured with USD balances (Milestone AI MVP enforces USD check constraints).
5. **Base URL:** The application automatically resolves to `https://api-m.sandbox.paypal.com`.

---

## 5. Troubleshooting Common Issues

| Error / Issue | Cause | Resolution |
|---|---|---|
| `invalid_client` (HTTP 401) | Incorrect Client ID or Client Secret, or using Live credentials in Sandbox. | Verify that credentials in `.env.local` match the **Sandbox** tab of your app in PayPal Developer. |
| `Currency Not Supported` | Attempting to authorize in non-USD currency. | Milestone AI enforces USD-only constraints for financial integrity. Use USD in all test amounts. |
| `BUYER_CANNOT_PAY` | Sandbox buyer account has insufficient balance or unverified status. | In PayPal Developer > Sandbox Accounts, edit the personal account to add funds ($5,000 USD). |
| Webhook signature verification fails | Invalid `PAYPAL_WEBHOOK_ID` or header tampering during tunnel proxying. | Confirm that `PAYPAL_WEBHOOK_ID` in `.env.local` matches the Webhook ID in PayPal Developer dashboard. |

---

## 6. PayPal Orders v2 Idempotency Retention & Account-Level Confirmation

### 6.1 The 6-Hour Default vs. 72-Hour Extension
PayPal's REST APIs use the `PayPal-Request-Id` HTTP header to prevent duplicate order creations and charges.

- **Default PayPal Policy:** PayPal retains idempotency keys for **6 hours (21,600 seconds)** across all standard developer accounts.
- **Extended Retention:** PayPal supports extended idempotency retention of up to **72 hours**, but **ONLY** when explicitly enabled by PayPal engineering for the specific merchant/partner account.
- **Why this matters:** If an uncertain transaction (e.g. timeout during order creation) is replayed after PayPal has purged the idempotency key, PayPal will treat the replay as a **brand-new order**. This can lead to duplicate authorizations and double billing.

### 6.2 Safe Configuration Behavior in MILESTONE AI
MILESTONE AI enforces strict guardrails against accidental double-charging:

1. **Default Window (6 Hours):** Unless confirmed, the system defaults to 6 hours (`PAYPAL_IDEMPOTENCY_RETENTION_HOURS=6`).
2. **Safety Clamping:** If `PAYPAL_IDEMPOTENCY_RETENTION_HOURS` is configured greater than 6 (e.g., 72) while `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=false`, the server logs a warning and **automatically clamps the window to 6 hours**.
3. **Hard Ceiling (72 Hours):** The retention window cannot exceed 72 hours under any setting.
4. **Automated Replay Blocking:** Any uncertain attempt whose age exceeds the active retention window is immediately blocked with HTTP `409 RECONCILIATION_EXPIRED`. The attempt remains safely locked in `CREATED` status with `manual_reconciliation_required = true`, and zero network requests are dispatched to PayPal.

### 6.3 Required Steps Before Enabling 72-Hour Retention
Before setting `PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true` in production:
1. Contact your assigned **PayPal Partner Solutions Engineer** or **Account Manager**.
2. Request a formal confirmation ticket stating that the merchant account has been provisioned with the 72-hour `PayPal-Request-Id` idempotency cache extension.
3. Validate retention behavior in PayPal Sandbox before deploying the environment variable change to production.
4. Update `.env.local` or production environment settings:
   ```bash
   PAYPAL_IDEMPOTENCY_RETENTION_HOURS=72
   PAYPAL_EXTENDED_IDEMPOTENCY_CONFIRMED=true
   ```
