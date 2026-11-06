// In-memory PayPal with the same state machine as the sandbox, used when no
// sandbox keys are configured. It refuses the same things PayPal refuses
// (capturing an unapproved order, over-capturing, decimals in JPY, KRW...),
// so the product logic is exercised honestly. Every object it creates is
// labeled simulated in the UI.
import { randomBytes } from "node:crypto";
import { currencyInfo, toPayPalValue, type Money } from "../domain/money.js";
import {
  PayPalError, type AuthorizationRef, type CaptureRef, type CreateOrderInput, type Dispute,
  type EvidenceInput, type InvoiceInput, type InvoiceRef, type OrderRef, type PayPalPort, type RefundRef,
} from "./types.js";

interface SimOrder { id: string; intent: string; amount: Money; status: string; returnUrl: string; authId: string | null; captureId: string | null }
interface SimAuth { id: string; orderId: string; amount: Money; captured: number; status: string; expiresAt: string }
interface SimCapture { id: string; orderId: string; amount: Money; refunded: number }

const id = (prefix: string) => prefix + randomBytes(7).toString("hex").toUpperCase().slice(0, 13);
const fail = (status: number, issue: string, msg: string) =>
  new PayPalError(`${issue}: ${msg}`, status, "UNPROCESSABLE_ENTITY", `sim-${randomBytes(4).toString("hex")}`, [{ issue }]);

export class SimulatedPayPal implements PayPalPort {
  readonly mode = "simulated" as const;
  private orders = new Map<string, SimOrder>();
  private auths = new Map<string, SimAuth>();
  private captures = new Map<string, SimCapture>();
  private disputes = new Map<string, Dispute>();
  private invoices = new Map<string, InvoiceRef>();
  private idem = new Map<string, unknown>();

  constructor(private readonly now: () => Date, private readonly approveBase: string) {}

  private once<T>(key: string, f: () => T): T {
    if (this.idem.has(key)) return this.idem.get(key) as T;
    const v = f();
    this.idem.set(key, v);
    return v;
  }

  private checkAmount(m: Money) {
    const c = currencyInfo(m.currency);
    if (!c.supportedByPayPal) throw fail(422, "CURRENCY_NOT_SUPPORTED", `${m.currency} is not supported`);
    if (m.minor <= 0) throw fail(422, "INVALID_PARAMETER_VALUE", "amount must be positive");
  }

  async createOrder(i: CreateOrderInput): Promise<OrderRef> {
    this.checkAmount(i.amount);
    return this.once(`order:${i.requestId}`, () => {
      const o: SimOrder = { id: id("SIM"), intent: i.intent, amount: i.amount, status: "PAYER_ACTION_REQUIRED", returnUrl: i.returnUrl, authId: null, captureId: null };
      this.orders.set(o.id, o);
      return this.ref(o);
    });
  }

  private ref(o: SimOrder): OrderRef {
    return { id: o.id, status: o.status, approveUrl: o.status === "PAYER_ACTION_REQUIRED" ? `${this.approveBase}/${o.id}` : null };
  }

  private order(orderId: string): SimOrder {
    const o = this.orders.get(orderId);
    if (!o) throw fail(404, "RESOURCE_NOT_FOUND", `order ${orderId}`);
    return o;
  }

  /** Simulated buyer approval (the real flow is the PayPal approval page). */
  approve(orderId: string): string {
    const o = this.order(orderId);
    if (o.status === "PAYER_ACTION_REQUIRED") o.status = "APPROVED";
    return o.returnUrl;
  }

  async getOrder(orderId: string): Promise<OrderRef> {
    return this.ref(this.order(orderId));
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationRef> {
    return this.once(`auth:${requestId}`, () => {
      const o = this.order(orderId);
      if (o.intent !== "AUTHORIZE") throw fail(422, "ACTION_DOES_NOT_MATCH_INTENT", "order intent is CAPTURE");
      if (o.status !== "APPROVED") throw fail(422, "ORDER_NOT_APPROVED", "payer has not approved the order");
      const a: SimAuth = { id: id("AUTH"), orderId, amount: o.amount, captured: 0, status: "CREATED", expiresAt: new Date(this.now().getTime() + 29 * 86_400_000).toISOString() };
      this.auths.set(a.id, a);
      o.status = "COMPLETED";
      o.authId = a.id;
      return { authorizationId: a.id, status: a.status, amount: a.amount, expiresAt: a.expiresAt };
    });
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureRef> {
    return this.once(`cap:${requestId}`, () => {
      const o = this.order(orderId);
      if (o.intent !== "CAPTURE") throw fail(422, "ACTION_DOES_NOT_MATCH_INTENT", "order intent is AUTHORIZE");
      if (o.status !== "APPROVED") throw fail(422, "ORDER_NOT_APPROVED", "payer has not approved the order");
      const c: SimCapture = { id: id("CAP"), orderId, amount: o.amount, refunded: 0 };
      this.captures.set(c.id, c);
      o.status = "COMPLETED";
      o.captureId = c.id;
      return { captureId: c.id, status: "COMPLETED", amount: c.amount };
    });
  }

  async captureAuthorization(authId: string, amount: Money, finalCapture: boolean, _inv: string, requestId: string): Promise<CaptureRef> {
    this.checkAmount(amount);
    return this.once(`acap:${requestId}`, () => {
      const a = this.auths.get(authId);
      if (!a) throw fail(404, "RESOURCE_NOT_FOUND", `authorization ${authId}`);
      if (a.status === "VOIDED" || a.status === "CAPTURED") throw fail(422, "AUTHORIZATION_ALREADY_COMPLETED", a.status);
      if (new Date(a.expiresAt) < this.now()) throw fail(422, "AUTHORIZATION_EXPIRED", a.expiresAt);
      if (amount.currency !== a.amount.currency) throw fail(422, "CURRENCY_MISMATCH", "capture currency differs from authorization");
      if (a.captured + amount.minor > a.amount.minor) throw fail(422, "MAX_CAPTURE_AMOUNT_EXCEEDED", `only ${toPayPalValue({ ...a.amount, minor: a.amount.minor - a.captured })} left`);
      a.captured += amount.minor;
      a.status = finalCapture || a.captured === a.amount.minor ? "CAPTURED" : "PARTIALLY_CAPTURED";
      const c: SimCapture = { id: id("CAP"), orderId: a.orderId, amount, refunded: 0 };
      this.captures.set(c.id, c);
      return { captureId: c.id, status: "COMPLETED", amount };
    });
  }

  async voidAuthorization(authId: string): Promise<void> {
    const a = this.auths.get(authId);
    if (!a) throw fail(404, "RESOURCE_NOT_FOUND", `authorization ${authId}`);
    if (a.status === "CAPTURED") throw fail(422, "AUTHORIZATION_ALREADY_COMPLETED", "fully captured");
    a.status = "VOIDED";
  }

  async refundCapture(captureId: string, amount: Money, _note: string, requestId: string): Promise<RefundRef> {
    return this.once(`ref:${requestId}`, () => this.refundNow(captureId, amount));
  }

  private refundNow(captureId: string, amount: Money): RefundRef {
    const c = this.captures.get(captureId);
    if (!c) throw fail(404, "RESOURCE_NOT_FOUND", `capture ${captureId}`);
    if (c.refunded + amount.minor > c.amount.minor) throw fail(422, "REFUND_AMOUNT_EXCEEDED", "more than captured");
    c.refunded += amount.minor;
    return { refundId: id("REF"), status: "COMPLETED", amount };
  }

  async addTracking(orderId: string, captureId: string): Promise<void> {
    this.order(orderId);
    if (!this.captures.has(captureId)) throw fail(422, "CAPTURE_ID_NOT_FOUND", captureId);
  }

  /** Simulates the buyer opening a case in PayPal's Resolution Center (no public API for buyers). */
  openDisputeAsBuyer(captureId: string, reason: Dispute["reason"], note: string): Dispute {
    const c = this.captures.get(captureId);
    if (!c) throw fail(404, "RESOURCE_NOT_FOUND", `capture ${captureId}`);
    const now = this.now();
    const d: Dispute = {
      id: id("PP-D-"), reason, status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY",
      amount: { ...c.amount, minor: c.amount.minor - c.refunded }, createdAt: now.toISOString(),
      sellerResponseDue: new Date(now.getTime() + 10 * 86_400_000).toISOString(),
      captureIds: [captureId], outcome: null, buyerNote: note,
    };
    this.disputes.set(d.id, d);
    return d;
  }

  async listDisputes(captureIds: string[]): Promise<Dispute[]> {
    return [...this.disputes.values()].filter((d) => d.captureIds.some((c) => captureIds.includes(c))).map((d) => ({ ...d }));
  }

  async getDispute(disputeId: string): Promise<Dispute> {
    const d = this.disputes.get(disputeId);
    if (!d) throw fail(404, "RESOURCE_NOT_FOUND", `dispute ${disputeId}`);
    return { ...d };
  }

  private open(disputeId: string, allowed: string[]): Dispute {
    const d = this.disputes.get(disputeId);
    if (!d) throw fail(404, "RESOURCE_NOT_FOUND", `dispute ${disputeId}`);
    if (!allowed.includes(d.status)) throw fail(422, "INVALID_DISPUTE_STATUS", `status is ${d.status}`);
    if (d.sellerResponseDue && new Date(d.sellerResponseDue) < this.now() && allowed.includes("WAITING_FOR_SELLER_RESPONSE")) {
      throw fail(422, "DISPUTE_RESPONSE_TIME_EXPIRED", d.sellerResponseDue);
    }
    return d;
  }

  async provideEvidence(disputeId: string, _e: EvidenceInput): Promise<void> {
    const d = this.open(disputeId, ["WAITING_FOR_SELLER_RESPONSE"]);
    d.status = "UNDER_REVIEW";
  }

  async acceptClaim(disputeId: string, _note: string, refund: Money | null): Promise<void> {
    const d = this.open(disputeId, ["WAITING_FOR_SELLER_RESPONSE", "OPEN"]);
    const amt = refund ?? d.amount;
    if (amt && d.captureIds[0]) this.refundNow(d.captureIds[0], amt);
    d.status = "RESOLVED";
    d.outcome = "RESOLVED_BUYER_FAVOR";
  }

  async makeOffer(disputeId: string, _note: string, _amount: Money): Promise<void> {
    const d = this.open(disputeId, ["WAITING_FOR_SELLER_RESPONSE", "OPEN"]);
    if (d.stage !== "INQUIRY") throw fail(422, "INVALID_DISPUTE_STAGE", "offers are allowed only in INQUIRY");
    d.status = "WAITING_FOR_BUYER_RESPONSE";
  }

  async simulateRequireEvidence(disputeId: string, action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE"): Promise<void> {
    const d = this.open(disputeId, ["UNDER_REVIEW"]);
    d.status = action === "SELLER_EVIDENCE" ? "WAITING_FOR_SELLER_RESPONSE" : "WAITING_FOR_BUYER_RESPONSE";
  }

  async simulateAdjudicate(disputeId: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR"): Promise<void> {
    const d = this.open(disputeId, ["UNDER_REVIEW"]);
    d.status = "RESOLVED";
    d.outcome = outcome === "BUYER_FAVOR" ? "RESOLVED_BUYER_FAVOR" : "RESOLVED_SELLER_FAVOR";
    if (outcome === "BUYER_FAVOR" && d.amount && d.captureIds[0]) this.refundNow(d.captureIds[0], d.amount);
  }

  async createInvoice(i: InvoiceInput): Promise<InvoiceRef> {
    for (const it of i.items) this.checkAmount(it.amount);
    const inv: InvoiceRef = { id: id("INV2-"), status: "DRAFT", payUrl: null };
    this.invoices.set(inv.id, inv);
    return { ...inv };
  }

  async sendInvoice(invoiceId: string): Promise<InvoiceRef> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw fail(404, "RESOURCE_NOT_FOUND", `invoice ${invoiceId}`);
    inv.status = "SENT";
    inv.payUrl = `simulated://invoice/${invoiceId}`;
    return { ...inv };
  }
}
