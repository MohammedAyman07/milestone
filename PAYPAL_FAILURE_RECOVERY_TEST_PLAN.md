# MILESTONE AI — PayPal Failure Recovery & Edge Case Test Plan (Phase 6.3)

**Author**: Antigravity AI Engineering & Security Team  
**Date**: November 8, 2026  
**Document**: `PAYPAL_FAILURE_RECOVERY_TEST_PLAN.md`  
**Target Environment**: PayPal Sandbox  
**Status**: TEST MATRIX SPECIFICATION AWAITING HUMAN APPROVAL  

---

## 1. Test Matrix Overview

This test matrix validates that every edge case, network anomaly, and failure scenario in the PayPal payment lifecycle is safely handled without double charges, orphaned states, or financial data loss.

| Test ID | Scenario | Injected Condition | Expected Behavior | Database Assertion |
| :--- | :--- | :--- | :--- | :--- |
| **TC-01** | **Duplicate Order Creation** | Client double-clicks "Authorize" or sends two rapid create requests for the same milestone. | Request #1 succeeds; Request #2 is intercepted by `uq_active_milestone_payment_attempt` or returns existing `order_id` via `idempotency_order_create`. | Exactly 1 `CREATED` payment record; zero duplicate PayPal orders. |
| **TC-02** | **Duplicate Authorization** | Callback URL is requested multiple times with the same PayPal `token` / `order_id`. | First request authorizes the order. Second request detects existing `status == 'AUTHORIZED'` and returns existing authorization details without error. | Payment status remains `AUTHORIZED`; `authorization_id` unchanged. |
| **TC-03** | **Duplicate Capture Request** | Client sends two capture requests sequentially with the same `authorization_id`. | Request #1 captures payment (`HTTP 201 COMPLETED`). Request #2 is blocked by trigger `trg_validate_payment_transition` and API logic. | Exactly 1 `CAPTURED` record; zero duplicate capture charges. |
| **TC-04** | **Concurrent Capture Requests** | Two capture requests arrive simultaneously (e.g. distributed race condition). | In-flight job lock and PostgreSQL row lock (`SELECT FOR UPDATE`) allow exactly one capture; the second receives HTTP 409 Conflict. | Single capture executed on PayPal; single capture record in database. |
| **TC-05** | **Capture Timeout & Recovery** | Network drops or client times out after sending capture request to PayPal. | Server persisted `CAPTURE_PENDING` before call. Recovery queries `GET /v2/payments/authorizations/{id}` and inspects `payments.captures` array: if capture found with `COMPLETED`, reconciles; if captures array empty and status `AUTHORIZED`, safe to retry with same `idempotency_auth_capture`. | No second charge created; record correctly reflects true PayPal state. |
| **TC-06** | **PayPal PENDING Response** | PayPal Sandbox returns capture status `PENDING` (e.g. eCheck or multi-currency review). | Server records status as `CAPTURE_PENDING` (never `CAPTURED`). Updates milestone status to `capture_pending`. | Milestone is not marked completed until webhook confirms `PAYMENT.CAPTURE.COMPLETED`. |
| **TC-07** | **PayPal DECLINED Response** | PayPal Sandbox returns `status: 'DENIED'` or `INSTRUMENT_DECLINED`. | Server catches PayPal decline, transitions payment status to `FAILED`, stores error code and message in `error_details`. Milestone payment_status set to `failed`. | Authorization hold released; client notified to provide alternate payment method. |
| **TC-08** | **Expired Authorization** | Client attempts to capture an authorization that has exceeded PayPal's 29-day validity window. | PayPal returns HTTP 422 `AUTHORIZATION_EXPIRED`. Server marks payment status `EXPIRED` and milestone `expired`. | Client prompted to re-authorize milestone with a new payment attempt. |
| **TC-09** | **Duplicate Webhook Delivery** | PayPal delivers the exact same webhook event multiple times (`PAYPAL-TRANSMISSION-ID`). | System checks `paypal_webhook_events(transmission_id)`. First delivery processes event; subsequent deliveries return HTTP 200 without re-processing. | Exactly 1 webhook event record; zero redundant status mutations. |
| **TC-10** | **New Attempt After Failure** | Previous authorization was `VOIDED` or `FAILED`. Client re-initiates authorization for the same milestone. | System creates a new row with incremented `attempt_number = 2` and a new `payment_attempt_id`. Previous failed attempt is preserved in history. | Both attempts exist in `public.payments`; historical attempt untouched; new attempt becomes the single active record. |

---

## 2. Detailed Uncertain Capture Recovery Protocol (TC-05)

```
1. Client clicks "Approve & Release Payment"
2. Server verifies Client Session, Active Authorization, Non-Captured Status
3. Server executes SQL (PRE-CAPTURE):
   UPDATE public.payments 
   SET status = 'CAPTURE_PENDING', capture_initiated_at = now()
   WHERE id = :paymentId AND status = 'AUTHORIZED';
4. Server issues POST to PayPal:
   POST /v2/payments/authorizations/:authId/capture
   Header: PayPal-Request-Id: :idempotency_auth_capture
5. === CONNECTION TIMEOUT OCCURS (No HTTP response received after 15s) ===
6. Server catch block triggered:
   DO NOT mark as FAILED!
   DO NOT create a second charge!
   DO NOT retry blindly solely because status is 'AUTHORIZED'!
7. Server initiates Recovery Sub-routine:
   GET /v2/payments/authorizations/:authId
8. Evaluates PayPal response:
   STEP A: Inspect response.payments.captures Array:
     -> If capture exists with status == 'COMPLETED':
          UPDATE public.payments SET status = 'CAPTURED', capture_id = :captureId, captured_at = now()
          Audit log: 'PAYMENT_CAPTURED_RECOVERED'
          Advance milestone to 'captured'
     -> If capture exists with status == 'PENDING':
          UPDATE public.payments SET status = 'CAPTURE_PENDING', capture_id = :captureId
          Audit log: 'PAYMENT_CAPTURE_PENDING'
   STEP B: If captures array is empty AND authorization status == 'AUTHORIZED':
     -> Safe to re-send POST /v2/payments/authorizations/:authId/capture
     -> MUST use the EXACT SAME idempotency_auth_capture key
   STEP C: If PayPal endpoint unreachable after 3 retries:
     -> Retain status as 'CAPTURE_PENDING'
     -> Set manual_reconciliation_required = true
     -> Audit log: 'CAPTURE_AMBIGUOUS_RECONCILIATION_REQUIRED'
```

---

## 3. Test Execution Requirements

- Tests must be executed using verified PayPal Sandbox buyer and merchant accounts.
- Initial MVP currency is restricted strictly to `USD`.
- Funds settlement destination is documented as the Platform PayPal Merchant Account.
- No live payments or migrations will be executed until human approval is granted.
