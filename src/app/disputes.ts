// After-purchase flows. Buyer side: notice a problem, build the case, file it.
// Merchant side: read PayPal disputes, match them to the ledger, draft a
// response, and submit only after a person approves the exact text.
import { randomUUID } from "node:crypto";
import { buyerCase, merchantCase, remaining, type CaseFile, type MerchantAction } from "../domain/disputeCase.js";
import { formatMoney } from "../domain/money.js";
import { planShipment, type ShipPlan } from "../domain/orders.js";
import { draftNote } from "../llm/tasks.js";
import { REHEARSAL_PREFIX } from "../paypal/rehearsal.js";
import { plural } from "../domain/text.js";
import type { Dispute } from "../paypal/types.js";
import { UserError, errText } from "./commerce.js";
import type { Session } from "./session.js";

const order = (s: Session, id: string) => {
  const o = s.orders.find((x) => x.id === id);
  if (!o) throw new UserError("Unknown order.");
  return o;
};

async function cachedDraft(s: Session, key: string, make: () => ReturnType<typeof draftNote>) {
  const hit = s.drafts.get(key);
  if (hit) return hit;
  const v = await make();
  s.drafts.set(key, v);
  return v;
}

export function advanceClock(s: Session, days: number) {
  if (!(days > 0 && days <= 60)) throw new UserError("Advance between 1 and 60 days.");
  s.clockOffsetMs += days * 86_400_000;
  s.log("system", `simulated clock advanced ${plural(days, "day")}`, { now: s.now().toISOString() });
}

/** Simulation control: change what the (simulated) carrier does with a parcel. */
export function setShipPlan(s: Session, orderId: string, plan: ShipPlan) {
  const o = order(s, orderId);
  o.shipment.events = planShipment(new Date(o.placedAt), o.offer.deliveryDays ?? 5, plan);
  s.log("system", "carrier simulation set", { order: orderId, plan });
}

export function reportDamage(s: Session, orderId: string, note: string) {
  const o = order(s, orderId);
  if (!note.trim()) throw new UserError("Describe what's wrong.");
  o.issue = { kind: "damaged", reportedAt: s.now().toISOString(), note: note.trim().slice(0, 300) };
  s.log("human", "reported a problem", { order: orderId, note: o.issue.note });
}

export async function buyerCaseFor(s: Session, orderId: string) {
  const o = order(s, orderId);
  const c = buyerCase(o, s.now());
  const draft = c.action.startsWith("FILE") ? await cachedDraft(s, `buyer:${o.id}:${c.action}:${c.rationale}`, () => draftNote(s.llm, "buyer", c.action, c.rationale, c.facts)) : null;
  return { order: o, case: c, draft };
}

export async function fileBuyerDispute(s: Session, orderId: string, note: string, rehearse = false) {
  const o = order(s, orderId);
  const c = buyerCase(o, s.now());
  if (!c.action.startsWith("FILE")) throw new UserError(`Not fileable: ${c.rationale}`);
  if (!note.trim()) throw new UserError("Approve or edit the note before filing.");
  s.log("human", "approved buyer claim text", { order: orderId, chars: note.length });
  const reason = c.action === "FILE_NOT_RECEIVED" ? "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" : "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
  if (!s.sim) {
    if (o.disputeId) throw new UserError(`This order already has dispute ${o.disputeId}.`);
    if (rehearse && s.rehearsal) {
      // Labeled stand-in, never sent to PayPal. Any refund it leads to is a real sandbox refund.
      const d = s.rehearsal.open(o.paypal.captureId, remaining(o), reason, note.trim());
      o.disputeId = d.id;
      s.log("copilot", "rehearsal dispute opened (not in PayPal; refunds will be real sandbox refunds)", { dispute: d.id, reason });
      return { filed: true, dispute: d, rehearsal: true };
    }
    // PayPal has no public API for a buyer to open a dispute; in sandbox the buyer files in the Resolution Center.
    s.log("copilot", "claim packet ready for PayPal Resolution Center", { order: orderId, reason });
    return {
      filed: false, rehearsalAvailable: Boolean(s.rehearsal), captureId: o.paypal.captureId,
      instructions: "Log in to sandbox.paypal.com as the sandbox buyer, open Resolution Center, report this transaction and paste the note. Then press Refresh disputes on the merchant desk. No time for that? Open a rehearsal dispute instead: it stays in this app, is labeled REHEARSAL, and any refund it leads to is a real sandbox refund.",
    };
  }
  const d = s.sim.openDisputeAsBuyer(o.paypal.captureId, reason, note.trim());
  o.disputeId = d.id;
  s.log("paypal", "dispute opened (simulated Resolution Center)", { dispute: d.id, reason, amount: d.amount ? formatMoney(d.amount) : null });
  return { filed: true, dispute: d };
}

export interface MerchantCaseView {
  dispute: Dispute;
  orderId: string | null;
  case: CaseFile<MerchantAction>;
  draft: { value: string; by: string; note: string | null } | null;
}

export async function merchantCases(s: Session): Promise<{ cases: MerchantCaseView[]; error: string | null; hidden?: number }> {
  const captures = s.orders.map((o) => o.paypal.captureId);
  let disputes: Dispute[] = s.rehearsal?.list(captures) ?? [];
  let error: string | null = null;
  try {
    disputes = [...(await s.paypal.listDisputes(captures)), ...disputes];
  } catch (err) {
    error = `Couldn't read disputes from PayPal: ${errText(err)}`; // shown, not treated as "no disputes"
  }
  // The sandbox merchant account is shared by every visitor of a hosted demo:
  // only disputes on this session's own captures are shown or actionable.
  const mine = disputes.filter((d) => ownDispute(s, d));
  const hidden = disputes.length - mine.length;
  const cases = await Promise.all(mine.map(async (d) => {
    const o = s.orders.find((x) => d.captureIds.includes(x.paypal.captureId)) ?? null;
    const c = merchantCase(d, o, s.now());
    const draft = c.action !== "NONE" ? await cachedDraft(s, `merchant:${d.id}:${d.status}:${c.action}`, () => draftNote(s.llm, "merchant", c.action, c.rationale, c.facts)) : null;
    return { dispute: d, orderId: o?.id ?? null, case: c, draft };
  }));
  return { cases, error, hidden };
}

const ownDispute = (s: Session, d: Dispute) => s.orders.some((o) => d.captureIds.includes(o.paypal.captureId));

const isRehearsal = (s: Session, id: string) => Boolean(s.rehearsal?.has(id));
async function fetchDispute(s: Session, id: string): Promise<Dispute> {
  if (isRehearsal(s, id)) return s.rehearsal!.get(id);
  // A REHEARSAL- id never goes to PayPal, even one this session doesn't hold (expired, or another visitor's).
  if (id.startsWith(REHEARSAL_PREFIX)) throw new UserError("Unknown rehearsal dispute. Rehearsals live only in the browser session that opened them.");
  return s.paypal.getDispute(id);
}

/** Rehearsal disputes never reach PayPal, but their refunds do: Payments v2 refund on the capture. */
async function realRefund(s: Session, d: Dispute, note: string) {
  const o = s.orders.find((x) => d.captureIds.includes(x.paypal.captureId));
  if (!o) throw new UserError("No order for this dispute.");
  const amount = remaining(o);
  if (amount.minor <= 0) return;
  const r = await s.paypal.refundCapture(o.paypal.captureId, amount, note, `rf-${d.id}`);
  o.refunds.push({ id: r.refundId, amount: r.amount, at: s.now().toISOString(), fromPayPal: true });
  s.log("paypal", "sandbox refund issued for rehearsal dispute", { dispute: d.id, refundId: r.refundId, amount: formatMoney(r.amount) });
}

async function myDispute(s: Session, disputeId: string): Promise<Dispute> {
  const d = await fetchDispute(s, disputeId);
  if (!ownDispute(s, d)) throw new UserError("That dispute isn't on one of your orders.");
  return d;
}

export async function submitMerchantResponse(s: Session, disputeId: string, action: MerchantAction, note: string) {
  const d = await myDispute(s, disputeId);
  const o = s.orders.find((x) => d.captureIds.includes(x.paypal.captureId)) ?? null;
  const c = merchantCase(d, o, s.now());
  if (c.blocked) throw new UserError(`Can't submit: ${c.rationale}`);
  if (c.action !== action) throw new UserError(`The case changed: the copilot now recommends ${c.action}. Review it again.`);
  if (!note.trim()) throw new UserError("Approve or edit the note before submitting.");
  s.log("human", "approved merchant response", { dispute: disputeId, action });
  if (d.rehearsal) return rehearsalResponse(s, d, action, note);
  try {
    if (action === "PROVIDE_FULFILLMENT" && o) {
      await s.paypal.provideEvidence(disputeId, { type: "PROOF_OF_FULFILLMENT", note, tracking: { carrier: o.shipment.carrier, trackingNumber: o.shipment.trackingNumber } });
    } else if (action === "PROVIDE_REFUND_PROOF" && o) {
      // Only real PayPal refund IDs count as proof; dispute-driven refunds have none of their own.
      await s.paypal.provideEvidence(disputeId, { type: "PROOF_OF_REFUND", note, refundIds: o.refunds.filter((r) => r.fromPayPal).map((r) => r.id) });
    } else if (action === "ACCEPT_CLAIM") {
      await s.paypal.acceptClaim(disputeId, note, null);
      if (o && d.amount) o.refunds.push({ id: `claim-${disputeId}`, amount: d.amount, at: s.now().toISOString(), fromPayPal: false });
    } else if (action === "OFFER_REFUND_WITH_RETURN" && o) {
      await s.paypal.makeOffer(disputeId, note, remaining(o), "REFUND_WITH_RETURN");
    } else throw new UserError("Nothing to submit for this case.");
  } catch (err) {
    if (err instanceof UserError) throw err;
    s.log("paypal", "dispute response failed", { dispute: disputeId, error: errText(err) });
    throw new UserError(errText(err));
  }
  s.log("paypal", `dispute response sent: ${action}`, { dispute: disputeId });
  return s.paypal.getDispute(disputeId);
}

/** What the person is told after approving a merchant response: a rehearsal never reaches PayPal. */
export function responseMessage(s: Session, d: Dispute): string {
  if (!d.rehearsal) return s.paypal.mode === "sandbox" ? "Response sent to PayPal (sandbox Disputes API)." : "Response sent to the simulated PayPal.";
  const refunded = s.orders.some((o) => d.captureIds.includes(o.paypal.captureId) && o.refunds.some((r) => r.fromPayPal));
  return `Rehearsal: recorded in this app, not sent to PayPal.${refunded ? " Refund issued in the PayPal sandbox." : ""}`;
}

async function rehearsalResponse(s: Session, d: Dispute, action: MerchantAction, note: string): Promise<Dispute> {
  const rh = s.rehearsal!;
  try {
    if (action === "PROVIDE_FULFILLMENT" || action === "PROVIDE_REFUND_PROOF") rh.provideEvidence(d.id);
    else if (action === "OFFER_REFUND_WITH_RETURN") rh.makeOffer(d.id);
    else if (action === "ACCEPT_CLAIM") {
      if (!rh.canResolve(d.id, ["WAITING_FOR_SELLER_RESPONSE", "OPEN"])) throw new UserError(`Dispute is ${d.status}; nothing to accept.`);
      await realRefund(s, d, note);
      rh.acceptClaim(d.id);
    } else throw new UserError("Nothing to submit for this case.");
  } catch (err) {
    if (err instanceof UserError) throw err;
    s.log("paypal", "rehearsal dispute response failed", { dispute: d.id, error: errText(err) });
    throw new UserError(errText(err));
  }
  s.log("copilot", `rehearsal dispute response recorded: ${action}`, { dispute: d.id });
  return rh.get(d.id);
}

export async function simulateDecision(s: Session, disputeId: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR") {
  const mine = await myDispute(s, disputeId);
  if (mine.rehearsal) {
    if (!s.rehearsal!.canResolve(disputeId, ["UNDER_REVIEW"])) throw new UserError(`Dispute is ${mine.status}; only disputes under review can be decided.`);
    if (outcome === "BUYER_FAVOR") await realRefund(s, mine, "Refund after dispute review.");
    s.rehearsal!.adjudicate(disputeId, outcome);
    s.log("copilot", "rehearsal adjudication", { dispute: disputeId, outcome });
    return s.rehearsal!.get(disputeId);
  }
  await s.paypal.simulateAdjudicate(disputeId, outcome);
  s.log("paypal", "sandbox adjudication", { dispute: disputeId, outcome });
  const d = await s.paypal.getDispute(disputeId);
  const o = s.orders.find((x) => d.captureIds.includes(x.paypal.captureId));
  if (o && outcome === "BUYER_FAVOR" && d.amount) o.refunds.push({ id: `adj-${randomUUID().slice(0, 6)}`, amount: d.amount, at: s.now().toISOString(), fromPayPal: false });
  return d;
}
