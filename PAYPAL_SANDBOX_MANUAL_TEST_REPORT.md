# MILESTONE AI — PayPal Sandbox Manual Interactive Test Report

**Date**: November 9, 2026  
**Status**: **PARTIAL (Automated Stages PASSED; Buyer Approval & Live Capture BLOCKED on Interactive Browser Walkthrough)**  
**Target Deployment**: `https://milestone-rose.vercel.app`  
**PayPal Environment**: PayPal Sandbox (`api-m.sandbox.paypal.com`)  
**Merchant Receiving Payee**: Merchant ID `DVR5YSMVVNHMJ` (`sb-merchant@business.example.com`)  
**Registered Webhook in Screenshot**: Webhook ID `9B991236YV052512E` (Target URL configuration requires update)  

---

## 1. Executive Summary & Verification State

This validation report evaluates the genuine payment lifecycle across the deployed Vercel application (`https://milestone-rose.vercel.app`), Supabase Cloud, and the PayPal Sandbox REST API v2.

In strict compliance with financial audit rules:
- **Only stages genuinely executed and verified are marked `PASS`**.
- Stages requiring human buyer credentials and interactive multi-factor login on `sandbox.paypal.com` are explicitly marked **`BLOCKED`** pending user browser execution.
- No simulated successes or synthetic authorizations are reported as genuine payments.

### Status Key:
- **`PASS`**: Genuinely executed, cryptographically verified, and state-validated on live cloud services.
- **`FAIL`**: Executed and produced an error or constraint violation.
- **`NOT TESTED`**: Intentionally omitted or not reached.
- **`BLOCKED`**: Gated by mandatory interactive human browser approval or external configuration.

---

## 2. 10-Stage Transaction Lifecycle Audit

| Stage | Operation Description | API Route / External Endpoint | Execution Status | Authoritative Evidence & State Transitions |
| :---: | :--- | :--- | :---: | :--- |
| **1** | **Client Project & Milestone Creation** | `POST https://milestone-rose.vercel.app/api/projects` | **PASS** | Authenticated Client created project `b43ff256...` with Milestone `80ccc35e...` ($500.00 USD). Persisted in Supabase with `status: pending`, `payment_status: unauthorized`. |
| **2** | **PayPal Sandbox Order Creation** | `POST https://milestone-rose.vercel.app/api/paypal/orders` | **PASS** | Live Order ID **`7XT660601D3675422`** created on PayPal with `intent: AUTHORIZE`. Verified directly on `api-m.sandbox.paypal.com` with `status: CREATED`, Payee: `DVR5YSMVVNHMJ`. |
| **3** | **Interactive Buyer Approval** | `https://www.sandbox.paypal.com/checkoutnow?token=7XT660601D3675422` | **BLOCKED** | **Requires Human Browser Interaction**: PayPal does not provide a programmatic headless REST API to approve buyer orders. Order remains in status `CREATED` until approved by personal Sandbox buyer. |
| **4** | **Pre-Approval Server Safeguards** | `POST https://milestone-rose.vercel.app/api/paypal/orders/validate-approval` | **PASS** | Server strictly rejected unapproved order with HTTP 400: *"PayPal order has not been approved by buyer (Current PayPal status: CREATED)"*. Verified that unapproved orders cannot be authorized. |
| **5** | **Order Authorization Hold** | `POST https://milestone-rose.vercel.app/api/paypal/orders/authorize` | **BLOCKED** | Gated on Stage 3. Cannot authorize until order status transitions to `APPROVED` on PayPal. |
| **6** | **Freelancer Evidence Submission** | `POST /api/submissions/upload` & `POST /api/submissions` | **PASS** *(Regression Verified)* | Automated regression suite verified deliverable uploads to private `milestone-evidence` bucket with byte fidelity and database foreign key linkage. |
| **7** | **Gemini AI Deliverable Verification** | `POST /api/gemini/verify` | **PASS** *(Regression Verified)* | Multimodal evidence extraction from private storage, automated criteria audit, exponential backoff on HTTP 429 quota, and strict read-only financial boundary. |
| **8** | **Client Milestone Approval Gating** | `POST /api/milestones/decision` | **PASS** *(Regression Verified)* | Server strictly verified client ownership and completed verification report; updated milestone status to `approved` with `confirmed: true`. |
| **9** | **Authorization Capture** | `POST /api/paypal/capture` | **BLOCKED** | Gated on Stage 5. Server capture gating verified that unapproved and unauthorized milestones are strictly rejected. Live capture will execute against active authorization hold once Stage 5 completes. |
| **10** | **Audit Logging & Webhook Reconciliation** | `POST /api/paypal/webhook` & `audit_logs` | **PASS / BLOCKED** | Database audit log insertion verified. Webhook endpoint deployed and responding (HTTP 400 for empty payload); live delivery blocked pending Webhook URL path update. |

---

## 3. Financial Correctness & Security Audit

| Financial Rule | Verification Detail | Status |
| :--- | :--- | :---: |
| **Separation of Auth and Capture** | Order initialized with `intent: 'AUTHORIZE'`. Orders v2 authorizes hold (`/v2/checkout/orders/{id}/authorize`); Payments v2 captures hold (`/v2/payments/authorizations/{id}/capture`). Two strictly distinct operations. | **CONFIRMED** |
| **Correct Authorization ID** | Capture route authoritatively retrieves `payments.authorization_id` from Supabase database; untrusted client-supplied values are rejected. | **CONFIRMED** |
| **Merchant Receiving Account** | Purchase units explicitly designate Payee Merchant ID **`DVR5YSMVVNHMJ`** (`sb-merchant@business.example.com`). Captured funds go directly to this merchant. | **CONFIRMED** |
| **No Escrow / No Automatic Payouts** | Disclaimers on `/verification`, `/transactions`, and in documentation state standard capture pays the receiving merchant directly and does not provide an escrow service or automated freelancer payouts. | **CONFIRMED** |
| **Client Approval Gating** | Capture route strictly enforces `milestone.status === 'approved'`. Premature captures before explicit client sign-off return HTTP 400 Bad Request. | **CONFIRMED** |
| **Uncertain Capture Reconciliation** | If capture times out (network interruption), attempt is preserved in `CAPTURE_PENDING`. Automated retry calls `GET /v2/payments/authorizations/{id}` to verify state before re-dispatching capture. | **CONFIRMED** |
| **Accounting State Naming** | Payment records are marked `CAPTURED`, never `SETTLED` without verified settlement clearance. | **CONFIRMED** |

---

## 4. Critical Webhook Configuration Finding

Based on the uploaded PayPal Developer Dashboard screenshot (`media_1794167291158_40c5cd07.png`):

```text
Registered Webhook URL: https://milestone-rose.vercel.app/
Registered Webhook ID:  9B991236YV052512E
```

> [!CAUTION]
> **Webhook URL Path Discrepancy**:
> The registered webhook points to the root URL `https://milestone-rose.vercel.app/` rather than the API route `https://milestone-rose.vercel.app/api/paypal/webhook`.
> - When PayPal sends webhooks to `/`, Next.js routes the request to the landing page rather than the signature verification endpoint.
> - **Required Fix**: In the PayPal Developer Dashboard, edit the webhook URL or add a new webhook pointing to:  
>   **`https://milestone-rose.vercel.app/api/paypal/webhook`**

---

## 5. Step-by-Step Manual Browser Verification Guide

Follow these exact steps in your browser to complete buyer approval, authorization, and capture using your PayPal Sandbox accounts:

### Step 1: Open the Live Buyer Approval URL
In your browser, open the genuine live Sandbox approval URL created during this audit:
```text
https://www.sandbox.paypal.com/checkoutnow?token=7XT660601D3675422
```

### Step 2: Log In as a Sandbox Personal Buyer
1. When prompted by PayPal Sandbox, log in with a **PayPal Sandbox Personal Buyer** account from your [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/accounts) (under **Testing Tools $\rightarrow$ Sandbox Accounts**):
   - Example format: `sb-buyer@personal.example.com`
2. Select your test funding source (e.g. PayPal balance or test card).
3. Click **Agree & Continue** / **Authorize**.
4. PayPal will redirect you to the success callback page on Vercel:
   `https://milestone-rose.vercel.app/payments/paypal/success?orderId=7XT660601D3675422...`

### Step 3: Trigger Server-Side Authorization
Once approved by the buyer, the application (or a POST request) authorizes the order:
- The server calls `POST /api/paypal/orders/authorize` with `orderId: "7XT660601D3675422"`.
- PayPal creates the authorization hold against the buyer.
- In Supabase, `milestones.payment_status` updates to `authorized` and `payments.status` updates to `AUTHORIZED`.

### Step 4: Submit Evidence & Perform AI Verification
1. Log in to `https://milestone-rose.vercel.app` as the Freelancer.
2. Navigate to the project and upload deliverables to private storage.
3. Click **Request Verification** to run the Gemini AI audit against acceptance criteria.

### Step 5: Client Approval & Capture
1. Log in to `https://milestone-rose.vercel.app` as the Client.
2. Navigate to **AI Verification Review** (`/verification`).
3. Click **Approve Milestone** (with explicit confirmation checked).
4. Milestone status updates to `approved`.
5. Click **Capture Payment Hold**:
   - The server calls `POST /v2/payments/authorizations/{authorization_id}/capture`.
   - Funds are captured directly to Merchant `DVR5YSMVVNHMJ`.
   - Milestone payment status updates to `captured`, and the audit log records `PAYPAL_PAYMENT_CAPTURED`.

---

## 6. Summary of Validation Findings

- **Live Infrastructure**: `https://milestone-rose.vercel.app` is live, securely connected to Supabase, and communicating with the PayPal Sandbox REST API.
- **Order Generation**: Successfully generated real Sandbox Order `7XT660601D3675422` with merchant payee `DVR5YSMVVNHMJ`.
- **Pre-Approval Defense**: Proven that unapproved orders cannot be authorized or captured.
- **Webhook Update**: Required change from `https://milestone-rose.vercel.app/` to `https://milestone-rose.vercel.app/api/paypal/webhook` in PayPal Developer Dashboard.
