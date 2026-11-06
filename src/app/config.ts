// Reads the environment once. Secrets stay here and are never echoed: the UI
// only learns which mode is active.
import { Channel3Catalog } from "../catalog/channel3.js";
import { DemoCatalog } from "../catalog/demoCatalog.js";
import { llmFromEnv, type LLM } from "../llm/provider.js";
import { SandboxPayPal } from "../paypal/rest.js";

export interface Config {
  port: number;
  publicBase: string;
  llm: LLM | null;
  demo: DemoCatalog;
  channel3: Channel3Catalog | null;
  sandbox: SandboxPayPal | null; // shared; null = each session gets a simulator
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT || 3000);
  const sandbox = env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
    ? new SandboxPayPal(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_MERCHANT_EMAIL ?? "")
    : null;
  return {
    port,
    publicBase: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ""),
    llm: llmFromEnv(env),
    demo: new DemoCatalog(),
    channel3: env.CHANNEL3_API_KEY ? new Channel3Catalog(env.CHANNEL3_API_KEY) : null,
    sandbox,
  };
}
