// Minimal DeepSeek client for strategic decisions the heuristic defers on. Uses deepseek-chat
// (fast) with a strict JSON contract so the caller can act on the reply deterministically.
const KEY = process.env.DEEPSEEK_API_KEY;
const URL = "https://api.deepseek.com/chat/completions";

/**
 * Ask DeepSeek to pick from a small set of options. `options` is an array of {id, desc}.
 * Returns the chosen id (or the first option on any failure — the heuristic already filtered
 * to only reasonable choices, so a fallback is always safe).
 */
export async function chooseOption(context, options, { model = "deepseek-chat", timeoutMs = 8000 } = {}) {
  if (!KEY || !options.length) return options[0]?.id ?? null;
  if (options.length === 1) return options[0].id;
  const sys = "You are a Settlers of Catan strategy engine. Reply ONLY with a JSON object " +
    '{"id": <the chosen option id>, "why": "<=8 words}. No prose, no markdown.';
  const user = `Situation:\n${context}\n\nOptions:\n${options.map((o) => `- id ${o.id}: ${o.desc}`).join("\n")}\n\nPick the best id to maximize victory points.`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(URL, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY }, body: JSON.stringify({ model, temperature: 0, max_tokens: 60, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }) });
    clearTimeout(t);
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { const o = JSON.parse(m[0]); if (options.some((x) => String(x.id) === String(o.id))) return o.id; }
  } catch {}
  return options[0].id;
}

export const deepseekAvailable = () => !!KEY;
