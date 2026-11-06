// One taxonomy for policies, the demo catalog and Channel3 results.
// A category the code cannot place is "unknown": the gate asks, it never guesses.

export const CATEGORIES = [
  "books", "electronics", "home", "kitchen", "office", "grocery", "apparel",
  "toys", "sports", "travel", "health", "pet", "gift_cards", "digital_goods",
  "crypto", "gambling", "alcohol", "tobacco", "weapons",
] as const;

export type Category = (typeof CATEGORIES)[number];

const SYNONYMS: Record<string, Category> = {
  book: "books", ebook: "books", novel: "books", notebook: "office",
  electronic: "electronics", gadget: "electronics", headphone: "electronics",
  headphones: "electronics", earbuds: "electronics", charger: "electronics",
  cable: "electronics", laptop: "electronics", phone: "electronics", audio: "electronics",
  furniture: "home", lamp: "home", bedding: "home", household: "home", cleaning: "home",
  cookware: "kitchen", coffee: "kitchen", mug: "kitchen", stationery: "office",
  pen: "office", paper: "office", desk: "office", food: "grocery", snack: "grocery",
  groceries: "grocery", clothing: "apparel", clothes: "apparel", shoes: "apparel",
  jacket: "apparel", toy: "toys", game: "toys", fitness: "sports", outdoor: "sports",
  camping: "sports", luggage: "travel", flight: "travel", hotel: "travel",
  vitamin: "health", supplement: "health", medicine: "health", pets: "pet", dog: "pet", cat: "pet",
  "gift card": "gift_cards", "gift cards": "gift_cards", giftcard: "gift_cards", voucher: "gift_cards",
  "digital good": "digital_goods", "digital goods": "digital_goods", subscription: "digital_goods",
  software: "digital_goods", "in-game": "digital_goods", bitcoin: "crypto", nft: "crypto",
  cryptocurrency: "crypto", casino: "gambling", betting: "gambling", lottery: "gambling",
  wine: "alcohol", beer: "alcohol", liquor: "alcohol", cigarette: "tobacco", vape: "tobacco",
  gun: "weapons", knife: "weapons",
};

export function normalizeCategory(raw: string | null | undefined): Category | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  const direct = CATEGORIES.find((c) => c === t.replace(/ /g, "_"));
  if (direct) return direct;
  if (SYNONYMS[t]) return SYNONYMS[t];
  const singular = t.replace(/s$/, "");
  if (SYNONYMS[singular]) return SYNONYMS[singular];
  return null;
}

/** Best-effort placement of free text (e.g. a Channel3 category path). */
export function categoryFromText(text: string): Category | null {
  const lower = text.toLowerCase();
  for (const c of CATEGORIES) if (lower.includes(c.replace("_", " "))) return c;
  for (const [word, c] of Object.entries(SYNONYMS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return c;
  }
  return null;
}

export const categoryLabel = (c: string): string => c.replace(/_/g, " ");
