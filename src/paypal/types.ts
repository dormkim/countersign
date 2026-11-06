// One interface, two implementations: the real PayPal sandbox REST adapter and
// an in-memory simulator with the same state machine. Field names in comments
// refer to PayPal's official OpenAPI specs (checkout_orders_v2,
// payments_payment_v2, customer_disputes_v1, invoicing_v2).
import type { Money } from "../domain/money.js";

export type Intent = "CAPTURE" | "AUTHORIZE";

export interface CreateOrderInput {
  intent: Intent;
  amount: Money;
  description: string;
  invoiceId: string;
  returnUrl: string;
  cancelUrl: string;
  requestId: string; // PayPal-Request-Id (idempotency)
}

export interface OrderRef {
  id: string;
  status: string; // CREATED | PAYER_ACTION_REQUIRED | APPROVED | COMPLETED | VOIDED
  approveUrl: string | null;
}

export interface AuthorizationRef {
  authorizationId: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED
  amount: Money;
  expiresAt: string | null;
}

export interface CaptureRef {
  captureId: string;
  status: string; // COMPLETED | PENDING
  amount: Money;
}

export interface RefundRef {
  refundId: string;
  status: string;
  amount: Money;
}

export type DisputeReason =
  | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
  | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
  | "UNAUTHORISED"
  | "OTHER"
  | string;

export interface Dispute {
  id: string; // dispute_id
  reason: DisputeReason;
  status: string; // OPEN | WAITING_FOR_SELLER_RESPONSE | WAITING_FOR_BUYER_RESPONSE | UNDER_REVIEW | RESOLVED | OTHER
  stage: string | null; // dispute_life_cycle_stage: INQUIRY | CHARGEBACK | ...
  amount: Money | null; // dispute_amount
  createdAt: string | null;
  sellerResponseDue: string | null; // seller_response_due_date
  captureIds: string[]; // disputed_transactions[].seller_transaction_id
  outcome: string | null; // dispute_outcome.outcome_code
  buyerNote: string | null;
}

export interface EvidenceInput {
  type: "PROOF_OF_FULFILLMENT" | "PROOF_OF_REFUND" | "OTHER";
  note: string;
  tracking?: { carrier: string; trackingNumber: string };
  refundIds?: string[];
}

export interface InvoiceInput {
  recipientEmail: string;
  recipientName: string;
  currency: string;
  items: Array<{ name: string; amount: Money }>;
  note: string;
  invoiceNumber: string;
}

export interface InvoiceRef {
  id: string;
  status: string; // DRAFT | SENT | PAID ...
  payUrl: string | null;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly name_: string | null,
    readonly debugId: string | null,
    readonly details: unknown,
  ) {
    super(message);
  }
}

export interface PayPalPort {
  readonly mode: "simulated" | "sandbox";
  createOrder(input: CreateOrderInput): Promise<OrderRef>;
  getOrder(id: string): Promise<OrderRef>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationRef>;
  captureOrder(orderId: string, requestId: string): Promise<CaptureRef>;
  captureAuthorization(authId: string, amount: Money, finalCapture: boolean, invoiceId: string, requestId: string): Promise<CaptureRef>;
  voidAuthorization(authId: string): Promise<void>;
  refundCapture(captureId: string, amount: Money, note: string, requestId: string): Promise<RefundRef>;
  addTracking(orderId: string, captureId: string, carrier: string, trackingNumber: string): Promise<void>;
  listDisputes(): Promise<Dispute[]>;
  getDispute(id: string): Promise<Dispute>;
  provideEvidence(id: string, e: EvidenceInput): Promise<void>;
  acceptClaim(id: string, note: string, refund: Money | null): Promise<void>;
  makeOffer(id: string, note: string, amount: Money, offerType: "REFUND" | "REFUND_WITH_RETURN"): Promise<void>;
  /** Sandbox-only simulation endpoints (require-evidence, adjudicate). */
  simulateRequireEvidence(id: string, action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE"): Promise<void>;
  simulateAdjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR"): Promise<void>;
  createInvoice(input: InvoiceInput): Promise<InvoiceRef>;
  sendInvoice(id: string): Promise<InvoiceRef>;
}
