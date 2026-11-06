// JSON API. Each handler returns data; errors become {error} with a status code.
import { activatePolicy, decide, draftPolicyFor, onPayPalReturn, openEnvelope, runAgent, voidEnvelope, UserError } from "../app/commerce.js";
import { advanceClock, buyerCaseFor, fileBuyerDispute, merchantCases, reportDamage, setShipPlan, simulateDecision, submitMerchantResponse } from "../app/disputes.js";
import type { Session } from "../app/session.js";
import { previewSplit, sendSplitInvoices } from "../app/split.js";
import type { ShipPlan } from "../domain/orders.js";
import type { Member } from "../domain/split.js";
import { snapshot } from "./snapshot.js";

type Body = Record<string, unknown>;
type Handler = (s: Session, body: Body, params: string[], query: URLSearchParams) => Promise<unknown>;

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const PLANS: ShipPlan[] = ["on_time", "stalled", "damaged"];
const source = (v: unknown) => (v === "channel3" ? "channel3" : "demo") as "demo" | "channel3";

function members(v: unknown): Member[] {
  if (!Array.isArray(v) || v.length > 12) throw new UserError("Add 1-12 people.");
  return v.map((m: Body) => ({ name: str(m.name, 60) || "Friend", email: str(m.email, 120), weight: num(m.weight) }));
}

export const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/api\/state$/, async (s) => snapshot(s)],
  ["POST", /^\/api\/policy\/draft$/, async (s, b) => { await draftPolicyFor(s, str(b.text), str(b.tz, 64) || "America/Los_Angeles"); return snapshot(s); }],
  ["POST", /^\/api\/policy\/activate$/, async (s) => { activatePolicy(s); return snapshot(s); }],
  ["POST", /^\/api\/envelope$/, async (s, b) => { await openEnvelope(s, str(b.amount, 20)); return snapshot(s); }],
  ["POST", /^\/api\/envelope\/void$/, async (s) => { await voidEnvelope(s); return snapshot(s); }],
  ["POST", /^\/api\/agent\/run$/, async (s, b) => {
    const r = await runAgent(s, str(b.goal, 300), source(b.source));
    return { ...snapshot(s), run: { candidates: r.candidates.map((o) => ({ id: o.id, title: o.title, price: o.price, merchant: o.merchant.name })), intentId: r.record?.intent.id ?? null, ms: r.ms } };
  }],
  ["POST", /^\/api\/intents\/([\w-]+)\/decide$/, async (s, b, [id]) => { await decide(s, id!, b.decision === "approve" ? "approve" : "reject"); return snapshot(s); }],
  ["POST", /^\/api\/ship-plan$/, async (s, b) => {
    const p = str(b.plan) as ShipPlan;
    if (!PLANS.includes(p)) throw new UserError("Unknown plan.");
    s.nextShipPlan = p;
    return snapshot(s);
  }],
  ["POST", /^\/api\/orders\/([\w-]+)\/ship-plan$/, async (s, b, [id]) => {
    const p = str(b.plan) as ShipPlan;
    if (!PLANS.includes(p)) throw new UserError("Unknown plan.");
    setShipPlan(s, id!, p);
    return snapshot(s);
  }],
  ["POST", /^\/api\/orders\/([\w-]+)\/report$/, async (s, b, [id]) => { reportDamage(s, id!, str(b.note, 300)); return snapshot(s); }],
  ["GET", /^\/api\/orders\/([\w-]+)\/case$/, async (s, _b, [id]) => buyerCaseFor(s, id!)],
  ["POST", /^\/api\/orders\/([\w-]+)\/file$/, async (s, b, [id]) => ({ ...(await fileBuyerDispute(s, id!, str(b.note, 2000), b.rehearse === true)), state: snapshot(s) })],
  ["POST", /^\/api\/clock\/advance$/, async (s, b) => { advanceClock(s, num(b.days)); return snapshot(s); }],
  ["GET", /^\/api\/merchant\/disputes$/, async (s) => merchantCases(s)],
  ["POST", /^\/api\/merchant\/disputes\/([\w-]+)\/submit$/, async (s, b, [id]) => {
    const d = await submitMerchantResponse(s, id!, str(b.action) as never, str(b.note, 2000));
    return { dispute: d, state: snapshot(s) };
  }],
  ["POST", /^\/api\/merchant\/disputes\/([\w-]+)\/simulate$/, async (s, b, [id]) => {
    const d = await simulateDecision(s, id!, b.outcome === "SELLER_FAVOR" ? "SELLER_FAVOR" : "BUYER_FAVOR");
    return { dispute: d, state: snapshot(s) };
  }],
  ["POST", /^\/api\/split\/preview$/, async (_s, b) => previewSplit(str(b.total, 20), str(b.currency, 3) || "USD", members(b.members), str(b.payerEmail, 120))],
  ["POST", /^\/api\/split\/send$/, async (s, b) => ({
    ...(await sendSplitInvoices(s, str(b.title, 80) || "Shared purchase", str(b.total, 20), str(b.currency, 3) || "USD", members(b.members), str(b.payerEmail, 120))),
    state: snapshot(s),
  })],
  ["GET", /^\/api\/paypal\/return$/, async (s, _b, _p, q) => { await onPayPalReturn(s, q.get("token") ?? ""); return { redirect: "/#shop" }; }],
];
