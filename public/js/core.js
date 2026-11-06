// Shared helpers and state for the Countersign UI (plain ES modules, no build step).
// All numbers shown come from the server.
export const $ = (id) => document.getElementById(id);
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const ZERO_DEC = new Set(["JPY", "HUF", "TWD", "KRW"]);
export const fmt = (m) => {
  if (!m) return "-";
  const d = ZERO_DEC.has(m.currency) ? 0 : 2;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(m.minor / 10 ** d); }
  catch { return `${m.minor / 10 ** d} ${m.currency}`; }
};
export const day = (iso) => (iso ? iso.slice(0, 10) : "-");
export const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";

/** Shared UI state. render is set by app.js. */
export const st = { S: null, merchant: { cases: [], error: null }, render: () => {} };
export const caseCache = new Map();

export async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `on${bad ? " bad" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), bad ? 6000 : 3000);
}

export async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (r && r.modes) st.S = r;
    else if (r && r.state) st.S = r.state;
    st.render();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    try { st.S = await api("/api/state"); st.render(); } catch { /* keep the old view */ }
    throw e;
  }
}
