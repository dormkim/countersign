// One person's workspace: policy, today's PayPal budget, the agent's purchase
// intents, the order ledger and the audit log. Each browser gets its own
// session so judges trying the hosted demo never see each other's data.
import { randomUUID } from "node:crypto";
import type { Catalog, Offer } from "../catalog/types.js";
import { AuditLog } from "../domain/audit.js";
import type { GateResult, PurchaseIntent } from "../domain/firewall.js";
import { formatMoney, type Money } from "../domain/money.js";
import type { OrderRecord, ShipPlan } from "../domain/orders.js";
import type { CompileResult, Policy } from "../domain/policy.js";
import { localDay } from "./time.js";
import type { LLM } from "../llm/provider.js";
import { SimulatedPayPal } from "../paypal/simulated.js";
import type { PayPalPort } from "../paypal/types.js";
import type { Config } from "./config.js";

export type IntentStatus = "allowed" | "needs_you" | "denied" | "rejected" | "awaiting_paypal" | "paid" | "payment_failed";

export interface IntentRecord {
  intent: PurchaseIntent;
  offer: Offer | null;
  gate: GateResult;
  status: IntentStatus;
  by: string; // who picked the product (model name or rules)
  pickNote: string | null;
  checkoutOrderId: string | null;
  approveUrl: string | null;
  error: string | null;
  orderId: string | null;
  at: string;
}

export interface Envelope {
  orderId: string;
  status: "awaiting_paypal" | "active" | "voided" | "failed";
  approveUrl: string | null;
  authorizationId: string | null;
  amount: Money;
  captured: Money;
  day: string; // local day it covers
  error: string | null;
}

export interface PolicyState {
  text: string;
  tz: string;
  draft: CompileResult | null;
  draftedBy: string;
  draftNote: string | null;
  active: Policy | null;
  activatedAt: string | null;
}

export class Session {
  readonly id = randomUUID();
  readonly audit = new AuditLog();
  readonly paypal: PayPalPort;
  readonly sim: SimulatedPayPal | null;
  clockOffsetMs = 0;
  lastSeen = Date.now();
  policy: PolicyState = { text: "", tz: "America/Los_Angeles", draft: null, draftedBy: "", draftNote: null, active: null, activatedAt: null };
  envelope: Envelope | null = null;
  intents = new Map<string, IntentRecord>();
  orders: OrderRecord[] = [];
  nextShipPlan: ShipPlan = "on_time";
  /** Drafted notes keyed by case identity, so a model is not re-called on every refresh. */
  drafts = new Map<string, { value: string; by: string; note: string | null }>();
  invoices: Array<{ id: string; to: string; amount: Money; status: string; payUrl: string | null; at: string }> = [];

  constructor(readonly cfg: Config) {
    if (cfg.sandbox) {
      this.paypal = cfg.sandbox;
      this.sim = null;
    } else {
      this.sim = new SimulatedPayPal(() => this.now(), `${cfg.publicBase}/sim-paypal/approve`);
      this.paypal = this.sim;
    }
  }

  get llm(): LLM | null {
    return this.cfg.llm;
  }

  catalogFor(source: "demo" | "channel3"): Catalog {
    return source === "channel3" && this.cfg.channel3 ? this.cfg.channel3 : this.cfg.demo;
  }

  now(): Date {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  log(actor: Parameters<AuditLog["append"]>[0], action: string, detail: Record<string, unknown> = {}) {
    this.audit.append(actor, action, detail, this.now());
  }

  today(): string {
    return localDay(this.now(), this.policy.tz);
  }

  /** Gross spend today in the policy currency. Other currencies are tracked apart, never converted. */
  spentToday(): Money | null {
    const p = this.policy.active;
    if (!p) return null;
    const minor = this.orders
      .filter((o) => o.total.currency === p.currency && localDay(new Date(o.placedAt), this.policy.tz) === this.today())
      .reduce((s, o) => s + o.total.minor, 0);
    return { currency: p.currency, minor };
  }

  envelopeRemaining(): Money | null {
    const e = this.envelope;
    if (!e || e.status !== "active" || e.day !== this.today()) return null;
    return { currency: e.amount.currency, minor: e.amount.minor - e.captured.minor };
  }

  describeEnvelope(): string {
    const e = this.envelope;
    if (!e) return "none";
    return `${e.status}, ${formatMoney(e.captured)} of ${formatMoney(e.amount)} used`;
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private readonly cfg: Config, private readonly ttlMs = 6 * 3_600_000, private readonly max = 500) {}

  get(id: string | undefined): Session {
    this.sweep();
    const found = id ? this.sessions.get(id) : undefined;
    if (found) {
      found.lastSeen = Date.now();
      return found;
    }
    const s = new Session(this.cfg);
    s.log("system", "session started", { paypal: s.paypal.mode, ai: this.cfg.llm?.name ?? "offline rules", catalog: this.cfg.channel3 ? "channel3 + demo" : "demo" });
    this.sessions.set(s.id, s);
    return s;
  }

  reset(id: string): Session {
    this.sessions.delete(id);
    return this.get(undefined);
  }

  private sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, s] of this.sessions) if (s.lastSeen < cutoff) this.sessions.delete(k);
    while (this.sessions.size > this.max) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
  }
}
