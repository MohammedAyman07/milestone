import { z } from "zod";

// Canonical PayPal Payment Lifecycles
export const PayPalPaymentStatusEnum = z.enum([
  "CREATED",
  "APPROVED",
  "AUTHORIZED",
  "CAPTURE_PENDING",
  "CAPTURED",
  "SETTLED",
  "VOIDED",
  "REFUNDED",
  "FAILED",
  "EXPIRED",
  "UNAUTHORIZED",
]);

export type PayPalPaymentStatus = z.infer<typeof PayPalPaymentStatusEnum>;

// Request Schemas
export const CreatePaymentOrderRequestSchema = z.object({
  milestoneId: z.string().min(1, "Milestone ID is required"),
  projectId: z.string().min(1, "Project ID is required"),
  returnUrl: z.string().url("Valid return URL is required").optional(),
  cancelUrl: z.string().url("Valid cancel URL is required").optional(),
});

export type CreatePaymentOrderRequest = z.infer<typeof CreatePaymentOrderRequestSchema>;

export const AuthorizeOrderRequestSchema = z.object({
  orderId: z.string().min(1, "PayPal Order ID is required"),
  milestoneId: z.string().min(1, "Milestone ID is required"),
});

export type AuthorizeOrderRequest = z.infer<typeof AuthorizeOrderRequestSchema>;

export const CaptureAuthorizationRequestSchema = z.object({
  milestoneId: z.string().min(1, "Milestone ID is required"),
  authorizationId: z.string().min(1, "PayPal Authorization ID is required"),
  paymentId: z.string().optional(),
});

export type CaptureAuthorizationRequest = z.infer<typeof CaptureAuthorizationRequestSchema>;

export const VoidAuthorizationRequestSchema = z.object({
  milestoneId: z.string().min(1, "Milestone ID is required"),
  authorizationId: z.string().min(1, "PayPal Authorization ID is required"),
  reason: z.string().max(255).optional(),
});

export type VoidAuthorizationRequest = z.infer<typeof VoidAuthorizationRequestSchema>;

// PayPal API Response Schemas
export const PayPalAmountSchema = z.object({
  currency_code: z.string().default("USD"),
  value: z.string(),
});

export const PayPalOrderLinkSchema = z.object({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

export const PayPalPurchaseUnitSchema = z.object({
  reference_id: z.string().optional(),
  custom_id: z.string().optional(),
  description: z.string().optional(),
  amount: PayPalAmountSchema.optional(),
  payee: z.object({
    merchant_id: z.string().optional(),
    email_address: z.string().optional(),
  }).optional(),
  payments: z.record(z.string(), z.any()).optional(),
});

export const PayPalPayerSchema = z.object({
  payer_id: z.string().optional(),
  email_address: z.string().optional(),
  name: z.record(z.string(), z.any()).optional(),
});

export const PayPalOrderResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  intent: z.string().default("AUTHORIZE"),
  links: z.array(PayPalOrderLinkSchema).default([]),
  purchase_units: z.array(PayPalPurchaseUnitSchema).optional(),
  payer: PayPalPayerSchema.optional(),
  create_time: z.string().optional(),
});

export type PayPalOrderResponse = z.infer<typeof PayPalOrderResponseSchema>;

export const PayPalAuthorizationDetailsSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: PayPalAmountSchema,
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  expiration_time: z.string().optional(),
  links: z.array(PayPalOrderLinkSchema).optional().default([]),
});

export type PayPalAuthorizationDetails = z.infer<typeof PayPalAuthorizationDetailsSchema>;

export const PayPalCaptureDetailsSchema = z.object({
  id: z.string(),
  status: z.string(), // "COMPLETED" | "PENDING" | "DECLINED" | "FAILED"
  amount: PayPalAmountSchema,
  final_capture: z.boolean().optional().default(true),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});

export type PayPalCaptureDetails = z.infer<typeof PayPalCaptureDetailsSchema>;

export const PayPalWebhookPayloadSchema = z.object({
  id: z.string(),
  event_version: z.string().optional(),
  create_time: z.string(),
  resource_type: z.string(),
  event_type: z.string(),
  summary: z.string().optional(),
  resource: z.record(z.string(), z.any()),
});

export type PayPalWebhookPayload = z.infer<typeof PayPalWebhookPayloadSchema>;
