// What the browser sees. Secrets and raw provider payloads never leave the server.
import { buyerCase } from "../domain/disputeCase.js";
import { visibleEvents } from "../domain/orders.js";
import type { Session } from "../app/session.js";

export function snapshot(s: Session) {
  const now = s.now();
  return {
    modes: {
      paypal: s.paypal.mode,
      ai: s.llm?.name ?? null,
      channel3: Boolean(s.cfg.channel3),
    },
    now: now.toISOString(),
    clockOffsetDays: Math.round(s.clockOffsetMs / 86_400_000),
    today: s.today(),
    policy: s.policy,
    spentToday: s.spentToday(),
    envelope: s.envelope,
    envelopeRemaining: s.envelopeRemaining(),
    nextShipPlan: s.nextShipPlan,
    intents: [...s.intents.values()].reverse(),
    orders: s.orders.map((o) => {
      const c = buyerCase(o, now);
      return { ...o, shipment: { ...o.shipment, events: visibleEvents(o, now) }, buyer: { action: c.action, rationale: c.rationale } };
    }),
    invoices: s.invoices,
    audit: s.audit.all().slice(-200).reverse(),
    auditOk: s.audit.verify(),
  };
}
