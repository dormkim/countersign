// Dispute copilot core: the same evidence engine serves the buyer (whose agent
// bought something that went wrong) and the merchant (who must answer a PayPal
// dispute before its deadline). Decisions and dates are computed here; a model
// only writes the wording, and its wording is checked against these facts.
import { formatMoney, sub, type Money } from "./money.js";
import { daysBetween, delivered, visibleEvents, type OrderRecord } from "./orders.js";
import type { Dispute } from "../paypal/types.js";

export interface Fact {
  label: string;
  value: string;
  source: string; // where it came from, e.g. "PayPal capture 3C6..." or "USPS tracking 9400..."
}

export type BuyerAction = "WAIT" | "FILE_NOT_RECEIVED" | "FILE_NOT_AS_DESCRIBED" | "NONE";
export type MerchantAction = "PROVIDE_FULFILLMENT" | "PROVIDE_REFUND_PROOF" | "ACCEPT_CLAIM" | "OFFER_REFUND_WITH_RETURN" | "NONE";

export interface CaseFile<A> {
  action: A;
  rationale: string; // deterministic, one line
  facts: Fact[];
  deadline: { label: string; at: string; hoursLeft: number } | null;
  blocked: string | null; // why nothing can be submitted, if so
}

const BUYER_FILING_WINDOW_DAYS = 180; // PayPal Buyer Protection: report within 180 days of payment
const LATE_GRACE_DAYS = 2;

export function buyerCase(o: OrderRecord, now: Date): CaseFile<BuyerAction> {
  const placed = new Date(o.placedAt);
  const promised = new Date(o.shipment.promisedBy);
  const fileBy = new Date(placed.getTime() + BUYER_FILING_WINDOW_DAYS * 86_400_000);
  const facts = baseFacts(o, now);
  const deadline = { label: "PayPal filing window closes", at: fileBy.toISOString(), hoursLeft: hours(now, fileBy) };
  const refunded = o.refunds.reduce((sum, r) => sum + r.amount.minor, 0);
  if (refunded >= o.total.minor) return { action: "NONE", rationale: `Refunded in full (${formatMoney({ ...o.total, minor: refunded })}).`, facts, deadline, blocked: "refunded" };
  if (o.disputeId) return { action: "NONE", rationale: `Dispute ${o.disputeId} is filed; the merchant has to respond.`, facts, deadline, blocked: "already filed" };
  if (now > fileBy) return { action: "NONE", rationale: "The 180-day window has passed.", facts, deadline, blocked: "filing window closed" };

  const got = delivered(o, now);
  if (o.issue?.kind === "damaged" && got) {
    facts.push({ label: "Reported problem", value: o.issue.note, source: `buyer report ${day(o.issue.reportedAt)}` });
    return { action: "FILE_NOT_AS_DESCRIBED", rationale: "Delivered, but you reported it arrived damaged.", facts, deadline, blocked: null };
  }
  if (got) return { action: "NONE", rationale: `Delivered on ${day(got.at)}. Nothing to dispute.`, facts, deadline, blocked: null };

  const late = daysBetween(promised, now);
  if (late < LATE_GRACE_DAYS) {
    const earliest = new Date(promised.getTime() + LATE_GRACE_DAYS * 86_400_000);
    return { action: "WAIT", rationale: `Not late enough yet. Earliest sensible filing: ${day(earliest.toISOString())}.`, facts, deadline, blocked: null };
  }
  facts.push({ label: "Days past promised delivery", value: String(Math.floor(late)), source: "computed from promised date and today" });
  return {
    action: "FILE_NOT_RECEIVED",
    rationale: `No delivery scan ${Math.floor(late)} days after the promised date.`,
    facts, deadline, blocked: null,
  };
}

export function merchantCase(d: Dispute, o: OrderRecord | null, now: Date): CaseFile<MerchantAction> {
  const facts: Fact[] = [
    { label: "Dispute", value: `${d.id} (${prettyReason(d.reason)})`, source: "PayPal Disputes API" },
    { label: "Status", value: `${d.status}${d.stage ? ` / ${d.stage}` : ""}`, source: "PayPal Disputes API" },
  ];
  if (d.amount) facts.push({ label: "Disputed amount", value: formatMoney(d.amount), source: "dispute_amount" });
  const due = d.sellerResponseDue ? new Date(d.sellerResponseDue) : null;
  const deadline = due ? { label: "Seller response due", at: due.toISOString(), hoursLeft: hours(now, due) } : null;

  if (d.status === "RESOLVED") return { action: "NONE", rationale: `Resolved${d.outcome ? `: ${d.outcome}` : ""}.`, facts, deadline, blocked: "resolved" };
  if (due && now > due) {
    return { action: "NONE", rationale: `The response window closed on ${day(due.toISOString())}. PayPal can decide without your evidence.`, facts, deadline, blocked: "deadline passed" };
  }
  if (d.status !== "WAITING_FOR_SELLER_RESPONSE" && d.status !== "OPEN") {
    return { action: "NONE", rationale: `Status is ${d.status}; nothing for the seller to send right now.`, facts, deadline, blocked: "not awaiting seller" };
  }
  if (!o) {
    return { action: "NONE", rationale: `No order in the ledger matches capture ${d.captureIds.join(", ") || "(none listed)"}. Review it by hand.`, facts, deadline, blocked: "no matching order" };
  }
  facts.push(...baseFacts(o, now));

  const refunded = o.refunds.reduce((s, r) => s + r.amount.minor, 0);
  if (refunded >= o.total.minor) {
    facts.push({ label: "Refunded", value: formatMoney({ currency: o.total.currency, minor: refunded }), source: `refund ${o.refunds.map((r) => r.id).join(", ")}` });
    return { action: "PROVIDE_REFUND_PROOF", rationale: "The buyer was already refunded in full.", facts, deadline, blocked: null };
  }
  const got = delivered(o, now);
  if (d.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED") {
    if (got) return { action: "PROVIDE_FULFILLMENT", rationale: `Carrier scanned it delivered on ${day(got.at)}. Send the tracking proof.`, facts, deadline, blocked: null };
    return { action: "ACCEPT_CLAIM", rationale: "The carrier never scanned it delivered. Contesting would likely lose, so refund and close.", facts, deadline, blocked: null };
  }
  if (d.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") {
    if (d.stage === "INQUIRY" && (o.offer.returnDays ?? 0) > 0) {
      return { action: "OFFER_REFUND_WITH_RETURN", rationale: `Your listing allows ${o.offer.returnDays}-day returns: offer a refund once the item comes back.`, facts, deadline, blocked: null };
    }
    return { action: "ACCEPT_CLAIM", rationale: "Damage claim past inquiry stage with no return option: refund rather than contest.", facts, deadline, blocked: null };
  }
  return { action: "NONE", rationale: `Reason ${d.reason} needs a person; the copilot only drafts delivery and condition cases.`, facts, deadline, blocked: "unsupported reason" };
}

function baseFacts(o: OrderRecord, now: Date): Fact[] {
  const last = visibleEvents(o, now).at(-1);
  return [
    { label: "Item", value: `${o.quantity} x ${o.offer.title}`, source: `order ${o.id}` },
    { label: "Paid", value: formatMoney(o.total), source: `PayPal capture ${o.paypal.captureId}` },
    { label: "Paid on", value: day(o.placedAt), source: `PayPal capture ${o.paypal.captureId}` },
    { label: "Promised delivery", value: day(o.shipment.promisedBy), source: `listing estimate ${o.offer.deliveryDays ?? "?"} days` },
    { label: "Tracking", value: `${o.shipment.carrier} ${o.shipment.trackingNumber}`, source: "added to the PayPal order" },
    { label: "Last carrier scan", value: last ? `${last.status.replace(/_/g, " ").toLowerCase()} at ${last.where}, ${day(last.at)}` : "none", source: `${o.shipment.carrier} tracking` },
  ];
}

export function remaining(o: OrderRecord): Money {
  const refunded = o.refunds.reduce((s, r) => s + r.amount.minor, 0);
  return sub(o.total, { currency: o.total.currency, minor: refunded });
}

export const prettyReason = (r: string): string =>
  r === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" ? "item not received"
    : r === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" ? "not as described" : r.toLowerCase().replace(/_/g, " ");

const hours = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 3_600_000);
export const day = (iso: string): string => iso.slice(0, 10);
