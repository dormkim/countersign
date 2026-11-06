// Before-purchase flows: policy -> daily PayPal budget -> agent pick -> gate -> payment.
import { randomUUID } from "node:crypto";
import type { Offer } from "../catalog/types.js";
import { evaluate, type GateResult, type PurchaseIntent } from "../domain/firewall.js";
import { formatMoney, parseMoney, type Money } from "../domain/money.js";
import { planShipment, type OrderRecord } from "../domain/orders.js";
import { compilePolicy } from "../domain/policy.js";
import { draftPolicy, pickProduct, screenListing, type Screen } from "../llm/tasks.js";
import { PayPalError } from "../paypal/types.js";
import type { IntentRecord, Session } from "./session.js";
import { validTimeZone } from "./time.js";

export class UserError extends Error {}

const errText = (e: unknown) =>
  e instanceof PayPalError ? `PayPal ${e.status} ${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ""}` : (e as Error).message;

export async function draftPolicyFor(s: Session, text: string, tz: string) {
  if (!text.trim()) throw new UserError("Describe your rules first.");
  if (!validTimeZone(tz)) throw new UserError(`Unknown time zone ${tz}.`);
  const produced = await draftPolicy(s.llm, text);
  const compiled = compilePolicy(produced.value, text, tz);
  s.policy = { ...s.policy, text, tz, draft: compiled, draftedBy: produced.by, draftNote: produced.note };
  s.log("copilot", "policy drafted", { by: produced.by, questions: compiled.questions, note: produced.note });
  return s.policy;
}

export function activatePolicy(s: Session) {
  const d = s.policy.draft;
  if (!d?.policy) throw new UserError("The draft still has open questions. Answer them and draft again.");
  s.policy.active = d.policy;
  s.policy.activatedAt = s.now().toISOString();
  s.log("human", "policy activated", { perPurchase: formatMoney(d.policy.perPurchaseMax), daily: formatMoney(d.policy.dailyMax) });
  return s.policy;
}

/** "Budget envelope": the person approves one PayPal authorization for today. */
export async function openEnvelope(s: Session, amountText: string) {
  const p = s.policy.active;
  if (!p) throw new UserError("Activate a policy first.");
  const parsed = parseMoney(amountText, p.currency);
  if (!parsed.ok) throw new UserError(parsed.error);
  if (parsed.money.minor > p.dailyMax.minor) throw new UserError(`Budget can't exceed your daily cap of ${formatMoney(p.dailyMax)}.`);
  const day = s.today();
  const prev = s.envelope;
  if (prev?.status === "active" && prev.day === day) throw new UserError("Today's budget is already active. Release it before approving a new one.");
  if (prev?.status === "active" && prev.authorizationId) {
    // An older day's authorization would otherwise be orphaned: release it first.
    await s.paypal.voidAuthorization(prev.authorizationId);
    prev.status = "voided";
    s.log("system", "released an earlier day's budget before opening a new one", { authorizationId: prev.authorizationId, day: prev.day });
  }
  const ref = await s.paypal.createOrder({
    intent: "AUTHORIZE", amount: parsed.money, description: `Countersign agent budget for ${day}`,
    invoiceId: `CS-BUDGET-${day}-${randomUUID().slice(0, 6)}`, returnUrl: `${s.cfg.publicBase}/api/paypal/return?kind=envelope`,
    cancelUrl: `${s.cfg.publicBase}/?cancelled=1`, requestId: randomUUID(),
  });
  s.envelope = { orderId: ref.id, status: "awaiting_paypal", approveUrl: ref.approveUrl, authorizationId: null, amount: parsed.money, captured: { ...parsed.money, minor: 0 }, day, error: null };
  s.log("paypal", "budget order created (intent AUTHORIZE)", { orderId: ref.id, amount: formatMoney(parsed.money) });
  return s.envelope;
}

export async function voidEnvelope(s: Session) {
  const e = s.envelope;
  if (!e?.authorizationId || e.status !== "active") throw new UserError("No active budget to release.");
  await s.paypal.voidAuthorization(e.authorizationId);
  e.status = "voided";
  s.log("human", "budget released (authorization voided)", { authorizationId: e.authorizationId, unused: formatMoney({ ...e.amount, minor: e.amount.minor - e.captured.minor }) });
}

/** PayPal sends the buyer back here after approving an order. */
export async function onPayPalReturn(s: Session, orderId: string) {
  if (s.envelope?.orderId === orderId && s.envelope.status === "awaiting_paypal") {
    const e = s.envelope;
    try {
      const a = await s.paypal.authorizeOrder(orderId, `auth-${orderId}`);
      e.authorizationId = a.authorizationId;
      e.status = "active";
      e.approveUrl = null;
      s.log("paypal", "budget authorized", { authorizationId: a.authorizationId, expires: a.expiresAt });
    } catch (err) {
      e.status = "failed";
      e.error = errText(err);
      s.log("paypal", "budget authorization failed", { error: e.error });
    }
    return;
  }
  const rec = [...s.intents.values()].find((r) => r.checkoutOrderId === orderId);
  if (!rec) throw new UserError(`No pending checkout for PayPal order ${orderId}.`);
  if (rec.status !== "awaiting_paypal") return; // a reloaded return URL must not record a second order
  rec.status = "capturing";
  // Time has passed since the gate ran (other purchases, a new day): check again before money moves.
  const again = await recheck(s, rec);
  if (!again.ok) {
    rec.status = "denied";
    rec.error = `Not captured. Rechecked at PayPal return: ${again.why}`;
    s.log("gate", "checkout stopped at recheck", { intent: rec.intent.id, why: again.why });
    return;
  }
  try {
    const cap = await s.paypal.captureOrder(orderId, `cap-${orderId}`);
    await recordOrder(s, rec, cap.amount, { orderId, captureId: cap.captureId, authorizationId: null });
  } catch (err) {
    rec.status = "payment_failed";
    rec.error = errText(err);
    s.log("paypal", "checkout capture failed", { intent: rec.intent.id, error: rec.error });
  }
}

export async function runAgent(s: Session, goal: string, source: "demo" | "channel3") {
  if (!goal.trim()) throw new UserError("Tell the agent what to buy.");
  const catalog = s.catalogFor(source);
  const t0 = Date.now();
  let offers: Offer[];
  try {
    const cap = /\b(?:under|below|less than|max(?:imum)?|up to)\s*\$?\s?(\d+(?:\.\d+)?)/i.exec(goal);
    offers = await catalog.search(goal, { limit: 6, maxPrice: cap ? Number(cap[1]) : undefined });
  } catch (err) {
    throw new UserError(`Product search failed (${catalog.name}): ${errText(err)}`);
  }
  const pick = await pickProduct(s.llm, goal, offers);
  s.log("agent", "searched and picked", { catalog: catalog.name, query: goal, results: offers.length, pick: pick.value.offerId, by: pick.by, note: pick.note });
  if (!pick.value.offerId) return { candidates: offers, record: null, ms: Date.now() - t0 };
  const chosen = offers.find((o) => o.id === pick.value.offerId)!;
  // The pick call already screened every listing; reuse it instead of a second model call.
  const flag = pick.value.flags[chosen.id];
  const screen: Screen | undefined = pick.by === "rules" ? undefined : { flagged: Boolean(flag), reason: flag ?? "", by: pick.by };
  const record = await proposeIntent(s, {
    offerId: chosen.id, quantity: pick.value.quantity, claimedUnitPrice: chosen.price, agentReason: pick.value.reason, goal,
  }, source, pick.by, pick.note, screen);
  return { candidates: offers, record, ms: Date.now() - t0 };
}

/** Runs the gate against a fresh listing and current spend (other open purchases included). */
async function gateFor(s: Session, intent: PurchaseIntent, source: "demo" | "channel3", screen: Screen | null | undefined) {
  let offer: Offer | null = null;
  let lookupError: string | null = null;
  try {
    offer = await s.catalogFor(source).get(intent.offerId); // fresh truth, not the agent's copy
  } catch (err) {
    lookupError = errText(err);
  }
  // Intents that did not come from a model pick get their own screen of the fresh listing text.
  const finalScreen = !offer ? null : screen !== undefined ? screen : await screenListing(s.llm, offer.title, offer.description);
  const gate = evaluate(intent, {
    policy: s.policy.active, offer, spentToday: s.committedToday(intent.id), now: s.now(), envelopeRemaining: s.envelopeRemaining(), screen: finalScreen,
  });
  if (lookupError) {
    gate.checks.unshift({ id: "lookup", label: "Fresh listing lookup", outcome: "fail", detail: `Lookup failed: ${lookupError}` });
    gate.verdict = "DENY";
    gate.headline = "Blocked: the listing could not be re-read.";
  }
  return { offer, gate, screen: finalScreen };
}

const asksOf = (g: GateResult) => g.checks.filter((c) => c.outcome === "ask" && c.id !== "funding").map((c) => c.id);

/** Re-evaluates a purchase. OK only if it is now allowed, or asks nothing the person hasn't already approved. */
async function recheck(s: Session, rec: IntentRecord): Promise<{ ok: boolean; why: string }> {
  const { offer, gate } = await gateFor(s, rec.intent, rec.source, rec.screen);
  const newAsks = asksOf(gate).filter((id) => !rec.approvedAsks.includes(id));
  rec.offer = offer;
  rec.gate = gate;
  if (gate.verdict === "DENY") return { ok: false, why: gate.headline };
  if (newAsks.length) return { ok: false, why: `new questions: ${newAsks.join(", ")}` };
  return { ok: true, why: "" };
}

/** The single door every purchase goes through. */
export async function proposeIntent(
  s: Session, i: Omit<PurchaseIntent, "id">, source: "demo" | "channel3", by = "agent", pickNote: string | null = null, screen?: Screen,
): Promise<IntentRecord> {
  const intent: PurchaseIntent = { ...i, id: `int_${randomUUID().slice(0, 8)}` };
  const { offer, gate, screen: used } = await gateFor(s, intent, source, screen);
  const status = gate.verdict === "ALLOW" ? "allowed" : gate.verdict === "ASK" ? "needs_you" : "denied";
  const rec: IntentRecord = {
    intent, offer, gate, status, by, pickNote, source, screen: used, approvedAsks: [],
    checkoutOrderId: null, approveUrl: null, error: null, orderId: null, at: s.now().toISOString(),
  };
  s.intents.set(intent.id, rec);
  s.log("gate", `verdict ${gate.verdict}`, { intent: intent.id, item: offer?.title ?? i.offerId, total: gate.total ? formatMoney(gate.total) : null, failed: gate.checks.filter((c) => c.outcome !== "pass").map((c) => c.id) });
  if (gate.verdict === "ALLOW") await pay(s, rec);
  return rec;
}

export async function decide(s: Session, intentId: string, decision: "approve" | "reject") {
  const rec = s.intents.get(intentId);
  if (!rec) throw new UserError("Unknown purchase.");
  if (rec.status !== "needs_you") throw new UserError(`This purchase is ${rec.status.replace("_", " ")}; only "needs you" items take a decision.`);
  const shown = asksOf(rec.gate);
  s.log("human", decision === "approve" ? "approved purchase" : "rejected purchase", { intent: intentId, reasons: shown });
  if (decision === "reject") {
    rec.status = "rejected";
    return rec;
  }
  rec.approvedAsks = shown;
  const again = await recheck(s, rec); // spend, price or rules may have changed since the card was shown
  if (!again.ok) {
    if (rec.gate.verdict === "DENY") rec.status = "denied";
    rec.approvedAsks = [];
    s.log("gate", "approval refused at recheck", { intent: intentId, why: again.why });
    throw new UserError(`Something changed since you looked (${again.why}). The card is updated; review it again.`);
  }
  rec.status = "allowed";
  await pay(s, rec);
  return rec;
}

async function pay(s: Session, rec: IntentRecord) {
  const offer = rec.offer!;
  const total = rec.gate.total!;
  const remaining = s.envelopeRemaining();
  const e = s.envelope;
  try {
    if (e && remaining && remaining.currency === total.currency && total.minor <= remaining.minor && e.authorizationId) {
      const cap = await s.paypal.captureAuthorization(e.authorizationId, total, false, `CS-${rec.intent.id}`, `cap-${rec.intent.id}`);
      e.captured = { ...e.captured, minor: e.captured.minor + total.minor };
      s.log("paypal", "partial capture from budget (final_capture=false)", { captureId: cap.captureId, amount: formatMoney(total), left: formatMoney({ ...e.amount, minor: e.amount.minor - e.captured.minor }) });
      await recordOrder(s, rec, total, { orderId: e.orderId, captureId: cap.captureId, authorizationId: e.authorizationId });
      return;
    }
    const ref = await s.paypal.createOrder({
      intent: "CAPTURE", amount: total, description: offer.title, invoiceId: `CS-${rec.intent.id}`,
      returnUrl: `${s.cfg.publicBase}/api/paypal/return?kind=checkout`, cancelUrl: `${s.cfg.publicBase}/?cancelled=1`, requestId: `ord-${rec.intent.id}`,
    });
    rec.status = "awaiting_paypal";
    rec.checkoutOrderId = ref.id;
    rec.approveUrl = ref.approveUrl;
    s.log("paypal", "checkout order created (needs PayPal approval)", { orderId: ref.id, amount: formatMoney(total) });
  } catch (err) {
    rec.status = "payment_failed";
    rec.error = errText(err);
    s.log("paypal", "payment failed", { intent: rec.intent.id, error: rec.error });
  }
}

async function recordOrder(s: Session, rec: IntentRecord, total: Money, pp: OrderRecord["paypal"]) {
  const offer = rec.offer!;
  const placed = s.now();
  const days = offer.deliveryDays ?? 5;
  const o: OrderRecord = {
    id: `ord_${randomUUID().slice(0, 8)}`, intentId: rec.intent.id, offer, quantity: rec.intent.quantity, total,
    placedAt: placed.toISOString(), paypal: pp,
    shipment: {
      carrier: "USPS", trackingNumber: `9400${String(Math.floor(Math.random() * 1e15)).padStart(15, "0")}`.slice(0, 22),
      promisedBy: new Date(placed.getTime() + days * 86_400_000).toISOString(),
      events: planShipment(placed, days, s.nextShipPlan),
    },
    refunds: [], issue: null, disputeId: null,
  };
  s.orders.unshift(o);
  rec.status = "paid";
  rec.orderId = o.id;
  rec.approveUrl = null;
  s.log("system", "order recorded", { order: o.id, total: formatMoney(total), captureId: pp.captureId, shipPlan: s.nextShipPlan });
  try {
    await s.paypal.addTracking(pp.orderId, pp.captureId, o.shipment.carrier, o.shipment.trackingNumber);
    s.log("paypal", "tracking added to order", { orderId: pp.orderId, tracking: o.shipment.trackingNumber });
  } catch (err) {
    o.shipment.trackingError = errText(err);
    s.log("paypal", "adding tracking failed (order kept)", { error: o.shipment.trackingError });
  }
}

export { errText };
