// Sandbox mode without a real Resolution Center dispute: the demo must still
// finish, with a labeled rehearsal dispute whose refund goes through the
// payments port (a real sandbox refund in production). The simulator stands in
// for the sandbox adapter here, so s.sim is null exactly as in sandbox mode.
import { describe, expect, it } from "vitest";
import { activatePolicy, draftPolicyFor, onPayPalReturn, openEnvelope, proposeIntent } from "../src/app/commerce.js";
import type { Config } from "../src/app/config.js";
import { advanceClock, fileBuyerDispute, responseMessage, merchantCases, setShipPlan, simulateDecision, submitMerchantResponse } from "../src/app/disputes.js";
import { Session } from "../src/app/session.js";
import { DEMO_OFFERS, DemoCatalog } from "../src/catalog/demoCatalog.js";
import { SimulatedPayPal } from "../src/paypal/simulated.js";

const aurora = DEMO_OFFERS.find((o) => o.title.startsWith("Aurora"))!;

async function sandboxLikeSession() {
  let s: Session | null = null;
  const pp = new SimulatedPayPal(() => s!.now(), "http://t/approve");
  const cfg: Config = { port: 0, publicBase: "http://t", llm: null, demo: new DemoCatalog(), channel3: null, sandbox: pp as never };
  s = new Session(cfg);
  await draftPolicyFor(s, "Up to $150 per purchase and $250 a day. No gift cards.", "America/Los_Angeles");
  activatePolicy(s);
  const e = await openEnvelope(s, "200");
  pp.approve(e.orderId);
  await onPayPalReturn(s, e.orderId);
  await proposeIntent(s, { offerId: aurora.id, quantity: 1, claimedUnitPrice: aurora.price, agentReason: "t", goal: "t" }, "demo");
  const o = s.orders[0]!;
  setShipPlan(s, o.id, "stalled");
  advanceClock(s, 6);
  return { s, o, pp };
}

describe("sandbox rehearsal disputes", () => {
  it("without rehearse: no dispute is invented, instructions and the rehearsal option are returned", async () => {
    const { s, o } = await sandboxLikeSession();
    expect(s.sim).toBeNull();
    const r = await fileBuyerDispute(s, o.id, "Never arrived.");
    expect(r).toMatchObject({ filed: false, rehearsalAvailable: true });
    expect((await merchantCases(s)).cases).toHaveLength(0);
  });

  it("rehearsal accept-claim issues a refund through the payments port and resolves", async () => {
    const { s, o } = await sandboxLikeSession();
    const r = (await fileBuyerDispute(s, o.id, "Never arrived.", true)) as { filed: boolean; dispute: { id: string; rehearsal?: boolean } };
    expect(r.filed).toBe(true);
    expect(r.dispute.id.startsWith("REHEARSAL-")).toBe(true);
    const { cases } = await merchantCases(s);
    const v = cases.find((c) => c.dispute.id === r.dispute.id)!;
    expect(v.dispute.rehearsal).toBe(true);
    expect(v.case.action).toBe("ACCEPT_CLAIM");
    const d = await submitMerchantResponse(s, r.dispute.id, "ACCEPT_CLAIM", v.draft!.value);
    expect(d.outcome).toBe("RESOLVED_BUYER_FAVOR");
    expect(o.refunds).toHaveLength(1);
    expect(o.refunds[0]!.fromPayPal).toBe(true);
    expect(o.refunds[0]!.amount.minor).toBe(o.total.minor);
    expect(responseMessage(s, d)).toBe("Rehearsal: recorded in this app, not sent to PayPal. Refund issued in the PayPal sandbox.");
    await expect(fileBuyerDispute(s, o.id, "again", true)).rejects.toThrow(); // already refunded and disputed: nothing to file
  });

  it("rehearsal adjudication for the buyer refunds; for the seller it does not", async () => {
    for (const outcome of ["BUYER_FAVOR", "SELLER_FAVOR"] as const) {
      const { s, o } = await sandboxLikeSession();
      const r = (await fileBuyerDispute(s, o.id, "Never arrived.", true)) as { dispute: { id: string } };
      s.rehearsal!.provideEvidence(r.dispute.id);
      const d = await simulateDecision(s, r.dispute.id, outcome);
      expect(d.status).toBe("RESOLVED");
      expect(o.refunds.length).toBe(outcome === "BUYER_FAVOR" ? 1 : 0);
    }
  });
});
