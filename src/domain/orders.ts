// The ledger Countersign keeps of what the agent bought. Disputes are built
// only from these records and PayPal's own objects, never from memory or a model.
import type { Offer } from "../catalog/types.js";
import type { Money } from "./money.js";

export type Carrier = "USPS" | "UPS" | "FEDEX" | "DHL" | "OTHER";
export type ShipStatus = "LABEL_CREATED" | "IN_TRANSIT" | "DELAYED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION";

export interface ShipEvent {
  at: string; // ISO
  status: ShipStatus;
  where: string;
}

export interface OrderRecord {
  id: string;
  intentId: string;
  offer: Offer; // snapshot at purchase
  quantity: number;
  total: Money;
  placedAt: string;
  paypal: { orderId: string; captureId: string; authorizationId: string | null };
  shipment: { carrier: Carrier; trackingNumber: string; promisedBy: string; events: ShipEvent[]; trackingError?: string };
  refunds: Array<{ id: string; amount: Money; at: string; fromPayPal: boolean }>; // fromPayPal: id is a real PayPal refund id
  issue: { kind: "not_received" | "damaged"; reportedAt: string; note: string } | null;
  disputeId: string | null;
}

/** Tracking events become visible only once the (simulated) clock reaches them. */
export function visibleEvents(o: OrderRecord, now: Date): ShipEvent[] {
  return o.shipment.events.filter((e) => new Date(e.at) <= now);
}

export function delivered(o: OrderRecord, now: Date): ShipEvent | null {
  return visibleEvents(o, now).find((e) => e.status === "DELIVERED") ?? null;
}

export type ShipPlan = "on_time" | "stalled" | "damaged";

const DAY = 86_400_000;

/** Deterministic simulated carrier timeline for the demo store's shipments. */
export function planShipment(placedAt: Date, deliveryDays: number, plan: ShipPlan): ShipEvent[] {
  const at = (d: number) => new Date(placedAt.getTime() + d * DAY).toISOString();
  const events: ShipEvent[] = [
    { at: at(0.2), status: "LABEL_CREATED", where: "Oakland, CA" },
    { at: at(1), status: "IN_TRANSIT", where: "Sacramento, CA" },
  ];
  if (plan === "stalled") {
    events.push({ at: at(2), status: "IN_TRANSIT", where: "Reno, NV" });
    events.push({ at: at(deliveryDays + 1), status: "DELAYED", where: "Reno, NV" });
    return events;
  }
  events.push({ at: at(Math.max(1.5, deliveryDays - 0.5)), status: "OUT_FOR_DELIVERY", where: "Destination city" });
  events.push({ at: at(deliveryDays), status: "DELIVERED", where: "Front door" });
  return events;
}

export const daysBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / DAY;
