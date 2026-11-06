# Hosting and keeping the demo alive until 2026-12-21

Primary: Render free web service from `render.yaml`.

1. render.com, New > Blueprint, pick the GitHub repo. Render reads `render.yaml`.
2. Set environment variables in the dashboard: `PUBLIC_BASE_URL` (the onrender.com URL), `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_EMAIL`, `CHANNEL3_API_KEY`. Without them the demo still runs in offline mode.
3. In the PayPal app settings nothing else is needed: the return URL is sent per order.
4. GitHub repo, Settings > Secrets and variables > Actions > Variables: add `DEMO_URL` = the Render URL. The keepalive workflow then pings `/healthz` every 10 minutes so judges don't wait for a cold start.

What has to stay valid until winners are announced (2026-12-21, organizer instruction): the Render service, the PayPal sandbox app and its accounts, the Anthropic key and its credit, the Channel3 key. The repository must not be edited after the deadline (2026-11-12 12:00 PST = 2026-11-13 05:00 KST); the keepalive workflow doesn't touch the repo.

Free-plan limits (sleep on idle, monthly instance hours) are Render's and can change; check them on the Render pricing page when deploying. Fallback if Render is unavailable: any Node 20 host that runs `npm ci && npm run build && npm start` with `PORT` set.

Cost guard for the AI key: each policy draft, product pick and dispute note is one short model call with `effort: low`; notes are cached per case. To stop spending, set `LLM_PROVIDER=none` and the demo keeps working with rules and templates.
