// Real PayPal sandbox adapter (REST, no SDK). Endpoints and fields follow the
// official OpenAPI specs in github.com/paypal/paypal-rest-api-specifications.
// Errors are never swallowed: status, issue name and debug_id reach the UI.
import { parseMoney, toPayPalValue, type Money } from "../domain/money.js";
import {
  PayPalError, type AuthorizationRef, type CaptureRef, type CreateOrderInput, type Dispute,
  type EvidenceInput, type InvoiceInput, type InvoiceRef, type OrderRef, type PayPalPort, type RefundRef,
} from "./types.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Fictional demo-store return address (the sandbox merchant is a demo store).
const RETURN_ADDRESS = { address_line_1: "100 Demo Street", admin_area_2: "Oakland", admin_area_1: "CA", postal_code: "94607", country_code: "US" };

const amountJson = (m: Money) => ({ currency_code: m.currency, value: toPayPalValue(m) });
const moneyOf = (j: Json | undefined): Money | null => {
  if (!j?.currency_code || j.value == null) return null;
  const p = parseMoney(j.value, j.currency_code);
  return p.ok ? p.money : null;
};

function need(m: Money | null, j: Json): Money {
  if (!m) throw new PayPalError("PayPal response had no usable amount", 502, null, j.debug_id ?? null, j);
  return m;
}

export class SandboxPayPal implements PayPalPort {
  readonly mode = "sandbox" as const;
  private token: { value: string; exp: number } | null = null;
  private readonly base = "https://api-m.sandbox.paypal.com";

  constructor(private readonly clientId: string, private readonly secret: string, private readonly merchantEmail: string) {}

  private async auth(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || !j.access_token) throw new PayPalError(`OAuth failed (${res.status}): ${j.error_description ?? j.error ?? "no token"}`, res.status, j.error ?? null, null, j);
    this.token = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: Json | FormData, requestId?: string): Promise<Json> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.auth()}`, Prefer: "return=representation" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let j: Json;
    try {
      j = (text ? JSON.parse(text) : {}) as Json;
    } catch {
      throw new PayPalError(`HTTP_${res.status}: non-JSON response ${text.slice(0, 120)}`, res.status, null, res.headers.get("paypal-debug-id"), null);
    }
    if (!res.ok) {
      const issue = j.details?.[0]?.issue ?? j.name ?? `HTTP_${res.status}`;
      const desc = j.details?.[0]?.description ?? j.message ?? text.slice(0, 200);
      throw new PayPalError(`${issue}: ${desc}`, res.status, j.name ?? null, j.debug_id ?? null, j.details ?? j);
    }
    return j;
  }

  private orderRef(j: Json): OrderRef {
    const link = (j.links as Json[] | undefined)?.find((l) => l.rel === "payer-action" || l.rel === "approve");
    return { id: j.id, status: j.status, approveUrl: link?.href ?? null };
  }

  async createOrder(i: CreateOrderInput): Promise<OrderRef> {
    const j = await this.call("POST", "/v2/checkout/orders", {
      intent: i.intent,
      purchase_units: [{ amount: amountJson(i.amount), description: i.description.slice(0, 127), invoice_id: i.invoiceId }],
      payment_source: {
        paypal: { experience_context: { return_url: i.returnUrl, cancel_url: i.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } },
      },
    }, i.requestId);
    return this.orderRef(j);
  }

  async getOrder(id: string): Promise<OrderRef> {
    return this.orderRef(await this.call("GET", `/v2/checkout/orders/${id}`));
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationRef> {
    const j = await this.call("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, requestId);
    const a = j.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a) throw new PayPalError("authorize returned no authorization", 502, null, j.debug_id ?? null, j);
    return { authorizationId: a.id, status: a.status, amount: need(moneyOf(a.amount), j), expiresAt: a.expiration_time ?? null };
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureRef> {
    const j = await this.call("POST", `/v2/checkout/orders/${orderId}/capture`, {}, requestId);
    const c = j.purchase_units?.[0]?.payments?.captures?.[0];
    if (!c) throw new PayPalError("capture returned no capture", 502, null, j.debug_id ?? null, j);
    return { captureId: c.id, status: c.status, amount: need(moneyOf(c.amount), j) };
  }

  async captureAuthorization(authId: string, amount: Money, finalCapture: boolean, invoiceId: string, requestId: string): Promise<CaptureRef> {
    const j = await this.call("POST", `/v2/payments/authorizations/${authId}/capture`, {
      amount: amountJson(amount), final_capture: finalCapture, invoice_id: invoiceId,
    }, requestId);
    return { captureId: j.id, status: j.status, amount: moneyOf(j.amount) ?? amount };
  }

  async voidAuthorization(authId: string): Promise<void> {
    await this.call("POST", `/v2/payments/authorizations/${authId}/void`);
  }

  async refundCapture(captureId: string, amount: Money, note: string, requestId: string): Promise<RefundRef> {
    const j = await this.call("POST", `/v2/payments/captures/${captureId}/refund`, { amount: amountJson(amount), note_to_payer: note.slice(0, 255) }, requestId);
    return { refundId: j.id, status: j.status, amount: moneyOf(j.amount) ?? amount };
  }

  async addTracking(orderId: string, captureId: string, carrier: string, trackingNumber: string): Promise<void> {
    await this.call("POST", `/v2/checkout/orders/${orderId}/track`, { capture_id: captureId, tracking_number: trackingNumber, carrier, notify_payer: false });
  }

  private dispute(j: Json): Dispute {
    return {
      id: j.dispute_id,
      reason: j.reason,
      status: j.status,
      stage: j.dispute_life_cycle_stage ?? null,
      amount: moneyOf(j.dispute_amount),
      createdAt: j.create_time ?? null,
      sellerResponseDue: j.seller_response_due_date ?? null,
      captureIds: ((j.disputed_transactions ?? []) as Json[]).map((t) => t.seller_transaction_id).filter(Boolean),
      outcome: j.dispute_outcome?.outcome_code ?? null,
      buyerNote: ((j.messages ?? []) as Json[]).find((m) => m.posted_by === "BUYER")?.content ?? null,
    };
  }

  async listDisputes(captureIds: string[]): Promise<Dispute[]> {
    // Query per capture: the sandbox merchant account is shared, so a global
    // "latest 20" list could push a visitor's own dispute out of view.
    const ids = new Set<string>();
    for (const c of captureIds.slice(0, 20)) {
      const j = await this.call("GET", `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(c)}`);
      for (const d of (j.items ?? []) as Json[]) ids.add(d.dispute_id);
    }
    // The list returns summaries; fetch details so captures and deadlines are present.
    return Promise.all([...ids].map((id) => this.getDispute(id)));
  }

  async getDispute(id: string): Promise<Dispute> {
    return this.dispute(await this.call("GET", `/v1/customer/disputes/${id}`));
  }

  async provideEvidence(id: string, e: EvidenceInput): Promise<void> {
    // multipart/form-data with a JSON part named "input", as in PayPal's provide-evidence examples.
    const evidence: Json = { evidence_type: e.type, notes: e.note.slice(0, 2000) };
    const info: Json = {};
    if (e.tracking) info.tracking_info = [{ carrier_name: e.tracking.carrier, tracking_number: e.tracking.trackingNumber }];
    if (e.refundIds?.length) info.refund_ids = e.refundIds; // refund_ids_list is an array of strings
    if (Object.keys(info).length) evidence.evidence_info = info;
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ evidences: [evidence] })], { type: "application/json" }));
    await this.call("POST", `/v1/customer/disputes/${id}/provide-evidence`, form);
  }

  async acceptClaim(id: string, note: string, refund: Money | null): Promise<void> {
    const input: Json = { note: note.slice(0, 2000), accept_claim_type: "REFUND" };
    if (refund) input.refund_amount = amountJson(refund);
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    await this.call("POST", `/v1/customer/disputes/${id}/accept-claim`, form);
  }

  async makeOffer(id: string, note: string, amount: Money, offerType: "REFUND" | "REFUND_WITH_RETURN"): Promise<void> {
    const body: Json = { note: note.slice(0, 2000), offer_amount: amountJson(amount), offer_type: offerType };
    // Required for not-as-described offers that ask for the item back.
    if (offerType === "REFUND_WITH_RETURN") body.return_shipping_address = RETURN_ADDRESS;
    await this.call("POST", `/v1/customer/disputes/${id}/make-offer`, body);
  }

  async simulateRequireEvidence(id: string, action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE"): Promise<void> {
    await this.call("POST", `/v1/customer/disputes/${id}/require-evidence`, { action });
  }

  async simulateAdjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR"): Promise<void> {
    await this.call("POST", `/v1/customer/disputes/${id}/adjudicate`, { adjudication_outcome: outcome });
  }

  async createInvoice(i: InvoiceInput): Promise<InvoiceRef> {
    const j = await this.call("POST", "/v2/invoicing/invoices", {
      detail: { currency_code: i.currency, invoice_number: i.invoiceNumber, note: i.note.slice(0, 4000) },
      invoicer: { email_address: this.merchantEmail },
      primary_recipients: [{ billing_info: { email_address: i.recipientEmail, name: { given_name: i.recipientName } } }],
      items: i.items.map((it) => ({ name: it.name.slice(0, 200), quantity: "1", unit_amount: amountJson(it.amount) })),
    });
    // With Prefer: return=representation the body is the invoice; otherwise follow the self link.
    const invId: string = j.id ?? String(j.href ?? "").split("/").pop();
    return { id: invId, status: j.status ?? "DRAFT", payUrl: null };
  }

  async sendInvoice(id: string): Promise<InvoiceRef> {
    const j = await this.call("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true });
    const pay = (j.links as Json[] | undefined)?.find((l) => l.rel === "payer-view")?.href ?? j.href ?? null;
    return { id, status: "SENT", payUrl: pay };
  }
}
