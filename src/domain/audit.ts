// Append-only, hash-chained audit log: each entry commits to the one before,
// so a silently edited decision breaks the chain and `verify()` says where.
import { createHash } from "node:crypto";

export interface AuditEntry {
  seq: number;
  at: string;
  actor: "human" | "agent" | "gate" | "paypal" | "copilot" | "system";
  action: string;
  detail: Record<string, unknown>;
  prev: string;
  hash: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  append(actor: AuditEntry["actor"], action: string, detail: Record<string, unknown>, at: Date): AuditEntry {
    const prev = this.entries.at(-1)?.hash ?? "genesis";
    const seq = this.entries.length + 1;
    const body = { seq, at: at.toISOString(), actor, action, detail, prev };
    const entry = { ...body, hash: digest(body) };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  verify(): { ok: boolean; brokenAt: number | null } {
    let prev = "genesis";
    for (const e of this.entries) {
      const { hash, ...body } = e;
      if (e.prev !== prev || digest(body) !== hash) return { ok: false, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, brokenAt: null };
  }
}

function digest(body: unknown): string {
  return createHash("sha256").update(stable(body)).digest("hex").slice(0, 16);
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
