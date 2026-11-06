// Product text is untrusted data. The gate's decision never reads it as
// instructions (it is code), but text that *tries* to instruct an agent is a
// red flag about the listing itself, so it is surfaced and sent to a human.

const PATTERNS: Array<[RegExp, string]> = [
  [/ignore (?:all |any |the )?(?:previous|prior|above|earlier|your) (?:instructions|rules|policy|polic(?:y|ies))/i, "tries to override instructions"],
  [/\b(?:system|developer) (?:prompt|message|note|override)\b/i, "poses as a system message"],
  [/<\/?\s*(?:system|instructions?|assistant)\s*>/i, "contains fake prompt tags"],
  [/\b(?:spending |purchase )?(?:policy|limit|limits|firewall|guardrails?) (?:is |are |has been |have been )?(?:disabled|lifted|overridden|removed|off|waived)\b/i, "claims limits are disabled"],
  [/\b(?:ai|shopping) (?:agents?|assistants?)\b[^.]{0,80}\b(?:must|should|are required to|always)\b/i, "addresses AI agents directly"],
  [/\b(?:approve|authorize|purchase|buy|checkout)\b[^.]{0,40}\b(?:immediately|without (?:asking|confirmation|approval)|regardless)\b/i, "pushes for purchase without approval"],
  [/\b(?:pre-?approved|already approved) by (?:the|your) (?:user|owner|customer)\b/i, "claims prior approval"],
  [/\b(?:ai|llm|shopping|buying) (?:agents?|assistants?|bots?|models?)\s*(?:reading|seeing|processing) this\b/i, "addresses AI agents directly"],
  [/\b(?:budget|limit|limits|spending cap|allowance)\b[^.]{0,40}\b(?:raised|increased|lifted|doubled|updated|changed) (?:to|for|by)\b/i, "claims your limits changed"],
];

export interface InjectionFinding {
  reason: string;
  snippet: string;
}

export function findInjection(...texts: Array<string | null | undefined>): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const [re, reason] of PATTERNS) {
      const m = re.exec(text);
      if (!m) continue;
      const start = Math.max(0, m.index - 30);
      out.push({ reason, snippet: text.slice(start, m.index + m[0].length + 30).trim() });
    }
  }
  return out;
}

/** Wraps untrusted text for an LLM prompt so it reads as quoted data. */
export function quoteUntrusted(text: string, max = 600): string {
  return JSON.stringify(text.slice(0, max));
}
