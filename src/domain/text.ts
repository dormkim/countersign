// English count phrases for UI and log text: "1 dispute", "2 disputes", never "dispute(s)".
// public/js/core.js has the same helper for the browser (no build step shares code).
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
