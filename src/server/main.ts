// HTTP entry point: static UI, JSON API, and the simulated PayPal approval page
// (used only when no sandbox keys are configured).
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "../app/commerce.js";
import { loadConfig } from "../app/config.js";
import { SessionStore, type Session } from "../app/session.js";
import { PayPalError } from "../paypal/types.js";
import { routes } from "./routes.js";
import { approvalPage } from "./simApproval.js";
import { clientIp, RateLimiter } from "./limits.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = [join(here, "../../public"), join(here, "../../../public")];
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const cfg = loadConfig();
const store = new SessionStore(cfg);
const apiLimit = new RateLimiter(120, 60_000); // requests per IP per minute
const newSessionLimit = new RateLimiter(20, 3_600_000); // fresh sessions per IP per hour
const secure = cfg.publicBase.startsWith("https://") ? "; Secure" : "";
const cookie = (id: string) => `cs_sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=21600${secure}`;

class TooMany extends Error {}

function session(req: IncomingMessage, res: ServerResponse, ip: string): Session {
  const sid = /(?:^|;\s*)cs_sid=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  const existing = store.find(sid);
  if (existing) return existing;
  if (!newSessionLimit.allow(ip)) throw new TooMany("Too many new sessions from your address. Try again later.");
  const s = store.get(undefined);
  res.setHeader("Set-Cookie", cookie(s.id));
  return s;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== "POST") return {};
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new UserError("Request too large.");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new UserError("Body must be JSON.");
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function serveStatic(res: ServerResponse, path: string) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  for (const root of PUBLIC) {
    try {
      const file = await readFile(join(root, rel));
      res.writeHead(200, { "Content-Type": TYPES[extname(rel)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(file);
      return;
    } catch { /* try next root */ }
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  const ip = clientIp(req.headers, req.socket.remoteAddress);
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    // Static files never create a session (so crawlers can't evict visitors).
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/sim-paypal/")) return serveStatic(res, url.pathname);
    if (!apiLimit.allow(ip)) throw new TooMany("Too many requests. Wait a minute and try again.");
    const s = session(req, res, ip);
    if (url.pathname === "/api/reset" && req.method === "POST") {
      const fresh = store.reset(s.id);
      res.setHeader("Set-Cookie", cookie(fresh.id));
      return send(res, 200, { ok: true });
    }
    const sim = /^\/sim-paypal\/approve\/([\w-]+)$/.exec(url.pathname);
    if (sim && s.sim) {
      const orderId = sim[1]!;
      if (req.method === "POST") {
        const b = await body(req);
        if (b.choice !== "approve") return res.writeHead(302, { Location: "/?cancelled=1" }).end();
        const back = new URL(await s.serial(async () => s.sim!.approve(orderId)));
        back.searchParams.set("token", orderId);
        return res.writeHead(302, { Location: back.pathname + back.search }).end();
      }
      const order = await s.paypal.getOrder(orderId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(approvalPage(order.id, s));
    }
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (!m || method !== req.method) continue;
      const b = await body(req);
      // One request at a time per session, so two tabs can't both spend the same budget.
      const result = await s.serial(() => handler(s, b, m.slice(1), url.searchParams));
      if (result && typeof result === "object" && "redirect" in result) {
        return res.writeHead(302, { Location: String((result as { redirect: string }).redirect) }).end();
      }
      return send(res, 200, result);
    }
    return send(res, 404, { error: "Unknown endpoint." });
  } catch (err) {
    if (err instanceof TooMany) return send(res, 429, { error: err.message });
    // The PayPal return is a browser navigation: show errors in the app, not as raw JSON.
    if (url.pathname === "/api/paypal/return") {
      return res.writeHead(302, { Location: `/?error=${encodeURIComponent((err as Error).message.slice(0, 200))}#shop` }).end();
    }
    if (err instanceof UserError) return send(res, 400, { error: err.message });
    if (err instanceof PayPalError) return send(res, 502, { error: `PayPal ${err.status}: ${err.message}`, debugId: err.debugId });
    console.error(err);
    return send(res, 500, { error: `Unexpected error: ${(err as Error).message}` });
  }
});

server.listen(cfg.port, () => {
  console.log(`Countersign on ${cfg.publicBase}  | PayPal: ${cfg.sandbox ? "sandbox" : "simulated"} | AI: ${cfg.llm?.name ?? "offline rules"} | catalog: ${cfg.channel3 ? "Channel3 + demo" : "demo"}`);
});
