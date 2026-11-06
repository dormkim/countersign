// Optional: split a shared purchase and request each share with a PayPal invoice.
// PayPal has no public person-to-person "request money" API, so a share is
// requested through Invoicing v2 from the sandbox business account.
import { randomUUID } from "node:crypto";
import { formatMoney, parseMoney } from "../domain/money.js";
import { splitTotal, type Member } from "../domain/split.js";
import { UserError, errText } from "./commerce.js";
import type { Session } from "./session.js";

export function previewSplit(totalText: string, currency: string, members: Member[], payerEmail: string) {
  const t = parseMoney(totalText, currency);
  if (!t.ok) throw new UserError(t.error);
  const r = splitTotal(t.money, members, payerEmail);
  if (r.error) throw new UserError(r.error);
  return { total: t.money, shares: r.shares };
}

export async function sendSplitInvoices(s: Session, title: string, totalText: string, currency: string, members: Member[], payerEmail: string) {
  const { total, shares } = previewSplit(totalText, currency, members, payerEmail);
  const results = [];
  for (const sh of shares) {
    try {
      const inv = await s.paypal.createInvoice({
        recipientEmail: sh.member.email, recipientName: sh.member.name, currency: total.currency,
        items: [{ name: `${title}: share for ${sh.member.name}`, amount: sh.amount }],
        note: `Your share of ${formatMoney(total)} (${title}), split by weight ${sh.member.weight}.`,
        invoiceNumber: `CS-SPLIT-${randomUUID().slice(0, 8)}`,
      });
      const sent = await s.paypal.sendInvoice(inv.id);
      s.invoices.unshift({ id: sent.id, to: sh.member.email, amount: sh.amount, status: sent.status, payUrl: sent.payUrl, at: s.now().toISOString() });
      results.push({ member: sh.member.name, amount: sh.amount, ok: true, invoiceId: sent.id, error: null });
    } catch (err) {
      results.push({ member: sh.member.name, amount: sh.amount, ok: false, invoiceId: null, error: errText(err) });
    }
  }
  s.log("paypal", "split invoices", { title, total: formatMoney(total), sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  return { total, results };
}
