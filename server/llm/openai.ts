import OpenAI from "openai";
import type { ChatTurn } from "./types";

let client: OpenAI | undefined;

function getOpenAiClient(apiKey: string): OpenAI {
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

const CHAT_SYSTEM_PROMPT =
  "You are Alfred, a calm and concise personal-assistant chat surface. Keep replies short and direct — a sentence or two for simple questions, more only when the question genuinely needs it.";

export async function chatGptChat(apiKey: string, model: string, messages: ChatTurn[], extraContext?: string): Promise<string> {
  const openai = getOpenAiClient(apiKey);
  const systemContent = extraContext ? `${CHAT_SYSTEM_PROMPT}\n\n${extraContext}` : CHAT_SYSTEM_PROMPT;
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: 1024,
    messages: [{ role: "system", content: systemContent }, ...messages],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("ChatGPT returned no text content");
  return text;
}

/** Single-turn completion with a caller-supplied system prompt — no Alfred
 * chat persona baked in. Used for structured/classification-style tasks
 * (email action-item scanning) that still want Step 3's routing/fallback. */
export async function chatGptComplete(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string,
  maxTokens = 512
): Promise<string> {
  const openai = getOpenAiClient(apiKey);
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("ChatGPT returned no text content");
  return text;
}
