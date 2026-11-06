import { $, act, api, esc, fmt, st, toast } from "./core.js";
import { openApproval } from "./rules.js";

// Section 3: the agent and the gate's decision cards.
export const GOALS = [
  "over-ear noise-cancelling headphones with long battery for my commute",
  "backup headphones under $70",
  "a $100 gift card for my sister",
  "packing cubes for my trip",
  "a handmade paper notebook",
  "wireless earbuds",
  "trail mix snack",
  "pocket projector",
];

export function decisionCard(r) {
  const o = r.offer;
  const g = r.gate;
  const statusText = { allowed: "Allowed", needs_you: "Needs you", denied: "Blocked", rejected: "You rejected it", awaiting_paypal: "Waiting for PayPal approval", capturing: "Capturing", paid: "Paid", payment_failed: "Payment failed" }[r.status];
  return `<article class="decision">
    <div class="head"><div class="item"><b>${esc(o?.title ?? r.intent.offerId)}</b>
      <span>${o ? `${esc(o.merchant.name)} · ${fmt(o.price)} each · qty ${r.intent.quantity}` : "listing not found"} · picked by ${esc(r.by)}</span></div>
      <div><span class="verdict ${g.verdict}">${g.verdict}</span> <span class="muted">${esc(statusText)}</span></div></div>
    <p class="why"><b>${esc(g.headline)}</b>${g.total ? ` Total ${fmt(g.total)}.` : ""} Agent's reason: "${esc(r.intent.agentReason)}"${r.pickNote ? ` <span class="by">(${esc(r.pickNote)})</span>` : ""}</p>
    <ul class="checks">${g.checks.map((c) => `<li><span class="out ${c.outcome}">${c.outcome.toUpperCase()}</span><b>${esc(c.label)}</b><span class="d">${esc(c.detail)}</span></li>`).join("")}</ul>
    <div class="actions">
      ${r.status === "needs_you" ? `<button class="ok" data-decide="approve" data-id="${r.intent.id}">Approve and pay</button><button class="warn" data-decide="reject" data-id="${r.intent.id}">Reject</button>` : ""}
      ${r.status === "awaiting_paypal" && r.approveUrl ? `<button class="primary" data-approve="${esc(r.approveUrl)}">Approve in PayPal</button>` : ""}
      ${r.error ? `<span class="callout err">${esc(r.error)}</span>` : ""}
      ${r.orderId ? `<a href="#orders" class="muted">Order ${esc(r.orderId)}</a>` : ""}
    </div></article>`;
}

export function renderShop() {
  const src = $("source");
  if (!src.options.length) {
    src.innerHTML = `<option value="demo">Demo store (fictional, includes traps)</option>${st.S.modes.channel3 ? `<option value="channel3">Channel3 (real products)</option>` : ""}`;
  }
  const list = st.S.intents;
  $("shopOut").innerHTML = list.length ? list.map(decisionCard).join("") : `<p class="muted">No purchases yet.</p>`;
  $("shopOut").querySelectorAll("[data-decide]").forEach((b) => b.addEventListener("click", async () => {
    const r = await act(() => api(`/api/intents/${b.dataset.id}/decide`, { decision: b.dataset.decide }));
    const rec = r?.intents?.find((x) => x.intent.id === b.dataset.id);
    if (rec?.approveUrl) openApproval(rec.approveUrl);
  }));
  $("shopOut").querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => openApproval(b.dataset.approve)));
}

export async function runAgent(goal) {
  $("goal").value = goal;
  $("runAgent").disabled = true;
  try {
    const r = await act(() => api("/api/agent/run", { goal, source: $("source").value }));
    if (r?.run && !r.run.intentId) toast("The agent found nothing that fits.", true);
    return r;
  } finally {
    $("runAgent").disabled = false;
  }
}
