// Measures how often model-written dispute notes pass the number/ID guard.
import { activatePolicy, draftPolicyFor, onPayPalReturn, openEnvelope, runAgent } from "../src/app/commerce.js";
import { loadConfig } from "../src/app/config.js";
import { advanceClock, buyerCaseFor, fileBuyerDispute, merchantCases, setShipPlan } from "../src/app/disputes.js";
import { Session } from "../src/app/session.js";

const cfg = { ...loadConfig(), sandbox: null, channel3: null };
let used = 0, replaced = 0;
const N = Number(process.env.N ?? 4);
for (let i = 0; i < N; i++) {
  const s = new Session(cfg);
  await draftPolicyFor(s, "Up to $150 per purchase and $250 a day. Returns must be accepted.", "America/Los_Angeles");
  activatePolicy(s);
  const e = await openEnvelope(s, "200");
  s.sim!.approve(e.orderId);
  await onPayPalReturn(s, e.orderId);
  await runAgent(s, "noise-cancelling headphones for my commute", "demo");
  setShipPlan(s, s.orders[0]!.id, "stalled");
  advanceClock(s, 6 + i);
  const b = await buyerCaseFor(s, s.orders[0]!.id);
  for (const d of [b.draft!]) { if (d.by === "rules") { replaced++; console.log("buyer replaced:", d.note); } else used++; }
  await fileBuyerDispute(s, s.orders[0]!.id, b.draft!.value);
  const { cases } = await merchantCases(s);
  for (const c of cases) if (c.draft) { if (c.draft.by === "rules") { replaced++; console.log("merchant replaced:", c.draft.note); } else { used++; if (i === 0) console.log("sample merchant note:", c.draft.value); } }
  if (i === 0) console.log("sample buyer note:", b.draft!.value);
}
console.log(`model drafts used ${used}, replaced by template ${replaced}`);
