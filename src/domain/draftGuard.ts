// A model may write the words of a dispute note, never its facts. Every number,
// date and ID in a draft must already appear in the case facts; otherwise the
// draft is rejected and the deterministic template is used instead.
import { canonicalNumber } from "./policy.js";

export interface GuardResult {
  ok: boolean;
  unknown: string[]; // tokens the facts don't support
}

const ID = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{7,}\b/g;
const LOCAL_ID = /\b(?:ord|int)_[a-z0-9]{6,}\b/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUM = /\d[\d,]*(?:\.\d+)?/g;

export function checkDraft(draft: string, factsText: string): GuardResult {
  const unknown: string[] = [];
  const factIds = new Set(factsText.match(ID) ?? []);
  const factDates = new Set(factsText.match(DATE) ?? []);
  const factNums = new Set([...(factsText.match(NUM) ?? [])].map(canonicalNumber));
  factNums.add("0").add("1");

  for (const id of draft.match(ID) ?? []) if (!factIds.has(id)) unknown.push(id);
  for (const id of draft.match(LOCAL_ID) ?? []) if (!factsText.includes(id)) unknown.push(id);
  for (const d of draft.match(DATE) ?? []) if (!factDates.has(d)) unknown.push(d);
  const stripped = draft.replace(ID, " ").replace(LOCAL_ID, " ").replace(DATE, " ");
  for (const n of stripped.match(NUM) ?? []) if (!factNums.has(canonicalNumber(n))) unknown.push(n);
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}
