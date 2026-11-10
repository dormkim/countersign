# Demo video script (target 2:30, hard limit under 3:00)

Recorded cut: https://youtu.be/h_DrqlPfHJg (2:27 = 12-second opening card with the measured comparison + the 2:15 cut below, 1440x900, PayPal sandbox + Claude, demo catalog). Earlier upload without the card: https://youtu.be/n9pvC7xIf04. The voiceover below matches the 2:15 part.

Recording: hosted demo or `npm run dev`, browser at 1400 px wide, PayPal sandbox keys and an AI key set if available (header chips then read "Sandbox (live API)" and "Claude"). No music. AI voiceover is allowed by the organizers.

| Time | Screen | Voiceover |
|---|---|---|
| 0:00-0:15 | First screen, hero text | AI agents are about to start buying things for us. The hard part isn't finding the product. It's letting software spend your money without losing control, and getting your money back when a parcel never shows up. |
| 0:15-0:25 | Header chips | Countersign sits between your agent and PayPal. Everything you'll see runs live: the PayPal sandbox, and Claude for the language parts. |
| 0:25-0:50 | Section 1: type the Commuter rules, Draft, rule cards, Activate. Then the "Vague" preset to show questions | I say my rules in plain English. Claude drafts them, and code checks every amount against what I actually typed. If I'm vague, it asks instead of guessing. Nothing is live until I activate it. |
| 0:50-1:05 | Section 2: create $200 budget, PayPal approval page, back with authorization | I approve one PayPal budget for today. That's an order with intent AUTHORIZE. No money moves yet. |
| 1:05-1:35 | Section 3: run "noise-cancelling headphones", ALLOW card, budget meter drops; then "backup headphones under $70": Claude skips the only match and flags it; press "Buy this one" on that result, ASK card quoting the injected sentence, Reject; then the gift card, DENY | The agent shops. Every purchase goes through the gate, which is plain code: price re-checked against the listing, caps, category, seller score, returns. This one passes and is captured from the budget with final_capture false. Cheaper headphones? The only match hides instructions for AI agents, and Claude passes on it. But what if an agent took the bait? I send that listing to the gate myself. The gate doesn't obey the text: it quotes it and waits for me. I reject it, and nothing is charged. Gift cards are blocked outright. |
| 1:35-2:05 | Section 4: set carrier to "loses the parcel", press +7 days, Build claim: facts table with sources, deadline, Claude's draft | A week later the parcel is stuck. The copilot builds the case from the PayPal capture and the tracking record, shows where each fact came from, and drafts the claim. A guard rejects any number or ID the model didn't get from the evidence. I approve the exact text. |
| 2:05-2:30 | Section 5: merchant desk, deadline, recommendation "accept claim", approve, status RESOLVED, refund on the order | The merchant gets the same engine. Sandbox buyers can only open disputes by hand, so this run uses a labeled rehearsal dispute; the refund at the end is a real sandbox refund. It reads the dispute, matches it to the order, sees no delivery scan, and recommends a refund before the deadline. One approval and it's resolved. |
| 2:30-2:45 | Audit log, chain intact | Every draft, verdict, approval and PayPal call lands in a hash-chained audit log. |
| 2:45-2:55 | Hero again | Countersign: your agent shops, you hold the pen. |

Shots to avoid: loading screens, terminal output, any API key or `.env`. Keep PayPal screens short (the question about showing PayPal marks in videos had no organizer answer as of 2026-11-06).
