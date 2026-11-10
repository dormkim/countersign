// Browser text helpers (public/js, no build step): the merchant desk must not say
// "Live from PayPal" for REHEARSAL disputes, and counts read as English.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser JS module without types
import { plural } from "../public/js/core.js";
// @ts-expect-error plain browser JS module without types
import { disputeSourceNote } from "../public/js/claims.js";
// @ts-expect-error plain browser JS module without types
import { checkDetail } from "../public/js/shop.js";

const v = (rehearsal: boolean) => ({ dispute: { id: rehearsal ? "REHEARSAL-X" : "PP-D-1", rehearsal } });

describe("UI text", () => {
  it("plural", () => {
    expect(plural(1, "result")).toBe("1 result");
    expect(plural(2, "result")).toBe("2 results");
  });
  it("dispute source note follows the rehearsal flag", () => {
    expect(disputeSourceNote(false, [v(true)], 0)).toBe("From the simulated PayPal.");
    expect(disputeSourceNote(true, [v(false)], 0)).toBe("Live from the PayPal sandbox Disputes API.");
    const only = disputeSourceNote(true, [v(true)], 0);
    expect(only.startsWith("Rehearsal (this app; not from PayPal).")).toBe(true);
    expect(only).not.toMatch(/^Live/);
    expect(disputeSourceNote(true, [v(false), v(true)], 1)).toBe("Live from the PayPal sandbox Disputes API, except the dispute marked REHEARSAL (this app; not from PayPal). 1 dispute from other visitors hidden.");
    expect(disputeSourceNote(true, [], 2)).toBe("Live from the PayPal sandbox Disputes API. 2 disputes from other visitors hidden.");
  });
  it("funding line follows the capture state", () => {
    const f = { id: "funding", outcome: "pass", detail: "Today's PayPal authorization covers it ($136.01 left)." };
    expect(checkDetail(f, "needs_you")).toBe("Will capture from today's authorization when you approve. Today's PayPal authorization covers it ($136.01 left).");
    expect(checkDetail(f, "paid").startsWith("Captured from today's authorization.")).toBe(true);
    expect(checkDetail(f, "rejected").startsWith("Nothing captured.")).toBe(true);
    for (const s of ["needs_you", "allowed", "rejected", "denied"]) expect(checkDetail(f, s)).not.toMatch(/^Captured/);
    const ask = { id: "funding", outcome: "ask", detail: "No pre-approved PayPal budget today; you'd approve this checkout in PayPal." };
    expect(checkDetail(ask, "needs_you")).toBe(ask.detail);
  });
});
