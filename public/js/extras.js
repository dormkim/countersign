import { $, act, api, day, esc, fmt, st, toast } from "./core.js";

// Optional split and the audit log.
export function renderSplitOnce() {
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

export function renderAudit() {
  const ok = st.S.auditOk.ok;
  $("auditOut").innerHTML = `<div class="callout ${ok ? "ok" : "err"}">${ok ? `Chain intact: ${st.S.audit.length} most recent entries shown.` : `Chain broken at entry ${st.S.auditOk.brokenAt}.`}</div>
    <ul class="audit">${st.S.audit.map((e) => `<li><span class="h">#${e.seq}</span><span>${new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><b>${esc(e.actor)}</b><span>${esc(e.action)} <span class="h">${esc(JSON.stringify(e.detail))} · ${e.hash}</span></span></li>`).join("")}</ul>`;
}
