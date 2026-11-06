// Stand-in for PayPal's buyer approval page when running without sandbox keys.
// Clearly labeled so nobody mistakes it for PayPal.
import type { Session } from "../app/session.js";
import { formatMoney } from "../domain/money.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function approvalPage(orderId: string, s: Session): string {
  const env = s.envelope?.orderId === orderId ? s.envelope : null;
  const rec = [...s.intents.values()].find((r) => r.checkoutOrderId === orderId);
  const what = env
    ? `Authorize a daily agent budget of <b>${esc(formatMoney(env.amount))}</b>. Nothing is charged until the agent buys something that passes your rules; unused budget is released.`
    : rec ? `Pay <b>${esc(formatMoney(rec.gate.total!))}</b> for <b>${esc(rec.offer?.title ?? "")}</b>.` : "Unknown order.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated PayPal approval</title><link rel="stylesheet" href="/styles.css"></head>
<body class="simpage"><main class="sim-card">
<p class="sim-badge">Simulated payment approval</p>
<h1>Approve this payment</h1>
<p>${what}</p>
<p class="muted">Order <code>${esc(orderId)}</code>. This page stands in for the PayPal sandbox approval screen because no sandbox keys are configured. With keys, you'd see PayPal itself.</p>
<form method="post"><button name="choice" value="approve" class="primary">Approve</button>
<button name="choice" value="cancel" class="ghost">Cancel</button></form>
</main></body></html>`;
}
