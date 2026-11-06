// Second sandbox check: every PayPal call the app makes that needs no buyer
// approval, run against captures that already exist (from `npm run smoke:sandbox`).
//
//   npm run smoke:sandbox2 -- <orderId> <captureId> [<captureId2>]
//
//   1. Payments v2   partial refund ($0.50) on the first capture, then the same
//                    PayPal-Request-Id again (must return the same refund, not a second one)
//   2. Orders v2     /track: tracking on the last capture, carrier USPS like the app
//   3. Invoicing v2  create + send one invoice to a fictional sandbox recipient (@personal.example.com)
//   4. Disputes v1   list disputes per capture (expect none), as the merchant desk does
//
// Each step reports on its own, so one failure doesn't hide the others.
// Never prints the client id, secret or token; only PayPal ids, statuses and debug_ids.
import { existsSync } from "node:fs";
import { formatMoney, money } from "../src/domain/money.js";
import { SandboxPayPal } from "../src/paypal/rest.js";
import { PayPalError } from "../src/paypal/types.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const id = process.env.PAYPAL_CLIENT_ID?.trim();
const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
const [orderArg, captureArg, captureArg2] = process.argv.slice(2);
if (!id || !secret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set (put them in .env). Nothing was called.");
  process.exit(2);
}
if (!orderArg || !captureArg) {
  console.error("Usage: npm run smoke:sandbox2 -- <orderId> <captureId> [<captureId2>]  (ids from npm run smoke:sandbox)");
  process.exit(2);
}
const orderId: string = orderArg;
const captureA: string = captureArg;
const captureB: string = captureArg2 ?? captureArg;

const pp = new SandboxPayPal(id, secret, process.env.PAYPAL_MERCHANT_EMAIL ?? "");
const tag = Date.now().toString(36);
let failed = 0;

async function step(name: string, run: () => Promise<string>) {
  try {
    console.log(`OK   ${name}  ${await run()}`);
  } catch (err) {
    failed++;
    if (err instanceof PayPalError) console.error(`FAIL ${name}  PayPal ${err.status} ${err.message}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`);
    else console.error(`FAIL ${name}  ${(err as Error).message}`);
  }
}

async function main() {
  const refundReq = `smoke2-rf-${captureA}-${tag}`;
  await step("Payments v2 refund (partial $0.50)", async () => {
    const r = await pp.refundCapture(captureA, money("0.50", "USD"), "Countersign sandbox smoke: partial refund", refundReq);
    const again = await pp.refundCapture(captureA, money("0.50", "USD"), "Countersign sandbox smoke: partial refund", refundReq);
    if (again.refundId !== r.refundId) throw new Error(`same PayPal-Request-Id gave a second refund ${again.refundId} (first ${r.refundId})`);
    return `refund=${r.refundId} status=${r.status} amount=${formatMoney(r.amount)}; retry with same PayPal-Request-Id returned the same refund`;
  });

  await step("Orders v2 add tracking (USPS)", async () => {
    const tracking = `9400${String(Math.floor(Math.random() * 1e15)).padStart(15, "0")}`;
    await pp.addTracking(orderId, captureB, "USPS", tracking);
    return `order=${orderId} capture=${captureB} tracking=${tracking}`;
  });

  await step("Invoicing v2 create + send", async () => {
    const inv = await pp.createInvoice({
      recipientEmail: "countersign-split-test@personal.example.com", recipientName: "Sandbox Friend", currency: "USD",
      items: [{ name: "Countersign smoke: share for Sandbox Friend", amount: money("1.25", "USD") }],
      note: "Sandbox smoke test invoice. Not a real request for money.", invoiceNumber: `CS-SMOKE2-${tag}`,
    });
    const sent = await pp.sendInvoice(inv.id);
    return `invoice=${inv.id} created=${inv.status} -> ${sent.status} payUrl=${sent.payUrl ? "present" : "none"}`;
  });

  await step("Disputes v1 list by capture", async () => {
    const list = await pp.listDisputes([...new Set([captureA, captureB])]);
    return `${list.length} dispute(s) on these captures${list.length ? `: ${list.map((d) => `${d.id} ${d.status}`).join(", ")}` : " (empty list handled; the app falls back to a labeled rehearsal dispute)"}`;
  });

  console.log(failed ? `\n${failed} step(s) failed.` : "\nAll approval-free PayPal calls the app makes work in sandbox.");
  process.exit(failed ? 1 : 0);
}

void main();
