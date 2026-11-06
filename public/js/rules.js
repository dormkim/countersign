import { $, ZERO_DEC, act, api, day, esc, fmt, st } from "./core.js";

// Header, rules (section 1) and the daily PayPal budget (section 2).
export function renderModes() {
  const m = st.S.modes;
  $("modes").innerHTML = [
    `<span class="chip ${m.paypal === "sandbox" ? "live" : "off"}">PayPal: <b>${m.paypal === "sandbox" ? "Sandbox (live API)" : "Simulated"}</b></span>`,
    `<span class="chip ${m.ai ? "live" : "off"}">AI: <b>${esc(m.ai ?? "Offline rules")}</b></span>`,
    `<span class="chip ${m.channel3 ? "live" : "off"}">Catalog: <b>${m.channel3 ? "Channel3 + demo" : "Demo store"}</b></span>`,
  ].join("");
  const now = new Date(st.S.now);
  $("clock").innerHTML = `${now.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}${st.S.clockOffsetDays ? ` <b>(+${st.S.clockOffsetDays} days, simulated)</b>` : ""}`;
}

export const POLICY_PRESETS = {
  "Commuter rules": "Up to $150 per purchase and $250 a day. Ask me before anything over $140. No gift cards or crypto. Returns must be accepted.",
  "Strict": "Only buy books and office supplies. Nothing over $40 per purchase, $60 a day. Never buy from unknown sellers. Only shop between 9am and 6pm.",
  "Vague (watch it ask)": "Keep it cheap and don't go crazy, maybe a hundred a day.",
  "Wrong currency": "Spend up to 50000 won per item and 100000 won a day.",
};

export function rulesGrid(p) {
  const cell = (k, v) => `<div class="rule"><small>${k}</small><b>${v}</b></div>`;
  return `<div class="grid">${[
    cell("Per purchase", fmt(p.perPurchaseMax)),
    cell("Per day", fmt(p.dailyMax)),
    cell("Ask me above", p.askAbove ? fmt(p.askAbove) : "never"),
    cell("Allowed categories", p.allowedCategories ? esc(p.allowedCategories.join(", ").replace(/_/g, " ")) : "any not blocked"),
    cell("Blocked", esc(p.blockedCategories.join(", ").replace(/_/g, " ") || "none")),
    cell("Seller trust", `${p.minMerchantTrust}/100 min; unknown: ${p.unknownMerchant}`),
    cell("Hours", p.hours ? `${p.hours.start}-${p.hours.end} (${esc(p.hours.tz)})` : "any time"),
    cell("Delivery", p.maxDeliveryDays ? `within ${p.maxDeliveryDays} days` : "no limit"),
    cell("Returns", p.requireReturns ? "required" : "not required"),
  ].join("")}</div>`;
}

export function renderPolicy() {
  const ps = st.S.policy;
  if (!$("policyText").value && ps.text) $("policyText").value = ps.text;
  $("draftBy").textContent = ps.draft ? `Drafted by ${ps.draftedBy === "rules" ? "the offline rule parser" : ps.draftedBy}, checked by code` : "";
  let html = "";
  if (ps.draftNote) html += `<div class="callout w">${esc(ps.draftNote)}</div>`;
  const d = ps.draft;
  if (d) {
    if (d.questions.length) html += `<div class="callout q"><b>Before this can go live, answer:</b><ul>${d.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul><span class="muted">Add the answer to your text and draft again.</span></div>`;
    if (d.warnings.length) html += `<div class="callout w"><ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    if (d.policy) {
      html += rulesGrid(d.policy);
      const same = ps.active && JSON.stringify(ps.active) === JSON.stringify(d.policy);
      html += same
        ? `<div class="callout ok">Active since ${new Date(ps.activatedAt).toLocaleString("en-US")}. Every purchase below is checked against these rules.</div>`
        : `<div class="row"><button class="primary" id="activate">Activate these rules</button><span class="muted">You are signing off on exactly what is shown.</span></div>`;
    }
  }
  $("policyOut").innerHTML = html;
  $("activate")?.addEventListener("click", () => act(() => api("/api/policy/activate", {}), "Rules activated."));
}

export function renderBudget() {
  const p = st.S.policy.active;
  const e = st.S.envelope;
  if (!p) return ($("budgetOut").innerHTML = `<p class="muted">Activate rules first.</p>`);
  let html = "";
  if (!e || e.status === "voided" || e.status === "failed" || e.day !== st.S.today) {
    if (e?.status === "failed") html += `<div class="callout err">Last budget failed: ${esc(e.error)}</div>`;
    if (e && e.day !== st.S.today && e.status === "active") html += `<div class="callout w">Yesterday's budget no longer covers purchases. Release it and approve a new one.</div>`;
    const dec = ZERO_DEC.has(p.currency) ? 1 : 100;
    html += `<div class="row"><input id="envAmount" value="${Math.min(p.dailyMax.minor / dec, p.currency === "USD" ? 200 : Infinity).toFixed(0)}" size="8" aria-label="Budget amount"> <span>${p.currency}</span>
      <button class="primary" id="openEnv">Create budget and approve in PayPal</button></div>
      <p class="muted">Without a budget the agent still works, but every purchase needs its own PayPal approval.</p>`;
    if (e?.status === "active") html += `<button class="small" id="voidEnv">Release yesterday's budget</button>`;
  } else if (e.status === "awaiting_paypal") {
    html += `<div class="callout q">Waiting for your approval in PayPal. <a href="${esc(e.approveUrl)}" class="ghost" target="${st.S.modes.paypal === "sandbox" ? "_blank" : "_self"}">Open PayPal approval</a></div>`;
  } else {
    const used = e.captured.minor / e.amount.minor;
    html += `<div class="kv"><div><small>Authorized</small><b>${fmt(e.amount)}</b></div><div><small>Captured by the agent</small><b>${fmt(e.captured)}</b></div><div><small>Left today</small><b>${fmt(st.S.envelopeRemaining)}</b></div><div><small>Authorization</small><code>${esc(e.authorizationId)}</code></div></div>
      <div class="meter"><span style="width:${Math.min(100, used * 100)}%"></span></div>
      <button class="small" id="voidEnv">Release unused budget (void)</button>`;
  }
  $("budgetOut").innerHTML = html;
  $("openEnv")?.addEventListener("click", async () => {
    const r = await act(() => api("/api/envelope", { amount: $("envAmount").value }));
    if (r?.envelope?.approveUrl) openApproval(r.envelope.approveUrl);
  });
  $("voidEnv")?.addEventListener("click", () => act(() => api("/api/envelope/void", {}), "Unused budget released."));
}

export function openApproval(url) {
  if (st.S.modes.paypal === "sandbox") window.open(url, "_blank", "noopener");
  else location.href = url;
}
