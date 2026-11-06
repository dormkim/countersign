// Sandbox fallback for the dispute half of the demo.
//
// PayPal has no API for a buyer to open a dispute: in sandbox the buyer files
// it by hand in the Resolution Center, and it can take a while to appear. So a
// judge on the hosted sandbox demo could reach the merchant desk with nothing
// on it. A rehearsal dispute fills that gap honestly:
//   - it lives only in this server's memory, never in PayPal;
//   - its id starts with REHEARSAL- and the UI labels it as a rehearsal;
//   - it follows the same states as a real dispute (customer_disputes_v1);
//   - money is still real: when the seller (or the rehearsal decision) refunds,
//     the caller issues a real sandbox refund through the Payments v2 API.
import { randomBytes } from "node:crypto";
import type { Money } from "../domain/money.js";
import { PayPalError, type Dispute } from "./types.js";

export const REHEARSAL_PREFIX = "REHEARSAL-";

const fail = (issue: string, msg: string) => new PayPalError(`${issue}: ${msg}`, 422, "UNPROCESSABLE_ENTITY", null, [{ issue }]);

export class RehearsalDisputes {
  private disputes = new Map<string, Dispute>();

  constructor(private readonly now: () => Date) {}

  has(id: string): boolean {
    return this.disputes.has(id);
  }

  open(captureId: string, amount: Money, reason: Dispute["reason"], note: string): Dispute {
    const now = this.now();
    const d: Dispute = {
      id: REHEARSAL_PREFIX + randomBytes(5).toString("hex").toUpperCase(),
      reason, status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", amount, createdAt: now.toISOString(),
      sellerResponseDue: new Date(now.getTime() + 10 * 86_400_000).toISOString(),
      captureIds: [captureId], outcome: null, buyerNote: note, rehearsal: true,
    };
    this.disputes.set(d.id, d);
    return { ...d };
  }

  list(captureIds: string[]): Dispute[] {
    return [...this.disputes.values()].filter((d) => d.captureIds.some((c) => captureIds.includes(c))).map((d) => ({ ...d }));
  }

  get(id: string): Dispute {
    const d = this.disputes.get(id);
    if (!d) throw new PayPalError(`RESOURCE_NOT_FOUND: dispute ${id}`, 404, "RESOURCE_NOT_FOUND", null, null);
    return { ...d };
  }

  private at(id: string, allowed: string[]): Dispute {
    const d = this.disputes.get(id);
    if (!d) throw new PayPalError(`RESOURCE_NOT_FOUND: dispute ${id}`, 404, "RESOURCE_NOT_FOUND", null, null);
    if (!allowed.includes(d.status)) throw fail("INVALID_DISPUTE_STATUS", `status is ${d.status}`);
    return d;
  }

  provideEvidence(id: string) {
    this.at(id, ["WAITING_FOR_SELLER_RESPONSE"]).status = "UNDER_REVIEW";
  }

  /** Call only after the real sandbox refund succeeded. */
  acceptClaim(id: string) {
    const d = this.at(id, ["WAITING_FOR_SELLER_RESPONSE", "OPEN"]);
    d.status = "RESOLVED";
    d.outcome = "RESOLVED_BUYER_FAVOR";
  }

  makeOffer(id: string) {
    const d = this.at(id, ["WAITING_FOR_SELLER_RESPONSE", "OPEN"]);
    if (d.stage !== "INQUIRY") throw fail("INVALID_DISPUTE_STAGE", "offers are allowed only in INQUIRY");
    d.status = "WAITING_FOR_BUYER_RESPONSE";
  }

  /** Mirrors the sandbox-only /adjudicate endpoint. For BUYER_FAVOR, refund first. */
  adjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR") {
    const d = this.at(id, ["UNDER_REVIEW"]);
    d.status = "RESOLVED";
    d.outcome = outcome === "BUYER_FAVOR" ? "RESOLVED_BUYER_FAVOR" : "RESOLVED_SELLER_FAVOR";
  }

  /** Checked before money moves, so a refused state change never follows a real refund. */
  canResolve(id: string, from: string[]): boolean {
    const d = this.disputes.get(id);
    return Boolean(d && from.includes(d.status));
  }
}
