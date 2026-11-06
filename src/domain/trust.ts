// Merchant trust is a transparent sum of signals, not a model's opinion.
// No signals at all means "unknown" (null), which is different from "low".
import { plural } from "./text.js";

export interface MerchantSignals {
  rating?: number | null; // 0-5
  reviewCount?: number | null;
  yearsActive?: number | null;
  returnDays?: number | null;
  priorOrdersOk?: number | null; // our own history with this merchant
  priorDisputes?: number | null;
  domainMatchesName?: boolean | null;
}

export interface TrustScore {
  score: number | null;
  lines: string[]; // how the score was reached
}

export function trustScore(s: MerchantSignals): TrustScore {
  const lines: string[] = [];
  let score = 40;
  let seen = 0;
  if (s.rating != null) {
    seen++;
    const pts = Math.round((s.rating - 3) * 12);
    score += pts;
    lines.push(`rating ${s.rating.toFixed(1)}/5 -> ${sign(pts)}`);
  }
  if (s.reviewCount != null) {
    seen++;
    const pts = s.reviewCount >= 1000 ? 12 : s.reviewCount >= 100 ? 6 : s.reviewCount >= 10 ? 0 : -10;
    score += pts;
    lines.push(`${plural(s.reviewCount, "review")} -> ${sign(pts)}`);
  }
  if (s.yearsActive != null) {
    seen++;
    const pts = s.yearsActive >= 3 ? 10 : s.yearsActive >= 1 ? 3 : -15;
    score += pts;
    lines.push(`${s.yearsActive < 1 ? "under 1 year" : plural(s.yearsActive, "year")} trading -> ${sign(pts)}`);
  }
  if (s.domainMatchesName === false) {
    seen++;
    score -= 15;
    lines.push("store domain doesn't match its name -> -15");
  }
  if (s.priorOrdersOk) {
    seen++;
    const pts = Math.min(10, s.priorOrdersOk * 3);
    score += pts;
    lines.push(`${plural(s.priorOrdersOk, "earlier order")} delivered fine -> ${sign(pts)}`);
  }
  if (s.priorDisputes) {
    seen++;
    const pts = -12 * s.priorDisputes;
    score += pts;
    lines.push(`${plural(s.priorDisputes, "earlier dispute")} -> ${sign(pts)}`);
  }
  if (!seen) return { score: null, lines: ["no reputation signals available"] };
  return { score: Math.max(0, Math.min(100, score)), lines };
}

const sign = (n: number): string => (n >= 0 ? `+${n}` : String(n));
