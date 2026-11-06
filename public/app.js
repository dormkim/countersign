// Countersign UI. Plain modules, no build step. All numbers shown come from the server.
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ZERO_DEC = new Set(["JPY", "HUF", "TWD", "KRW"]);
const fmt = (m) => {
  if (!m) return "-";
  const d = ZERO_DEC.has(m.currency) ? 0 : 2;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(m.minor / 10 ** d); }
  catch { return `${m.minor / 10 ** d} ${m.currency}`; }
};
const day = (iso) => (iso ? iso.slice(0, 10) : "-");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";

let S = null;
let merchant = { cases: [], error: null };
const caseCache = new Map();

async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `on${bad ? " bad" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), bad ? 6000 : 3000);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (r && r.modes) S = r;
    else if (r && r.state) S = r.state;
    render();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

// ---------- header ----------
function renderModes() {
  const m = S.modes;
  $("modes").innerHTML = [
    `<span class="chip ${m.paypal === "sandbox" ? "live" : "off"}">PayPal: <b>${m.paypal === "sandbox" ? "Sandbox (live API)" : "Simulated"}</b></span>`,
    `<span class="chip ${m.ai ? "live" : "off"}">AI: <b>${esc(m.ai ?? "Offline rules")}</b></span>`,
    `<span class="chip ${m.channel3 ? "live" : "off"}">Catalog: <b>${m.channel3 ? "Channel3 + demo" : "Demo store"}</b></span>`,
  ].join("");
  const now = new Date(S.now);
  $("clock").innerHTML = `${now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}${S.clockOffsetDays ? ` <b>(+${S.clockOffsetDays} days, simulated)</b>` : ""}`;
}

// ---------- 1. rules ----------
const POLICY_PRESETS = {
  "Commuter rules": "Up to $150 per purchase and $250 a day. Ask me before anything over $140. No gift cards or crypto. Returns must be accepted.",
  "Strict": "Only buy books and office supplies. Nothing over $40 per purchase, $60 a day. Never buy from unknown sellers. Only shop between 9am and 6pm.",
  "Vague (watch it ask)": "Keep it cheap and don't go crazy, maybe a hundred a day.",
  "Wrong currency": "Spend up to 50000 won per item and 100000 won a day.",
};

function rulesGrid(p) {
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

function renderPolicy() {
  const ps = S.policy;
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

// ---------- 2. budget ----------
function renderBudget() {
  const p = S.policy.active;
  const e = S.envelope;
  if (!p) return ($("budgetOut").innerHTML = `<p class="muted">Activate rules first.</p>`);
  let html = "";
  if (!e || e.status === "voided" || e.status === "failed" || e.day !== S.today) {
    if (e?.status === "failed") html += `<div class="callout err">Last budget failed: ${esc(e.error)}</div>`;
    if (e && e.day !== S.today && e.status === "active") html += `<div class="callout w">Yesterday's budget no longer covers purchases. Release it and approve a new one.</div>`;
    html += `<div class="row"><input id="envAmount" value="${(p.dailyMax.minor / 100 >= 200 ? 200 : p.dailyMax.minor / 100).toFixed(0)}" size="8" aria-label="Budget amount"> <span>${p.currency}</span>
      <button class="primary" id="openEnv">Create budget and approve in PayPal</button></div>
      <p class="muted">Without a budget the agent still works, but every purchase needs its own PayPal approval.</p>`;
    if (e?.status === "active") html += `<button class="small" id="voidEnv">Release yesterday's budget</button>`;
  } else if (e.status === "awaiting_paypal") {
    html += `<div class="callout q">Waiting for your approval in PayPal. <a href="${esc(e.approveUrl)}" class="ghost" target="${S.modes.paypal === "sandbox" ? "_blank" : "_self"}">Open PayPal approval</a></div>`;
  } else {
    const used = e.captured.minor / e.amount.minor;
    html += `<div class="kv"><div><small>Authorized</small><b>${fmt(e.amount)}</b></div><div><small>Captured by the agent</small><b>${fmt(e.captured)}</b></div><div><small>Left today</small><b>${fmt(S.envelopeRemaining)}</b></div><div><small>Authorization</small><code>${esc(e.authorizationId)}</code></div></div>
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

function openApproval(url) {
  if (S.modes.paypal === "sandbox") window.open(url, "_blank", "noopener");
  else location.href = url;
}

// ---------- 3. agent and gate ----------
const GOALS = [
  "noise-cancelling headphones for my commute",
  "backup headphones under $70",
  "a $100 gift card for my sister",
  "packing cubes for my trip",
  "a handmade paper notebook",
  "wireless earbuds",
  "trail mix snack",
  "pocket projector",
];

function decisionCard(r) {
  const o = r.offer;
  const g = r.gate;
  const statusText = { allowed: "Allowed", needs_you: "Needs you", denied: "Blocked", rejected: "You rejected it", awaiting_paypal: "Waiting for PayPal approval", paid: "Paid", payment_failed: "Payment failed" }[r.status];
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

function renderShop() {
  const src = $("source");
  if (!src.options.length) {
    src.innerHTML = `<option value="demo">Demo store (fictional, includes traps)</option>${S.modes.channel3 ? `<option value="channel3">Channel3 (real products)</option>` : ""}`;
  }
  const list = S.intents;
  $("shopOut").innerHTML = list.length ? list.map(decisionCard).join("") : `<p class="muted">No purchases yet.</p>`;
  $("shopOut").querySelectorAll("[data-decide]").forEach((b) => b.addEventListener("click", async () => {
    const r = await act(() => api(`/api/intents/${b.dataset.id}/decide`, { decision: b.dataset.decide }));
    const rec = r?.intents?.find((x) => x.intent.id === b.dataset.id);
    if (rec?.approveUrl) openApproval(rec.approveUrl);
  }));
  $("shopOut").querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => openApproval(b.dataset.approve)));
}

async function runAgent(goal) {
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

// ---------- 4. orders and claims ----------
function renderOrders() {
  if (!S.orders.length) return ($("ordersOut").innerHTML = `<p class="muted">Orders appear here once the agent pays.</p>`);
  $("ordersOut").innerHTML = S.orders.map((o) => {
    const c = caseCache.get(o.id);
    const delivered = o.shipment.events.some((e) => e.status === "DELIVERED");
    return `<article class="order">
      <div class="top-line"><div><b>${esc(o.offer.title)}</b><div class="muted">${esc(o.offer.merchant.name)} · ${fmt(o.total)} · paid ${day(o.placedAt)} · capture <code>${esc(o.paypal.captureId)}</code></div></div>
      <div class="muted">${esc(o.shipment.carrier)} <code>${esc(o.shipment.trackingNumber)}</code><br>promised by ${day(o.shipment.promisedBy)}</div></div>
      <ul class="timeline">${o.shipment.events.map((e) => `<li class="${e.status}">${day(e.at)} · ${esc(e.status.replace(/_/g, " ").toLowerCase())} · ${esc(e.where)}</li>`).join("") || "<li>no scans yet</li>"}</ul>
      <p><b>Copilot:</b> ${esc(o.buyer.rationale)}${o.refunds.length ? ` · refunded ${o.refunds.map((r) => fmt(r.amount)).join(", ")}` : ""}${o.disputeId ? ` · dispute <code>${esc(o.disputeId)}</code>` : ""}</p>
      <div class="row wrap">
        <label class="muted">Simulate carrier <select data-plan="${o.id}"><option value="">choose</option><option value="on_time">delivers on time</option><option value="stalled">loses the parcel</option><option value="damaged">delivers it damaged</option></select></label>
        ${delivered && !o.issue ? `<button class="small" data-report="${o.id}">Report it arrived damaged</button>` : ""}
        <button class="small" data-case="${o.id}">Build claim</button>
      </div>
      ${c ? caseBox(c, o) : ""}
    </article>`;
  }).join("");
  const box = $("ordersOut");
  box.querySelectorAll("[data-plan]").forEach((sel) => sel.addEventListener("change", () => sel.value && act(() => api(`/api/orders/${sel.dataset.plan}/ship-plan`, { plan: sel.value }), "Carrier simulation updated.")));
  box.querySelectorAll("[data-report]").forEach((b) => b.addEventListener("click", () => {
    const note = prompt("What's wrong with it?", "Left earcup cracked, right side has no sound.");
    if (note) act(() => api(`/api/orders/${b.dataset.report}/report`, { note }), "Problem recorded.");
  }));
  box.querySelectorAll("[data-case]").forEach((b) => b.addEventListener("click", () => loadCase(b.dataset.case)));
  box.querySelectorAll("[data-file]").forEach((b) => b.addEventListener("click", () => fileClaim(b.dataset.file)));
}

function factsTable(facts) {
  return `<table class="facts">${facts.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td><td class="src">${esc(f.source)}</td></tr>`).join("")}</table>`;
}

function deadlineText(d) {
  if (!d) return "";
  const urgent = d.hoursLeft < 72;
  const left = d.hoursLeft < 0 ? `closed ${Math.abs(Math.round(d.hoursLeft / 24))} days ago` : d.hoursLeft < 48 ? `${d.hoursLeft} hours left` : `${Math.floor(d.hoursLeft / 24)} days left`;
  return `<p class="deadline ${urgent ? "urgent" : ""}">${esc(d.label)}: ${day(d.at)} (${left})</p>`;
}

function caseBox(c, o) {
  const k = c.case;
  const can = k.action.startsWith("FILE") && !o.disputeId;
  return `<div class="casebox"><b>Claim file:</b> ${esc(k.action.replace(/_/g, " ").toLowerCase())}. ${esc(k.rationale)}
    ${deadlineText(k.deadline)}${factsTable(k.facts)}
    ${c.draft ? `<label>Note to PayPal <span class="by">drafted by ${esc(c.draft.by)}${c.draft.note ? `; ${esc(c.draft.note)}` : ""}</span><textarea id="note-${o.id}" rows="4">${esc(c.draft.value)}</textarea></label>` : ""}
    ${can ? `<div class="row"><button class="primary" data-file="${o.id}">Approve and file with PayPal</button><span class="muted">Nothing is filed until you press this.</span></div>` : ""}
    ${c.instructions ? `<div class="callout w">${esc(c.instructions)}</div>` : ""}</div>`;
}

async function loadCase(orderId) {
  try {
    const c = await api(`/api/orders/${orderId}/case`);
    caseCache.set(orderId, c);
    renderOrders();
    return c;
  } catch (e) { toast(e.message, true); }
}

async function fileClaim(orderId) {
  const note = $(`note-${orderId}`)?.value ?? "";
  const r = await act(() => api(`/api/orders/${orderId}/file`, { note }));
  const c = caseCache.get(orderId);
  if (r?.filed) { caseCache.delete(orderId); toast(`Dispute ${r.dispute.id} opened. See the merchant desk.`); await loadMerchant(); }
  else if (r && c) { c.instructions = r.instructions; renderOrders(); }
  return r;
}

// ---------- 5. merchant desk ----------
async function loadMerchant() {
  try {
    merchant = await api("/api/merchant/disputes");
  } catch (e) { merchant = { cases: [], error: e.message }; }
  renderMerchant();
}

function renderMerchant() {
  $("disputeNote").textContent = S?.modes.paypal === "sandbox"
    ? `Live from the PayPal sandbox Disputes API.${merchant.hidden ? ` ${merchant.hidden} dispute(s) from other visitors hidden.` : ""}`
    : "From the simulated PayPal.";
  if (merchant.error) return ($("merchantOut").innerHTML = `<div class="callout err">${esc(merchant.error)}</div>`);
  const cases = [...merchant.cases].sort((a, b) => (a.case.deadline?.hoursLeft ?? 1e9) - (b.case.deadline?.hoursLeft ?? 1e9));
  if (!cases.length) return ($("merchantOut").innerHTML = `<p class="muted">No open disputes.</p>`);
  $("merchantOut").innerHTML = cases.map((v) => {
    const d = v.dispute, k = v.case;
    return `<article class="order"><div class="top-line"><div><b>${esc(d.id)}</b> · ${esc(d.reason.replace(/_/g, " ").toLowerCase())}<div class="muted">${esc(d.status)}${d.stage ? ` / ${esc(d.stage)}` : ""} · ${fmt(d.amount)}${v.orderId ? ` · order ${esc(v.orderId)}` : ""}</div></div>
      <span class="verdict ${k.blocked === "resolved" ? "ALLOW" : k.blocked ? "DENY" : "ASK"}">${esc(k.blocked === "resolved" ? "RESOLVED" : k.blocked ? k.blocked.toUpperCase() : k.action.replace(/_/g, " "))}</span></div>
      ${k.blocked === "resolved" ? "" : deadlineText(k.deadline)}<p><b>Recommendation:</b> ${esc(k.rationale)}</p>${factsTable(k.facts)}
      ${v.draft && !k.blocked ? `<label>Response <span class="by">drafted by ${esc(v.draft.by)}${v.draft.note ? `; ${esc(v.draft.note)}` : ""}</span><textarea id="mnote-${d.id}" rows="4">${esc(v.draft.value)}</textarea></label>
        <div class="row"><button class="primary" data-submit="${d.id}" data-action="${k.action}">Approve and send to PayPal</button></div>` : ""}
      ${d.status === "UNDER_REVIEW" ? `<div class="row"><span class="muted">Sandbox simulation (adjudicate):</span><button class="small" data-sim="${d.id}" data-out="SELLER_FAVOR">PayPal sides with seller</button><button class="small" data-sim="${d.id}" data-out="BUYER_FAVOR">PayPal sides with buyer</button></div>` : ""}
    </article>`;
  }).join("");
  $("merchantOut").querySelectorAll("[data-submit]").forEach((b) => b.addEventListener("click", () => submitMerchant(b.dataset.submit, b.dataset.action)));
  $("merchantOut").querySelectorAll("[data-sim]").forEach((b) => b.addEventListener("click", async () => {
    await act(() => api(`/api/merchant/disputes/${b.dataset.sim}/simulate`, { outcome: b.dataset.out }), "Simulated PayPal decision applied.");
    await loadMerchant();
  }));
}

async function submitMerchant(id, action) {
  const note = $(`mnote-${id}`)?.value ?? "";
  await act(() => api(`/api/merchant/disputes/${id}/submit`, { action, note }), "Response sent to PayPal.");
  await loadMerchant();
}

// ---------- split ----------
function renderSplitOnce() {
  $("splitOut").innerHTML = `<div class="row wrap"><input id="spTitle" value="Lake cabin weekend" aria-label="What was bought"><input id="spTotal" value="642.50" size="8" aria-label="Total"><input id="spCur" value="USD" size="4" aria-label="Currency"><input id="spPayer" value="you@example.com" aria-label="Your email"></div>
    <div class="members" id="spMembers"></div>
    <div class="row"><button class="small" id="spAdd">Add person</button><button id="spPreview">Preview split</button><button class="primary" id="spSend">Send PayPal invoices</button></div>
    <div id="spOut"></div>`;
  const people = [["You", "you@example.com", 3], ["Mina", "mina@example.com", 3], ["Leo", "leo@example.com", 2], ["Sam", "sam@example.com", 1]];
  const row = ([n, e, w]) => `<div class="m"><input value="${esc(n)}" aria-label="Name"><input value="${esc(e)}" aria-label="Email"><input value="${w}" aria-label="Weight (nights)"><button class="small" title="Remove">x</button></div>`;
  $("spMembers").innerHTML = people.map(row).join("");
  $("spMembers").addEventListener("click", (ev) => { if (ev.target.tagName === "BUTTON") ev.target.parentElement.remove(); });
  $("spAdd").addEventListener("click", () => $("spMembers").insertAdjacentHTML("beforeend", row(["", "", 1])));
  const payload = () => ({
    title: $("spTitle").value, total: $("spTotal").value, currency: $("spCur").value.toUpperCase(), payerEmail: $("spPayer").value,
    members: [...$("spMembers").children].map((m) => { const [n, e, w] = m.querySelectorAll("input"); return { name: n.value, email: e.value, weight: Number(w.value) }; }),
  });
  const show = (shares, results) => {
    $("spOut").innerHTML = `<table class="facts">${(results ?? shares).map((s) => `<tr><td>${esc(s.member?.name ?? s.member)}</td><td>${fmt(s.amount)}</td><td class="src">${results ? (s.ok ? `invoice ${esc(s.invoiceId)} sent` : `failed: ${esc(s.error)}`) : esc(s.member.email)}</td></tr>`).join("")}</table>`;
  };
  $("spPreview").addEventListener("click", async () => { try { const r = await api("/api/split/preview", payload()); show(r.shares); } catch (e) { toast(e.message, true); } });
  $("spSend").addEventListener("click", async () => { const r = await act(() => api("/api/split/send", payload())); if (r) show(null, r.results); });
}

// ---------- audit ----------
function renderAudit() {
  const ok = S.auditOk.ok;
  $("auditOut").innerHTML = `<div class="callout ${ok ? "ok" : "err"}">${ok ? `Chain intact: ${S.audit.length} most recent entries shown.` : `Chain broken at entry ${S.auditOk.brokenAt}.`}</div>
    <ul class="audit">${S.audit.map((e) => `<li><span class="h">#${e.seq}</span><span>${new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><b>${esc(e.actor)}</b><span>${esc(e.action)} <span class="h">${esc(JSON.stringify(e.detail))} · ${e.hash}</span></span></li>`).join("")}</ul>`;
}

function render() {
  if (!S) return;
  renderModes();
  renderPolicy();
  renderBudget();
  renderShop();
  renderOrders();
  renderAudit();
}

// ---------- the 30-second story ----------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function storyStep(step, say) {
  const items = [...$("story").querySelectorAll("li")];
  const idx = items.findIndex((li) => li.dataset.step === step);
  items.forEach((li, i) => { li.classList.toggle("done", i < idx); li.classList.toggle("now", i === idx); });
  $("story").querySelector(".say")?.remove();
  if (say) $("story").insertAdjacentHTML("beforeend", `<div class="say">${esc(say)}</div>`);
}
const go = (id) => document.getElementById(id).scrollIntoView({ behavior: "smooth", block: "start" });

async function waitFor(pred, ms = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    S = await api("/api/state");
    render();
    if (pred(S)) return true;
    await pause(2000);
  }
  return false;
}

async function play() {
  $("play").disabled = true;
  try {
    await fetch("/api/reset", { method: "POST" });
    caseCache.clear();
    S = await api("/api/state");
    render();
    storyStep("rules", "You say how the agent may spend. The rules are drafted, validated and shown back before you activate them.");
    go("rules");
    $("policyText").value = POLICY_PRESETS["Commuter rules"];
    await act(() => api("/api/policy/draft", { text: $("policyText").value, tz }));
    await pause(1200);
    await act(() => api("/api/policy/activate", {}));

    storyStep("budget", "One PayPal approval covers today's $200 budget. Nothing is charged yet.");
    go("budget");
    const env = await act(() => api("/api/envelope", { amount: "200" }));
    if (S.modes.paypal === "simulated") {
      await fetch(`/sim-paypal/approve/${env.envelope.orderId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "choice=approve" });
    } else {
      window.open(env.envelope.approveUrl, "_blank", "noopener");
      storyStep("budget", "Approve the budget in the PayPal sandbox window. The story continues when PayPal confirms.");
      if (!(await waitFor((s) => s.envelope?.status === "active"))) throw new Error("PayPal approval did not arrive in 3 minutes.");
    }
    S = await api("/api/state");
    render();
    await pause(900);

    storyStep("buy", "The agent finds headphones. Every check passes, so it pays from the budget on its own.");
    go("shop");
    await runAgent(GOALS[0]);
    await pause(1600);

    storyStep("trap", "A cheaper listing hides instructions aimed at AI agents. The gate flags it and waits for you. A gift card is blocked outright.");
    await runAgent(GOALS[1]);
    await pause(1400);
    await runAgent(GOALS[2]);
    await pause(1600);

    storyStep("lost", "A week later the headphones still haven't arrived. Tracking stalled in transit.");
    go("orders");
    const first = S.orders.at(-1);
    await act(() => api(`/api/orders/${first.id}/ship-plan`, { plan: "stalled" }));
    await act(() => api("/api/clock/advance", { days: 6 }));
    await loadCase(first.id);
    await pause(2200);

    storyStep("dispute", "You approve the claim. On the merchant side the same engine sees no delivery scan and recommends a refund, which PayPal pays out.");
    const filed = await fileClaim(first.id);
    if (filed?.filed) {
      go("merchant");
      await pause(1600);
      const v = merchant.cases.find((c) => c.dispute.id === filed.dispute.id);
      if (v && !v.case.blocked) await submitMerchant(v.dispute.id, v.case.action);
    }
    storyStep("done", "Rules you said, money you approved once, and a copilot that argued your case. Every step is in the audit log.");
    $("story").querySelectorAll("li").forEach((li) => { li.classList.add("done"); li.classList.remove("now"); });
  } catch (e) {
    toast(`Story stopped: ${e.message}`, true);
  } finally {
    $("play").disabled = false;
  }
}

// ---------- boot ----------
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
  api("/api/state").then((s) => { S = s; render(); loadMerchant(); }).catch((e) => toast(e.message, true));
  if (new URLSearchParams(location.search).has("cancelled")) toast("PayPal approval was cancelled. Nothing was charged.");
}
boot();
