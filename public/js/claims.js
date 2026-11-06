import { $, act, api, caseCache, day, esc, fmt, st, toast } from "./core.js";

// Sections 4 and 5: orders with buyer claims, and the merchant desk.
export function renderOrders() {
  if (!st.S.orders.length) return ($("ordersOut").innerHTML = `<p class="muted">Orders appear here once the agent pays.</p>`);
  $("ordersOut").innerHTML = st.S.orders.map((o) => {
    const c = caseCache.get(o.id);
    const delivered = o.shipment.events.some((e) => e.status === "DELIVERED");
    return `<article class="order">
      <div class="top-line"><div><b>${esc(o.offer.title)}</b><div class="muted">${esc(o.offer.merchant.name)} · ${fmt(o.total)} · paid ${day(o.placedAt)} · capture <code>${esc(o.paypal.captureId)}</code></div></div>
      <div class="muted">${esc(o.shipment.carrier)} <code>${esc(o.shipment.trackingNumber)}</code><br>promised by ${day(o.shipment.promisedBy)}</div></div>
      ${o.shipment.trackingError ? `<div class="callout err">Tracking wasn't added to the PayPal order: ${esc(o.shipment.trackingError)}</div>` : ""}
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
  box.querySelectorAll("[data-rehearse]").forEach((b) => b.addEventListener("click", () => fileClaim(b.dataset.rehearse, true)));
}

export function factsTable(facts) {
  return `<table class="facts">${facts.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td><td class="src">${esc(f.source)}</td></tr>`).join("")}</table>`;
}

export function deadlineText(d) {
  if (!d) return "";
  const urgent = d.hoursLeft < 72;
  const left = d.hoursLeft < 0 ? `closed ${Math.abs(Math.round(d.hoursLeft / 24))} days ago` : d.hoursLeft < 48 ? `${d.hoursLeft} hours left` : `${Math.floor(d.hoursLeft / 24)} days left`;
  return `<p class="deadline ${urgent ? "urgent" : ""}">${esc(d.label)}: ${day(d.at)} (${left})</p>`;
}

export function caseBox(c, o) {
  const k = c.case;
  const can = k.action.startsWith("FILE") && !o.disputeId;
  return `<div class="casebox"><b>Claim file:</b> ${esc(k.action.replace(/_/g, " ").toLowerCase())}. ${esc(k.rationale)}
    ${deadlineText(k.deadline)}${factsTable(k.facts)}
    ${c.draft ? `<label>Note to PayPal <span class="by">drafted by ${esc(c.draft.by)}${c.draft.note ? `; ${esc(c.draft.note)}` : ""}</span><textarea id="note-${o.id}" rows="4">${esc(c.draft.value)}</textarea></label>` : ""}
    ${can ? `<div class="row"><button class="primary" data-file="${o.id}">Approve and file with PayPal</button><span class="muted">Nothing is filed until you press this.</span></div>` : ""}
    ${c.instructions ? `<div class="callout w">${esc(c.instructions)}${c.rehearsalAvailable && !o.disputeId ? `<div class="row"><button class="small" data-rehearse="${o.id}">Open a rehearsal dispute</button></div>` : ""}</div>` : ""}</div>`;
}

export async function loadCase(orderId) {
  try {
    const c = await api(`/api/orders/${orderId}/case`);
    caseCache.set(orderId, c);
    renderOrders();
    return c;
  } catch (e) { toast(e.message, true); }
}

export async function fileClaim(orderId, rehearse = false) {
  const note = $(`note-${orderId}`)?.value ?? "";
  const r = await act(() => api(`/api/orders/${orderId}/file`, { note, rehearse }));
  const c = caseCache.get(orderId);
  if (r?.filed) {
    caseCache.delete(orderId);
    toast(r.rehearsal ? `Rehearsal dispute ${r.dispute.id} opened (not in PayPal). See the merchant desk.` : `Dispute ${r.dispute.id} opened. See the merchant desk.`);
    await loadMerchant();
  } else if (r && c) { c.instructions = r.instructions; c.rehearsalAvailable = r.rehearsalAvailable; renderOrders(); }
  return r;
}

export async function loadMerchant() {
  try {
    st.merchant = await api("/api/merchant/disputes");
  } catch (e) { st.merchant = { cases: [], error: e.message }; }
  renderMerchant();
}

export function renderMerchant() {
  $("disputeNote").textContent = st.S?.modes.paypal === "sandbox"
    ? `Live from the PayPal sandbox Disputes API.${st.merchant.hidden ? ` ${st.merchant.hidden} dispute(s) from other visitors hidden.` : ""}`
    : "From the simulated PayPal.";
  const err = st.merchant.error ? `<div class="callout err">${esc(st.merchant.error)}</div>` : "";
  const cases = [...st.merchant.cases].sort((a, b) => (a.case.deadline?.hoursLeft ?? 1e9) - (b.case.deadline?.hoursLeft ?? 1e9));
  if (!cases.length) return ($("merchantOut").innerHTML = err || `<p class="muted">No open disputes.</p>`);
  $("merchantOut").innerHTML = err + cases.map((v) => {
    const d = v.dispute, k = v.case;
    const rh = d.rehearsal ? `<div class="callout w">REHEARSAL dispute: kept in this app because sandbox buyers can only open disputes by hand in the Resolution Center. Nothing here is sent to the PayPal Disputes API; a refund it leads to is a real sandbox refund (Payments v2).</div>` : "";
    return `<article class="order">${rh}<div class="top-line"><div><b>${esc(d.id)}</b> · ${esc(d.reason.replace(/_/g, " ").toLowerCase())}<div class="muted">${esc(d.status)}${d.stage ? ` / ${esc(d.stage)}` : ""} · ${fmt(d.amount)}${v.orderId ? ` · order ${esc(v.orderId)}` : ""}</div></div>
      <span class="verdict ${k.blocked === "resolved" ? "ALLOW" : k.blocked ? "DENY" : "ASK"}">${esc(k.blocked === "resolved" ? "RESOLVED" : k.blocked ? k.blocked.toUpperCase() : k.action.replace(/_/g, " "))}</span></div>
      ${k.blocked === "resolved" ? "" : deadlineText(k.deadline)}<p><b>Recommendation:</b> ${esc(k.rationale)}</p>${factsTable(k.facts)}
      ${v.draft && !k.blocked ? `<label>Response <span class="by">drafted by ${esc(v.draft.by)}${v.draft.note ? `; ${esc(v.draft.note)}` : ""}</span><textarea id="mnote-${d.id}" rows="4">${esc(v.draft.value)}</textarea></label>
        <div class="row"><button class="primary" data-submit="${d.id}" data-action="${k.action}">${d.rehearsal ? "Approve (rehearsal)" : "Approve and send to PayPal"}</button></div>` : ""}
      ${d.status === "UNDER_REVIEW" ? `<div class="row"><span class="muted">${d.rehearsal ? "Rehearsal decision:" : "Sandbox simulation (adjudicate):"}</span><button class="small" data-sim="${d.id}" data-out="SELLER_FAVOR">PayPal sides with seller</button><button class="small" data-sim="${d.id}" data-out="BUYER_FAVOR">PayPal sides with buyer</button></div>` : ""}
    </article>`;
  }).join("");
  $("merchantOut").querySelectorAll("[data-submit]").forEach((b) => b.addEventListener("click", () => submitMerchant(b.dataset.submit, b.dataset.action)));
  $("merchantOut").querySelectorAll("[data-sim]").forEach((b) => b.addEventListener("click", async () => {
    await act(() => api(`/api/merchant/disputes/${b.dataset.sim}/simulate`, { outcome: b.dataset.out }), "Simulated PayPal decision applied.");
    await loadMerchant();
  }));
}

export async function submitMerchant(id, action) {
  const note = $(`mnote-${id}`)?.value ?? "";
  await act(() => api(`/api/merchant/disputes/${id}/submit`, { action, note }), "Response sent to PayPal.");
  await loadMerchant();
}
