// The payment gate. Pure function: (intent, truth, policy, state) -> verdict.
// Every check leaves a card with the numbers it used, so a verdict can be
// read and audited without trusting any model.
import type { Offer } from "../catalog/types.js";
import { normalizeCategory, categoryFromText, categoryLabel } from "./categories.js";
import { findInjection } from "./injection.js";
import { add, cmp, currencyInfo, formatMoney, sub, times, type Money } from "./money.js";
import type { Policy } from "./policy.js";
import { trustScore } from "./trust.js";

export interface PurchaseIntent {
  id: string;
  offerId: string;
  quantity: number;
  claimedUnitPrice: Money; // what the agent says it will pay
  agentReason: string;
  goal: string;
}

export type Outcome = "pass" | "ask" | "fail";
export interface Check {
  id: string;
  label: string;
  outcome: Outcome;
  detail: string;
}
export type Verdict = "ALLOW" | "ASK" | "DENY";

export interface GateContext {
  policy: Policy | null;
  offer: Offer | null; // fresh lookup, the source of truth
  spentToday: Money | null; // in policy currency
  now: Date;
  envelopeRemaining: Money | null; // pre-approved daily authorization left
}

export interface GateResult {
  verdict: Verdict;
  checks: Check[];
  total: Money | null;
  headline: string;
}

export function evaluate(intent: PurchaseIntent, ctx: GateContext): GateResult {
  const checks: Check[] = [];
  const push = (id: string, label: string, outcome: Outcome, detail: string) =>
    checks.push({ id, label, outcome, detail });
  const { policy, offer } = ctx;

  if (!policy) {
    push("policy", "Active policy", "fail", "No confirmed policy. The agent cannot spend until you activate one.");
    return finish(checks, null);
  }
  if (!offer) {
    push("listing", "Listing exists", "fail", `Offer ${intent.offerId} was not found on a fresh lookup.`);
    return finish(checks, null);
  }
  if (!Number.isInteger(intent.quantity) || intent.quantity < 1 || intent.quantity > 20) {
    push("quantity", "Quantity", "fail", `Quantity ${intent.quantity} is not a whole number between 1 and 20.`);
    return finish(checks, null);
  }

  // 1. Price: the agent's claim must match the fresh listing.
  if (intent.claimedUnitPrice.currency !== offer.price.currency || intent.claimedUnitPrice.minor !== offer.price.minor) {
    push("price", "Price matches listing", "fail",
      `Agent claimed ${formatMoney(intent.claimedUnitPrice)}, listing says ${formatMoney(offer.price)} right now.`);
  } else push("price", "Price matches listing", "pass", `${formatMoney(offer.price)} confirmed on a fresh lookup.`);

  if (offer.availability !== "InStock") push("stock", "In stock", "fail", "Listing is out of stock.");

  // 2. Currency: never convert silently.
  const ci = currencyInfo(offer.price.currency);
  if (!ci.supportedByPayPal) {
    push("currency", "Currency", "fail", `Priced in ${ci.code}, which PayPal does not support. Nothing to charge.`);
    return finish(checks, null);
  }
  if (ci.code !== policy.currency) {
    push("currency", "Currency", "ask",
      `Priced in ${ci.code}; your limits are in ${policy.currency}. Countersign doesn't guess an exchange rate.`);
    return finish(checks, null);
  }
  push("currency", "Currency", "pass", `${ci.code}, same as your policy.`);

  // 3. Amounts.
  const shipping = offer.shipping;
  const total = add(times(offer.price, intent.quantity), shipping ?? { currency: ci.code, minor: 0 });
  const totalText = `${formatMoney(total)} (${intent.quantity} x ${formatMoney(offer.price)}${shipping ? ` + ${formatMoney(shipping)} shipping` : ""})`;
  if (!shipping) push("shipping", "Shipping cost known", "ask", "Shipping cost isn't listed, so the real total is unknown.");
  if (cmp(total, policy.perPurchaseMax) > 0) {
    push("per_purchase", "Per-purchase cap", "fail", `${totalText} is over your ${formatMoney(policy.perPurchaseMax)} cap.`);
  } else push("per_purchase", "Per-purchase cap", "pass", `${totalText} is within ${formatMoney(policy.perPurchaseMax)}.`);

  const spent = ctx.spentToday ?? { currency: ci.code, minor: 0 };
  const after = add(spent, total);
  if (cmp(after, policy.dailyMax) > 0) {
    push("daily", "Daily cap", "fail",
      `${formatMoney(spent)} spent today + ${formatMoney(total)} = ${formatMoney(after)}, over ${formatMoney(policy.dailyMax)}.`);
  } else push("daily", "Daily cap", "pass",
    `${formatMoney(after)} of ${formatMoney(policy.dailyMax)} after this purchase (${formatMoney(sub(policy.dailyMax, after))} left).`);

  if (policy.askAbove && cmp(total, policy.askAbove) > 0) {
    push("ask_above", "Ask-me threshold", "ask", `${formatMoney(total)} is above ${formatMoney(policy.askAbove)}, so you asked to be asked.`);
  }

  // 4. Category.
  const cat = normalizeCategory(offer.category) ?? categoryFromText(`${offer.category ?? ""} ${offer.title}`);
  if (!cat) push("category", "Category", "ask", `Couldn't place "${offer.category ?? offer.title}" in a category.`);
  else if (policy.blockedCategories.includes(cat)) push("category", "Category", "fail", `${categoryLabel(cat)} is blocked by your policy.`);
  else if (policy.allowedCategories && !policy.allowedCategories.includes(cat)) {
    push("category", "Category", "fail", `${categoryLabel(cat)} isn't in your allowed list (${policy.allowedCategories.map(categoryLabel).join(", ")}).`);
  } else push("category", "Category", "pass", `${categoryLabel(cat)} is allowed.`);

  // 5. Merchant.
  checkMerchant(offer, policy, push);

  // 6. Time window, delivery, returns.
  if (policy.hours) {
    const hhmm = localTime(ctx.now, policy.hours.tz);
    const inside = within(hhmm, policy.hours.start, policy.hours.end);
    push("hours", "Shopping hours", inside ? "pass" : "ask",
      `It is ${hhmm} in ${policy.hours.tz}; your window is ${policy.hours.start}-${policy.hours.end}.`);
  }
  if (policy.maxDeliveryDays != null) {
    if (offer.deliveryDays == null) push("delivery", "Delivery time", "ask", "Delivery estimate isn't listed.");
    else push("delivery", "Delivery time", offer.deliveryDays <= policy.maxDeliveryDays ? "pass" : "ask",
      `Estimated ${offer.deliveryDays} days; your limit is ${policy.maxDeliveryDays}.`);
  }
  if (policy.requireReturns) {
    if (offer.returnDays == null) push("returns", "Returns accepted", "ask", "Return policy isn't listed.");
    else push("returns", "Returns accepted", offer.returnDays > 0 ? "pass" : "fail",
      offer.returnDays > 0 ? `${offer.returnDays}-day returns.` : "Final sale, no returns.");
  }

  // 7. Untrusted text that tries to steer agents.
  const inj = findInjection(offer.title, offer.description);
  if (inj.length) {
    push("injection", "Listing text", "ask",
      `Listing text ${inj[0]!.reason}: "${inj[0]!.snippet}". Ignored as instructions; flagged for you.`);
  }

  // 8. Funding: pre-approved envelope or a fresh PayPal approval.
  if (ctx.envelopeRemaining) {
    if (ctx.envelopeRemaining.currency !== ci.code) {
      push("funding", "Funding", "ask", `Today's PayPal authorization is in ${ctx.envelopeRemaining.currency}; this needs its own checkout.`);
    } else if (cmp(total, ctx.envelopeRemaining) > 0) {
      push("funding", "Funding", "ask",
        `${formatMoney(ctx.envelopeRemaining)} left on today's PayPal authorization; ${formatMoney(total)} needs a separate approval.`);
    } else push("funding", "Funding", "pass", `Captured from today's PayPal authorization (${formatMoney(ctx.envelopeRemaining)} left).`);
  } else push("funding", "Funding", "ask", "No pre-approved PayPal budget today; you'd approve this checkout in PayPal.");

  return finish(checks, total);
}

function checkMerchant(offer: Offer, policy: Policy, push: (id: string, l: string, o: Outcome, d: string) => void) {
  const name = offer.merchant.name.toLowerCase();
  const domain = offer.merchant.domain.toLowerCase();
  const label = "Merchant";
  if (policy.blockedMerchants.some((b) => name.includes(b) || domain.includes(b))) {
    return push("merchant", label, "fail", `${offer.merchant.name} is on your blocked list.`);
  }
  if (policy.trustedMerchants.some((t) => name.includes(t) || domain.includes(t))) {
    return push("merchant", label, "pass", `${offer.merchant.name} is on your trusted list.`);
  }
  const t = trustScore(offer.merchant.signals);
  if (t.score == null) {
    return push("merchant", label, policy.unknownMerchant === "deny" ? "fail" : "ask",
      `${offer.merchant.name} (${domain}): no reputation data. Your policy says ${policy.unknownMerchant} for unknown sellers.`);
  }
  const ok = t.score >= policy.minMerchantTrust;
  push("merchant", label, ok ? "pass" : "fail",
    `${offer.merchant.name} scores ${t.score}/100 (need ${policy.minMerchantTrust}): ${t.lines.join("; ")}.`);
}

function finish(checks: Check[], total: Money | null): GateResult {
  const fails = checks.filter((c) => c.outcome === "fail");
  const asks = checks.filter((c) => c.outcome === "ask");
  // A purchase that only needs a fresh PayPal approval is still a clean ALLOW of the rules;
  // the funding step is handled by checkout, not by a human override.
  const ruleAsks = asks.filter((c) => c.id !== "funding");
  const verdict: Verdict = fails.length ? "DENY" : ruleAsks.length ? "ASK" : "ALLOW";
  const headline = verdict === "DENY"
    ? `Blocked: ${fails.map((c) => c.label.toLowerCase()).join(", ")}.`
    : verdict === "ASK"
      ? `Needs you: ${ruleAsks.map((c) => c.label.toLowerCase()).join(", ")}.`
      : "Within every rule.";
  return { verdict, checks, total, headline };
}

export function localTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return parts;
}

function within(t: string, start: string, end: string): boolean {
  return start <= end ? t >= start && t < end : t >= start || t < end; // window may cross midnight
}
