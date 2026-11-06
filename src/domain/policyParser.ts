// Offline drafter: turns common English policy phrasing into a PolicyDraftRaw.
// It is deliberately conservative: anything it can't read becomes a question,
// so the no-AI mode never invents a limit. The LLM drafter produces the same shape.
import { normalizeCategory, CATEGORIES } from "./categories.js";
import type { PolicyDraftRaw } from "./policy.js";

const AMT = String.raw`(?:(?:US)?\$|€|£|¥|₩)?\s?(\d[\d,]*(?:\.\d+)?)\s?(?:k\b)?\s?(?:dollars?|usd|eur|euros?|gbp|pounds?|jpy|yen|krw|won)?`;

function find(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m?.[1]) return m[1].replace(/,/g, "");
  }
  return null;
}

function currencyOf(text: string): { code: string | null; ambiguity?: string } {
  if (/₩|\bkrw\b|\bwon\b|원/i.test(text)) return { code: "KRW" };
  if (/€|\beur\b|\beuros?\b/i.test(text)) return { code: "EUR" };
  if (/£|\bgbp\b|\bpounds?\b/i.test(text)) return { code: "GBP" };
  if (/\bjpy\b|\byen\b/i.test(text)) return { code: "JPY" };
  if (/¥/.test(text)) return { code: null, ambiguity: "\"¥\" can mean Japanese yen or Chinese yuan. Which one?" };
  if (/\$|\busd\b|\bdollars?\b/i.test(text)) {
    if (/\b(cad|aud|nzd|hkd|sgd)\b|c\$|a\$/i.test(text)) return { code: null, ambiguity: "Which dollar do you mean (USD, CAD, AUD...)?" };
    return { code: "USD" };
  }
  return { code: null };
}

function to24h(h: string, ampm: string | undefined): string | null {
  let n = Number(h);
  if (ampm) {
    const pm = ampm.toLowerCase().startsWith("p");
    if (n === 12) n = pm ? 12 : 0;
    else if (pm) n += 12;
  }
  return n >= 0 && n < 24 ? `${String(n).padStart(2, "0")}:00` : null;
}

function categoryList(fragment: string): string[] {
  return fragment
    .split(/,|\bor\b|\band\b|\//)
    .map((s) => s.replace(/\b(any|no|never|only|buy|anything|stuff|items?|things?|products?)\b/gi, "").trim())
    .filter(Boolean);
}

export function draftPolicyFromText(input: string): PolicyDraftRaw {
  const text = input.replace(/\s+/g, " ").trim();
  const ambiguities: string[] = [];
  const cur = currencyOf(text);
  if (cur.ambiguity) ambiguities.push(cur.ambiguity);

  const per = find(text, [
    new RegExp(String.raw`${AMT}\s*(?:per|each|a|an|for any single|for one)\s*(?:item|purchase|order|thing|single purchase)`, "i"),
    new RegExp(String.raw`(?:per|each|single|one)[- ]?(?:item|purchase|order)s?\s*(?:limit|max(?:imum)?|cap)?\s*(?:of|is|at|:|under|below|up to)?\s*${AMT}`, "i"),
    new RegExp(String.raw`(?:nothing|no item|no single purchase|nothing single)\s*(?:over|above|more than)\s*${AMT}`, "i"),
  ]);
  const daily = find(text, [
    new RegExp(String.raw`${AMT}\s*(?:a|per|each)\s*day`, "i"),
    new RegExp(String.raw`${AMT}\s*daily`, "i"),
    new RegExp(String.raw`daily\s*(?:limit|budget|cap|max(?:imum)?)?\s*(?:of|is|at|:|under|up to)?\s*${AMT}`, "i"),
    new RegExp(String.raw`(?:per day|a day|each day)\s*(?:limit|budget|cap)?\s*(?:of|is|:)?\s*${AMT}`, "i"),
  ]);
  const ask = find(text, [
    new RegExp(String.raw`(?:ask|check with|confirm with|ping)\s*(?:me)?\s*(?:first\s*)?(?:for anything\s*|if it'?s\s*|if\s*|when\s*|before\s*)?(?:anything\s*)?(?:over|above|more than|exceeds?)\s*${AMT}`, "i"),
    new RegExp(String.raw`(?:over|above|more than)\s*${AMT}\s*,?\s*(?:ask|check with|confirm)`, "i"),
  ]);
  if (/\bcheap|reasonable|not too expensive|affordable\b/i.test(text) && !per) {
    ambiguities.push("\"Cheap\" isn't a number. What is the most the agent may pay for one item?");
  }
  if (/\d\s?k\b/i.test(text)) ambiguities.push("Please write amounts in full (for example 1000 instead of 1k).");

  const blocked: string[] = [];
  for (const m of text.matchAll(/\b(?:no|never(?: buy)?|don'?t buy|block|avoid|without)\s+([a-z ,/-]+?)(?:[.;!]|$|\bbut\b|\bunless\b|\bfrom\b)/gi)) {
    for (const c of categoryList(m[1] ?? "")) if (normalizeCategory(c)) blocked.push(c);
  }
  let allowed: string[] | null = null;
  const only = /\bonly\s+(?:buy\s+)?([a-z ,/-]+?)(?:[.;!]|$|\bunder\b|\bup to\b|\bfrom\b)/i.exec(text);
  if (only?.[1]) {
    const items = categoryList(only[1]).filter((c) => normalizeCategory(c) || CATEGORIES.includes(c as never));
    if (items.length) allowed = items;
  }

  const hm = /between\s*(\d{1,2})(?::00)?\s*(am|pm)?\s*(?:and|-|to)\s*(\d{1,2})(?::00)?\s*(am|pm)?/i.exec(text);
  const hours = hm ? { start: to24h(hm[1]!, hm[2]) ?? "", end: to24h(hm[3]!, hm[4]) ?? "" } : null;

  const del = /(?:arrives?|deliver(?:ed|y|ies|s)?|ship(?:s|ping)?)\s*(?:with)?in\s*(\d{1,2})\s*days?/i.exec(text);

  return {
    currency: cur.code,
    per_purchase_max: per,
    daily_max: daily,
    ask_above: ask,
    allowed_categories: allowed,
    blocked_categories: blocked,
    merchant_trust: /\b(highly|very) (trusted|reputable)|top[- ]rated\b/i.test(text)
      ? "high"
      : /\b(any seller|any store|any merchant)\b/i.test(text) ? "any" : "established",
    unknown_merchant: /\b(never|don'?t|no) (buy from )?(unknown|new|unfamiliar) (sellers?|stores?|merchants?)/i.test(text) ? "deny" : "ask",
    hours,
    max_delivery_days: del ? Number(del[1]) : null,
    require_returns: /\breturn(s|able| policy)?\b/i.test(text) ? true : null,
    ambiguities,
  };
}
