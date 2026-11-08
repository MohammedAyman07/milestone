import { paypalRequest } from "./client";
import { PayPalCaptureDetails, PayPalAuthorizationDetails } from "./types";

export interface CaptureParams {
  authorizationId: string;
  amount: number;
  currency?: string;
  idempotencyKey: string;
  noteToPayer?: string;
}

export interface CaptureResult {
  captureId: string;
  status: string; // e.g. "COMPLETED" | "PENDING"
  amount: number;
  currency: string;
  finalCapture: boolean;
  createTime?: string;
  raw: PayPalCaptureDetails;
}

export async function capturePayPalAuthorization(params: CaptureParams): Promise<CaptureResult> {
  const currency = params.currency || "USD";
  if (currency !== "USD") {
    throw new Error("MILESTONE AI MVP supports USD payments only.");
  }

  const payload = {
    amount: {
      currency_code: "USD",
      value: params.amount.toFixed(2),
    },
    final_capture: true,
    note_to_payer: params.noteToPayer || "Milestone AI verified and client-approved payment release",
  };

  const response = await paypalRequest<PayPalCaptureDetails>(
    `/v2/payments/authorizations/${params.authorizationId}/capture`,
    {
      method: "POST",
      body: payload,
      idempotencyKey: params.idempotencyKey,
    }
  );

  return {
    captureId: response.data.id,
    status: response.data.status,
    amount: parseFloat(response.data.amount?.value || "0"),
    currency: response.data.amount?.currency_code || "USD",
    finalCapture: response.data.final_capture ?? true,
    createTime: response.data.create_time,
    raw: response.data,
  };
}

export interface PayPalAuthorizationResource {
  id: string;
  status: string; // "CREATED" (Authorized) | "CAPTURED" | "DENIED" | "EXPIRED" | "VOIDED" | "PENDING"
  amount: {
    currency_code: string;
    value: string;
  };
  expiration_time?: string;
  payments?: {
    captures?: Array<{
      id: string;
      status: string; // "COMPLETED" | "PENDING" | "DECLINED" | "FAILED"
      amount: { currency_code: string; value: string };
      create_time?: string;
    }>;
  };
}

export async function getPayPalAuthorization(
  authorizationId: string
): Promise<PayPalAuthorizationResource> {
  const response = await paypalRequest<PayPalAuthorizationResource>(
    `/v2/payments/authorizations/${authorizationId}`
  );
  return response.data;
}

export async function getPayPalCapture(captureId: string): Promise<PayPalCaptureDetails> {
  const response = await paypalRequest<PayPalCaptureDetails>(`/v2/payments/captures/${captureId}`);
  return response.data;
}

export async function reauthorizePayPalAuthorization(
  authorizationId: string,
  amount: number,
  idempotencyKey?: string
): Promise<PayPalAuthorizationResource> {
  const payload = {
    amount: {
      currency_code: "USD",
      value: amount.toFixed(2),
    },
  };

  const response = await paypalRequest<PayPalAuthorizationResource>(
    `/v2/payments/authorizations/${authorizationId}/reauthorize`,
    {
      method: "POST",
      body: payload,
      idempotencyKey,
    }
  );

  return response.data;
}

export async function voidPayPalAuthorization(
  authorizationId: string
): Promise<{ status: number; voided: boolean }> {
  const response = await paypalRequest<any>(
    `/v2/payments/authorizations/${authorizationId}/void`,
    {
      method: "POST",
    }
  );

  return {
    status: response.status,
    voided: response.status === 204 || response.status === 200,
  };
}
