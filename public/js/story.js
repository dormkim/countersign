import { $, act, api, caseCache, esc, st, toast, tz } from "./core.js";
import { POLICY_PRESETS } from "./rules.js";
import { GOALS, buyThis, runAgent } from "./shop.js";
import { fileClaim, loadCase, submitMerchant } from "./claims.js";

// The 30-second story: drives the real API end to end with narration.
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export function storyStep(step, say) {
  const items = [...$("story").querySelectorAll("li")];
  const idx = items.findIndex((li) => li.dataset.step === step);
  items.forEach((li, i) => { li.classList.toggle("done", i < idx); li.classList.toggle("now", i === idx); });
  $("story").querySelector(".say")?.remove();
  if (say) $("story").insertAdjacentHTML("beforeend", `<div class="say">${esc(say)}</div>`);
}
export const go = (id) => document.getElementById(id).scrollIntoView({ behavior: "smooth", block: "start" });

export async function waitFor(pred, ms = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    st.S = await api("/api/state");
    st.render();
    if (pred(st.S)) return true;
    await pause(2000);
  }
  return false;
}

export async function play() {
  $("play").disabled = true;
  try {
    await fetch("/api/reset", { method: "POST" });
    caseCache.clear();
    st.S = await api("/api/state");
    st.render();
    storyStep("rules", "You say how the agent may spend. The rules are drafted, validated and shown back before you activate them.");
    go("rules");
    $("policyText").value = POLICY_PRESETS["Commuter rules"];
    await act(() => api("/api/policy/draft", { text: $("policyText").value, tz }));
    await pause(1200);
    await act(() => api("/api/policy/activate", {}));

    storyStep("budget", "One PayPal approval covers today's $200 budget. Nothing is charged yet.");
    go("budget");
    const env = await act(() => api("/api/envelope", { amount: "200" }));
    if (st.S.modes.paypal === "simulated") {
      await fetch(`/sim-paypal/approve/${env.envelope.orderId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "choice=approve" });
    } else {
      window.open(env.envelope.approveUrl, "_blank", "noopener");
      storyStep("budget", "Approve the budget in the PayPal sandbox window. The story continues when PayPal confirms.");
      if (!(await waitFor((s) => s.envelope?.status === "active"))) throw new Error("PayPal approval did not arrive in 3 minutes.");
    }
    st.S = await api("/api/state");
    st.render();
    await pause(900);

    storyStep("buy", "The agent finds headphones. Every check passes, so it pays from the budget on its own.");
    go("shop");
    await runAgent(GOALS[0]);
    if (!st.S.orders.length) throw new Error("the agent's first pick wasn't paid automatically, so the story can't continue; see the card in section 3");
    await pause(1600);

    storyStep("trap", "A cheaper listing hides instructions aimed at AI agents. Even when you tell the agent to buy it, the gate quotes the text and waits for you. A gift card is blocked outright.");
    const trap = await runAgent(GOALS[1]);
    // A model picker usually skips the injected listing; send it to the gate by hand so the check is visible.
    if (trap?.run && !trap.run.intentId && trap.run.candidates.length) await buyThis(trap.run.candidates[0].id);
    await pause(1400);
    await runAgent(GOALS[2]);
    await pause(1600);

    storyStep("lost", "A week later the headphones still haven't arrived. Tracking stalled in transit.");
    go("orders");
    const first = st.S.orders.at(-1);
    await act(() => api(`/api/orders/${first.id}/ship-plan`, { plan: "stalled" }));
    await act(() => api("/api/clock/advance", { days: 6 }));
    await loadCase(first.id);
    await pause(2200);

    storyStep("dispute", "You approve the claim. On the merchant side the same engine sees no delivery scan and recommends a refund, which PayPal pays out.");
    let filed = await fileClaim(first.id);
    if (filed && !filed.filed && filed.rehearsalAvailable) {
      // Sandbox: no API opens a buyer dispute, so the story uses a labeled rehearsal dispute.
      storyStep("dispute", "Sandbox buyers open disputes by hand in PayPal's Resolution Center, so this run uses a labeled rehearsal dispute. The refund at the end is a real sandbox refund.");
      filed = await fileClaim(first.id, true);
    }
    if (filed?.filed) {
      go("merchant");
      await pause(1600);
      const v = st.merchant.cases.find((c) => c.dispute.id === filed.dispute.id);
      if (v && !v.case.blocked) await submitMerchant(v.dispute.id, v.case.action);
    }
    storyStep("done", "Rules you said, money you approved once, and a copilot that argued your case. Every step is in the audit log.");
    $("story").querySelectorAll("li").forEach((li) => { li.classList.add("done"); li.classList.remove("now"); });
  } catch (e) {
    toast(`Story stopped: ${e.message}`, true);
  } finally {
    $("play").disabled = false;
  }
}
