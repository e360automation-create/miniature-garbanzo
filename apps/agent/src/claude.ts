const API_URL = "https://api.anthropic.com/v1/messages";

export async function askClaude(prompt: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured; no request was sent.");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system: "You are an optional cloud helper for a local-first agent. Be concise. Do not claim to have run local tools or performed actions you have not performed.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${detail.slice(0, 500)}`);
  }
  const payload = await response.json() as { content?: Array<{ type: string; text?: string }> };
  return (payload.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}
