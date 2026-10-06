/**
 * The one place that calls Gemini over REST for generated copy (emails, social
 * posts). It used to be copied into each caller, and a fix applied to one copy —
 * retry on a demand spike — silently missed the other.
 *
 * Failure handling, in order:
 *  1. 429 and 5xx are demand spikes or quota, not mistakes in our request, so the
 *     same model is retried with backoff. Any other 4xx means the request itself
 *     is wrong and repeating it would only repeat the error.
 *  2. If the model stays unavailable and `GEMINI_FALLBACK_MODEL` is set, the next
 *     model is tried. Models have separate capacity and quotas, which is what
 *     makes this useful rather than a second identical attempt.
 */
const ATTEMPTS = 4;

export interface GeminiJsonOptions {
  /** Named in the error, so a failure says which feature it came from. */
  purpose: string;
  temperature: number;
  /** Overrides `GEMINI_MODEL` for this call (e.g. EMAIL_MODEL). */
  model?: string;
}

export async function geminiJson(prompt: string, opts: GeminiJsonOptions): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error(`GOOGLE_API_KEY not set — needed for ${opts.purpose}`);

  const primary = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  const fallback = process.env.GEMINI_FALLBACK_MODEL?.trim();
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];

  let lastError = "no attempt made";
  for (const model of models) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: opts.temperature, responseMimeType: "application/json" },
          }),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error(`Gemini returned no text for ${opts.purpose}`);
        return text;
      }

      lastError = `Gemini ${res.status} (${model}): ${(await res.text()).slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) throw new Error(lastError);
      if (attempt < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(lastError);
}
