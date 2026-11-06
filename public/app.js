import { $, act, api, caseCache, day, esc, st, toast, tz } from "./js/core.js";
import { POLICY_PRESETS, renderBudget, renderModes, renderPolicy } from "./js/rules.js";
import { GOALS, renderShop, runAgent } from "./js/shop.js";
import { loadMerchant, renderOrders } from "./js/claims.js";
import { renderAudit, renderSplitOnce } from "./js/extras.js";
import { play } from "./js/story.js";

// Countersign UI entry: wires sections together and boots.
function render() {
  if (!st.S) return;
  renderModes();
  renderPolicy();
  renderBudget();
  renderShop();
  renderOrders();
  renderAudit();
}

function boot() {
  $("presets").innerHTML = Object.keys(POLICY_PRESETS).map((k) => `<button data-p="${esc(k)}">${esc(k)}</button>`).join("");
  $("presets").addEventListener("click", (e) => { if (e.target.dataset.p) $("policyText").value = POLICY_PRESETS[e.target.dataset.p]; });
  $("goals").innerHTML = GOALS.map((g) => `<button data-g="${esc(g)}">${esc(g)}</button>`).join("");
  $("goals").addEventListener("click", (e) => { if (e.target.dataset.g) runAgent(e.target.dataset.g); });
  $("draft").addEventListener("click", async () => {
    $("draft").disabled = true;
    try { await act(() => api("/api/policy/draft", { text: $("policyText").value, tz })); } finally { $("draft").disabled = false; }
  });
  $("runAgent").addEventListener("click", () => runAgent($("goal").value));
  $("goal").addEventListener("keydown", (e) => { if (e.key === "Enter") runAgent($("goal").value); });
  $("refreshDisputes").addEventListener("click", loadMerchant);
  document.querySelectorAll("[data-ff]").forEach((b) => b.addEventListener("click", async () => {
    await act(() => api("/api/clock/advance", { days: Number(b.dataset.ff) }), `Clock moved ${b.dataset.ff} day(s) forward.`);
    caseCache.clear();
    renderOrders();
    loadMerchant();
  }));
  $("play").addEventListener("click", play);
  $("reset").addEventListener("click", async () => { await fetch("/api/reset", { method: "POST" }); location.href = "/"; });
  renderSplitOnce();
  api("/api/state").then((s) => { st.S = s; render(); loadMerchant(); }).catch((e) => toast(e.message, true));
  const q = new URLSearchParams(location.search);
  if (q.has("cancelled")) toast("PayPal approval was cancelled. Nothing was charged.");
  if (q.get("error")) toast(q.get("error"), true);
  // A PayPal approval in another tab returns there; keep this tab in sync while anything waits on PayPal.
  setInterval(async () => {
    if (!st.S || document.hidden) return;
    const waiting = st.S.envelope?.status === "awaiting_paypal" || st.S.intents.some((r) => r.status === "awaiting_paypal" || r.status === "capturing");
    if (!waiting) return;
    try { st.S = await api("/api/state"); render(); } catch { /* next tick */ }
  }, 3000);
}
boot();

st.render = render;
