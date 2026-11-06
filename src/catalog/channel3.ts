// Channel3 product search (real products across retailers).
// POST /v1/search to discover; GET /v1/products/{id} (free) for the gate's
// fresh re-check of price and stock right before money moves.
// Channel3 has no seller-reputation fields, so trust signals stay empty and the
// gate treats those stores as "unknown" (it asks rather than inventing a score).
import { parseMoney } from "../domain/money.js";
import type { Catalog, Offer } from "./types.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = "https://api.trychannel3.com";

export class Channel3Catalog implements Catalog {
  readonly name = "channel3" as const;
  constructor(private readonly apiKey: string) {}

  private async req(path: string, init: RequestInit = {}): Promise<Json> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Channel3 ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Json;
  }

  async search(query: string, opts: { maxPrice?: number; limit?: number } = {}): Promise<Offer[]> {
    const body: Json = { query, limit: opts.limit ?? 6, filters: { availability: ["InStock"] } };
    if (opts.maxPrice) body.filters.price = { max_price: opts.maxPrice };
    const j = await this.req("/v1/search", { method: "POST", body: JSON.stringify(body) });
    return ((j.products ?? []) as Json[]).flatMap((p) => toOffers(p).slice(0, 1));
  }

  async get(id: string): Promise<Offer | null> {
    const [productId, domain] = id.split("~");
    if (!productId) return null;
    const p = await this.req(`/v1/products/${encodeURIComponent(productId)}`);
    return toOffers(p).find((o) => !domain || o.merchant.domain === domain) ?? null;
  }
}

export function toOffers(p: Json): Offer[] {
  const img = ((p.images ?? []) as Json[]).find((i) => i.is_main_image) ?? p.images?.[0];
  return ((p.offers ?? []) as Json[]).flatMap((o): Offer[] => {
    const parsed = parseMoney(Number(o.price?.price).toFixed(2), String(o.price?.currency ?? ""));
    if (!parsed.ok) return [];
    return [{
      id: `${p.id}~${o.domain}`,
      title: String(p.title ?? "Untitled"),
      description: String(p.description ?? "").slice(0, 800),
      brand: p.brands?.[0]?.name ?? null,
      category: p.category?.title ?? p.category?.slug ?? null,
      price: parsed.money,
      shipping: null, // not in the search schema: the gate asks
      availability: o.availability === "InStock" ? "InStock" : "OutOfStock",
      merchant: { name: String(o.domain), domain: String(o.domain), signals: {} },
      deliveryDays: null,
      returnDays: null,
      url: String(o.url ?? ""),
      image: img?.cleaned_url ?? img?.url ?? null,
      source: "channel3",
    }];
  });
}
