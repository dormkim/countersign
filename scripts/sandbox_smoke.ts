// One-command check of the PayPal sandbox keys, through the same adapter the app uses.
//
//   npm run smoke:sandbox               token + AUTHORIZE order, prints the approval link
//   npm run smoke:sandbox -- <orderId>  after approving: authorize, two partial captures
//                                       (final_capture=false), then void the rest
//
// Reads .env if present (or the shell environment). Never prints the client id,
// secret or access token; only PayPal object ids, statuses and debug_ids.
import { existsSync } from "node:fs";
import { money, formatMoney } from "../src/domain/money.js";
import { SandboxPayPal } from "../src/paypal/rest.js";
import { PayPalError } from "../src/paypal/types.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const id = process.env.PAYPAL_CLIENT_ID?.trim();
const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
if (!id || !secret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set (put them in .env). Nothing was called.");
  process.exit(2);
}

const pp = new SandboxPayPal(id, secret, process.env.PAYPAL_MERCHANT_EMAIL ?? "");
const tag = Date.now().toString(36);
const say = (step: string, detail = "") => console.log(`OK   ${step}${detail ? `  ${detail}` : ""}`);

async function createAndShowLink() {
  await pp.checkAuth();
  say("OAuth token", "(client credentials accepted; token not shown)");
  const order = await pp.createOrder({
    intent: "AUTHORIZE", amount: money("5.00", "USD"), description: "Countersign sandbox smoke test",
    invoiceId: `CS-SMOKE-${tag}`, returnUrl: "https://example.com/countersign-smoke/return", cancelUrl: "https://example.com/countersign-smoke/cancel",
    requestId: `smoke-order-${tag}`,
  });
  say("AUTHORIZE order created", `id=${order.id} status=${order.status}`);
  console.log(`\nApprove it with your sandbox PERSONAL (buyer) account:\n  ${order.approveUrl ?? "(no approve link in the response)"}`);
  console.log(`\nPayPal then redirects to example.com (expected). Next:\n  npm run smoke:sandbox -- ${order.id}`);
}

async function authorizeAndCapture(orderId: string) {
  const before = await pp.getOrder(orderId);
  say("order read", `id=${before.id} status=${before.status}`);
  if (before.status !== "APPROVED") {
    console.error(`Order is ${before.status}, not APPROVED. Open the approval link first.`);
    process.exit(1);
  }
  const auth = await pp.authorizeOrder(orderId, `smoke-auth-${orderId}`);
  say("authorized", `authorization=${auth.authorizationId} status=${auth.status} amount=${formatMoney(auth.amount)} expires=${auth.expiresAt ?? "?"}`);
  for (const n of [1, 2]) {
    const c = await pp.captureAuthorization(auth.authorizationId, money("1.00", "USD"), false, `CS-SMOKE-${tag}-c${n}`, `smoke-cap-${n}-${auth.authorizationId}`);
    say(`partial capture ${n} (final_capture=false)`, `capture=${c.captureId} status=${c.status} amount=${formatMoney(c.amount)}`);
  }
  await pp.voidAuthorization(auth.authorizationId);
  say("remaining authorization voided", "($3.00 released)");
  console.log("\nSandbox keys work for the budget flow: authorize, multiple partial captures, void.");
}

const arg = process.argv[2];
(arg ? authorizeAndCapture(arg) : createAndShowLink()).catch((err: unknown) => {
  if (err instanceof PayPalError) {
    console.error(`FAIL PayPal ${err.status} ${err.message}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`);
    if (err.status === 401) console.error("     Check that the keys are from the SANDBOX tab of developer.paypal.com, not Live.");
  } else console.error(`FAIL ${(err as Error).message}`);
  process.exit(1);
});
