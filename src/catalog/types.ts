import type { Money } from "../domain/money.js";
import type { MerchantSignals } from "../domain/trust.js";

export interface Offer {
  id: string; // stable id the agent must cite
  title: string;
  description: string;
  brand: string | null;
  category: string | null; // raw category text from the source
  price: Money;
  shipping: Money | null; // null = unknown
  availability: "InStock" | "OutOfStock";
  merchant: { name: string; domain: string; signals: MerchantSignals };
  deliveryDays: number | null; // null = unknown
  returnDays: number | null; // null = unknown, 0 = final sale
  url: string;
  image: string | null;
  source: "demo" | "channel3";
}

export interface Catalog {
  readonly name: "demo" | "channel3";
  search(query: string, opts?: { maxPrice?: number; limit?: number }): Promise<Offer[]>;
  /** Fresh lookup used by the gate. The agent's own copy of a price is never trusted. */
  get(id: string): Promise<Offer | null>;
}
