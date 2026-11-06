// A spending policy has two lives: a draft (anything an LLM or parser proposes)
// and an active rule set (only after code validation and a human click).
import { CATEGORIES, normalizeCategory, type Category } from "./categories.js";
import { currencyInfo, parseMoney, formatMoney, cmp, type Money } from "./money.js";

/** What a drafter (LLM or rule parser) may propose. Amounts are decimal strings. */
export interface PolicyDraftRaw {
  currency?: string | null;
  per_purchase_max?: string | null;
  daily_max?: string | null;
  ask_above?: string | null;
  allowed_categories?: string[] | null;
  blocked_categories?: string[] | null;
  merchant_trust?: "any" | "established" | "high" | null;
  unknown_merchant?: "ask" | "deny" | null;
  trusted_merchants?: string[] | null;
  blocked_merchants?: string[] | null;
  hours?: { start: string; end: string } | null;
  max_delivery_days?: number | null;
  require_returns?: boolean | null;
  ambiguities?: string[] | null;
}

export interface Policy {
  currency: string;
  perPurchaseMax: Money;
  dailyMax: Money;
  askAbove: Money | null;
  allowedCategories: Category[] | null; // null = any category not blocked
  blockedCategories: Category[];
  minMerchantTrust: number; // 0-100
  unknownMerchant: "ask" | "deny";
  trustedMerchants: string[];
  blockedMerchants: string[];
  hours: { start: string; end: string; tz: string } | null;
  maxDeliveryDays: number | null;
  requireReturns: boolean;
  tz: string; // the day boundary for the daily cap
}

export interface CompileResult {
  policy: Policy | null; // null while any question is open
  questions: string[]; // must be answered before activation
  warnings: string[];
}

const TRUST_LEVEL = { any: 0, established: 60, high: 80 } as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// High-risk categories are blocked unless the person explicitly allows them.
export const DEFAULT_BLOCKED: Category[] = ["gift_cards", "crypto", "gambling", "weapons"];

export function compilePolicy(raw: PolicyDraftRaw, sourceText: string, tz: string): CompileResult {
  const questions: string[] = [];
  const warnings: string[] = [];
  const spoken = numbersIn(sourceText);

  const cur = (raw.currency ?? "").trim().toUpperCase();
  const info = cur ? currencyInfo(cur) : null;
  if (!info) questions.push("Which currency should the limits use (for example USD)?");
  else if (!info.supportedByPayPal) {
    questions.push(`PayPal does not support ${info.code}. Which PayPal currency should the limits use? (No silent conversion.)`);
  } else if (info.domesticOnly) {
    warnings.push(`${info.code} works only for PayPal accounts registered in that country.`);
  }
  const usable = info?.supportedByPayPal ? info.code : null;

  const amount = (field: keyof PolicyDraftRaw, label: string, required: boolean): Money | null => {
    const v = raw[field] as string | null | undefined;
    if (v == null || v === "") {
      if (required) questions.push(`What is the ${label}?`);
      return null;
    }
    if (!spoken.has(canonicalNumber(v))) {
      questions.push(`The draft set the ${label} to ${v}, but you never said that number. What should it be?`);
      return null;
    }
    if (!usable) return null;
    const p = parseMoney(v, usable);
    if (!p.ok) { questions.push(`The ${label} "${v}" is invalid: ${p.error}.`); return null; }
    if (p.money.minor <= 0) { questions.push(`The ${label} must be more than zero.`); return null; }
    return p.money;
  };

  const per = amount("per_purchase_max", "most the agent may spend on one purchase", true);
  const daily = amount("daily_max", "daily spending cap", true);
  const askAbove = amount("ask_above", "amount above which the agent must ask you", false);
  if (per && daily && cmp(per, daily) > 0) {
    questions.push(`The per-purchase cap (${formatMoney(per)}) is above the daily cap (${formatMoney(daily)}). Which one is right?`);
  }
  if (askAbove && per && cmp(askAbove, per) >= 0) {
    warnings.push(`"Ask above ${formatMoney(askAbove)}" never triggers because nothing above ${formatMoney(per)} is allowed anyway.`);
  }

  const cats = (list: string[] | null | undefined, kind: string): Category[] => {
    const out: Category[] = [];
    for (const c of list ?? []) {
      const n = normalizeCategory(c);
      if (n) out.push(n);
      else questions.push(`I don't have a category called "${c}" (${kind}). Pick from: ${CATEGORIES.join(", ")}.`);
    }
    return [...new Set(out)];
  };
  const allowed = raw.allowed_categories && raw.allowed_categories.length ? cats(raw.allowed_categories, "allowed") : null;
  const blockedSaid = cats(raw.blocked_categories, "blocked");
  const blocked = [...new Set([...blockedSaid, ...DEFAULT_BLOCKED.filter((c) => !allowed?.includes(c))])];
  const overlap = allowed?.filter((c) => blockedSaid.includes(c)) ?? [];
  if (overlap.length) questions.push(`"${overlap.join(", ")}" is both allowed and blocked. Which is it?`);

  let hours: Policy["hours"] = null;
  if (raw.hours) {
    if (!HHMM.test(raw.hours.start) || !HHMM.test(raw.hours.end)) {
      questions.push(`The shopping hours "${raw.hours.start}-${raw.hours.end}" aren't valid 24h times.`);
    } else hours = { start: raw.hours.start, end: raw.hours.end, tz };
  }
  const delivery = raw.max_delivery_days;
  if (delivery != null && (!Number.isInteger(delivery) || delivery <= 0)) {
    questions.push(`Delivery limit "${delivery}" days isn't a whole number of days.`);
  }
  for (const a of raw.ambiguities ?? []) if (a.trim()) questions.push(a.trim());

  if (questions.length || !per || !daily || !usable) return { policy: null, questions, warnings };
  return {
    policy: {
      currency: usable,
      perPurchaseMax: per,
      dailyMax: daily,
      askAbove,
      allowedCategories: allowed,
      blockedCategories: blocked,
      minMerchantTrust: TRUST_LEVEL[raw.merchant_trust ?? "established"],
      unknownMerchant: raw.unknown_merchant ?? "ask",
      trustedMerchants: cleanList(raw.trusted_merchants),
      blockedMerchants: cleanList(raw.blocked_merchants),
      hours,
      maxDeliveryDays: delivery ?? null,
      requireReturns: raw.require_returns ?? false,
      tz,
    },
    questions,
    warnings,
  };
}

// Blank entries would match every store, so they are dropped.
const cleanList = (l: string[] | null | undefined) => (l ?? []).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3);

/** Every number the person actually typed, canonicalized ("1,200.00" -> "1200"). */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(canonicalNumber(m[0]));
  return out;
}

export function canonicalNumber(v: string): string {
  const t = String(v).replace(/[,\s$€£¥]/g, "");
  const [w, f = ""] = t.split(".");
  const frac = f.replace(/0+$/, "");
  return `${String(Number(w ?? "0"))}${frac ? "." + frac : ""}`;
}
