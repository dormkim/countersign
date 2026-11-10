// End-to-end scenario run: each scenario drives a fresh session through the real
// app flows (policy text -> gate -> simulated PayPal -> disputes) and checks the
// outcome. Scenarios live in eval/scenarios.ts. Usage: npm run eval   (LLM_PROVIDER/keys in env switch on the model)
import { cfg, SCENARIOS } from "./scenarios.js";

const rows: Array<{ name: string; got: string; want: string; ok: boolean; ms: number }> = [];
for (const [name, run, want] of SCENARIOS) {
  const t0 = performance.now();
  let got: string;
  try { got = await run(); } catch (e) { got = `ERROR ${(e as Error).message}`; }
  rows.push({ name, got, want, ok: got === want, ms: Math.round(performance.now() - t0) });
}
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
console.log(`Mode: AI=${cfg.llm?.name ?? "offline rules"}, PayPal=simulated, catalog=demo+eval listings\n`);
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 58)} ${pad(r.got, 42)} ${r.ok ? "" : `(want ${r.want}) `}${r.ms} ms`);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} passed · median ${ms[Math.floor(ms.length / 2)]} ms · max ${ms.at(-1)} ms per scenario`);
process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
