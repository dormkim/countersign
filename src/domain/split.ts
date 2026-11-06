// Optional: share a group purchase. Integer minor units, largest-remainder
// rounding so the shares always add up to the exact total.
import type { Money } from "./money.js";

export interface Member {
  name: string;
  email: string;
  weight: number; // e.g. nights stayed, or 1 for an even split
}

export interface Share {
  member: Member;
  amount: Money;
}

export function splitTotal(total: Money, members: Member[], payerEmail: string): { shares: Share[]; error: string | null } {
  if (!members.length) return { shares: [], error: "Add at least one person." };
  if (members.some((m) => !(m.weight > 0) || !Number.isFinite(m.weight))) return { shares: [], error: "Every weight must be a positive number." };
  const sum = members.reduce((s, m) => s + m.weight, 0);
  const raw = members.map((m) => (total.minor * m.weight) / sum);
  const floors = raw.map(Math.floor);
  let left = total.minor - floors.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]!++;
    left--;
  }
  const shares = members.map((m, i) => ({ member: m, amount: { currency: total.currency, minor: floors[i]! } }));
  // The payer doesn't invoice themselves.
  return { shares: shares.filter((s) => s.member.email.toLowerCase() !== payerEmail.toLowerCase()), error: null };
}
