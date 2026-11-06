// LLM access behind one tiny interface so the provider is an env var.
// The model drafts and explains; it never decides an amount or a verdict.
import Anthropic from "@anthropic-ai/sdk";

export interface LLM {
  readonly name: string; // shown in the UI, e.g. "Claude (claude-opus-5-5)"
  json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown>;
}

export class LLMError extends Error {}

function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LLMError("model returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

class AnthropicLLM implements LLM {
  readonly name: string;
  private client: Anthropic;
  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
    this.name = `Claude (${model})`;
  }
  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    if (res.stop_reason === "refusal") throw new LLMError("model declined the request");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return firstJson(text);
  }
}

class DeepSeekLLM implements LLM {
  readonly name: string;
  constructor(private readonly apiKey: string, private readonly model: string) {
    this.name = `DeepSeek (${model})`;
  }
  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\nReturn one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new LLMError(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return firstJson(j.choices?.[0]?.message?.content ?? "");
  }
}

/**
 * Caps model calls per UTC day so a public demo can't run up the key's bill.
 * Past the cap, calls fail with a clear message and every task falls back to
 * its offline twin, which the UI labels.
 */
class BudgetedLLM implements LLM {
  private day = "";
  private used = 0;
  constructor(private readonly inner: LLM, private readonly perDay: number) {}
  get name() {
    return this.inner.name;
  }
  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
    if (this.used >= this.perDay) throw new LLMError(`today's AI call budget (${this.perDay}) is used up`);
    this.used++;
    return this.inner.json(system, user, schema);
  }
}

/** null = offline mode (rule-based drafting, template wording). */
export function llmFromEnv(env: NodeJS.ProcessEnv): LLM | null {
  const p = (env.LLM_PROVIDER ?? "").toLowerCase();
  const perDay = Number(env.LLM_DAILY_CALLS || 1500);
  if (p === "none") return null;
  if ((p === "anthropic" || !p) && env.ANTHROPIC_API_KEY) return new BudgetedLLM(new AnthropicLLM(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-opus-5-5"), perDay);
  if ((p === "deepseek" || !p) && env.DEEPSEEK_API_KEY) return new BudgetedLLM(new DeepSeekLLM(env.DEEPSEEK_API_KEY, env.DEEPSEEK_MODEL || "deepseek-chat"), perDay);
  return null;
}
