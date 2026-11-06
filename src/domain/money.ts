// Money is kept in integer minor units. Floats never touch an amount.
// Currency rules follow PayPal's REST currency-code reference: HUF, JPY and TWD
// reject decimals; BRL, CNY and MYR work only for in-country accounts; KRW is
// not a PayPal currency at all (so a won price can never be charged as-is).

export interface Money {
  currency: string;
  minor: number;
}

const DECIMALS: Record<string, number> = {
  AUD: 2, BRL: 2, CAD: 2, CNY: 2, CZK: 2, DKK: 2, EUR: 2, HKD: 2, HUF: 0,
  ILS: 2, JPY: 0, MYR: 2, MXN: 2, TWD: 0, NZD: 2, NOK: 2, PHP: 2, PLN: 2,
  GBP: 2, SGD: 2, SEK: 2, CHF: 2, THB: 2, USD: 2,
};
const DOMESTIC_ONLY = new Set(["BRL", "CNY", "MYR"]);

export interface CurrencyInfo {
  code: string;
  supportedByPayPal: boolean;
  decimals: number;
  domesticOnly: boolean;
}

export function currencyInfo(raw: string): CurrencyInfo {
  const code = raw.trim().toUpperCase();
  const known = DECIMALS[code];
  return {
    code,
    supportedByPayPal: known !== undefined,
    decimals: known ?? displayDecimals(code),
    domesticOnly: DOMESTIC_ONLY.has(code),
  };
}

function displayDecimals(code: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export type ParseResult = { ok: true; money: Money } | { ok: false; error: string };

/** Parses "1,299.50" style decimal strings without floating point. */
export function parseMoney(value: string | number, currency: string): ParseResult {
  const info = currencyInfo(currency);
  const text = String(value).trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { ok: false, error: `"${value}" is not a plain positive amount` };
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > info.decimals) {
    return info.decimals === 0
      ? { ok: false, error: `${info.code} does not support decimals (PayPal rejects them)` }
      : { ok: false, error: `${info.code} allows at most ${info.decimals} decimal places` };
  }
  const minor = Number(whole) * 10 ** info.decimals + Number(frac.padEnd(info.decimals, "0") || "0");
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "amount too large" };
  return { ok: true, money: { currency: info.code, minor } };
}

export function money(value: string | number, currency: string): Money {
  const r = parseMoney(value, currency);
  if (!r.ok) throw new Error(r.error);
  return r.money;
}

/** The exact string PayPal expects in `amount.value`. */
export function toPayPalValue(m: Money): string {
  const d = currencyInfo(m.currency).decimals;
  if (d === 0) return String(m.minor);
  const s = String(m.minor).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

export function formatMoney(m: Money): string {
  const d = currencyInfo(m.currency).decimals;
  const major = m.minor / 10 ** d;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: m.currency,
      minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(major);
  } catch {
    return `${toPayPalValue(m)} ${m.currency}`;
  }
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency} (never added silently)`);
  }
}

export const add = (a: Money, b: Money): Money => (same(a, b), { currency: a.currency, minor: a.minor + b.minor });
export const sub = (a: Money, b: Money): Money => (same(a, b), { currency: a.currency, minor: a.minor - b.minor });
export const times = (a: Money, n: number): Money => ({ currency: a.currency, minor: a.minor * n });
export const cmp = (a: Money, b: Money): number => (same(a, b), Math.sign(a.minor - b.minor));
export const zero = (currency: string): Money => ({ currency: currency.toUpperCase(), minor: 0 });
