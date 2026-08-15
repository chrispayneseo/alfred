import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn, CompletionResult } from "./types.js";

let client: Anthropic | undefined;

export function getAnthropicClient(apiKey: string): Anthropic {
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

const CHAT_SYSTEM_PROMPT =
  "You are Alfred, a calm and concise personal-assistant chat surface. Keep replies short and direct — a sentence or two for simple questions, more only when the question genuinely needs it. Do not include internal or system XML tags in your response.";

export async function claudeChat(apiKey: string, messages: ChatTurn[], extraContext?: string): Promise<CompletionResult> {
  const anthropic = getAnthropicClient(apiKey);
  const response = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system: extraContext ? `${CHAT_SYSTEM_PROMPT}\n\n${extraContext}` : CHAT_SYSTEM_PROMPT,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content");
  return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

/** Single-turn completion with a caller-supplied system prompt — no Alfred
 * chat persona baked in. Used for structured/classification-style tasks
 * (email action-item scanning) that still want Step 3's routing/fallback.
 * `model` defaults to Opus but callers doing cheap classification (rather
 * than generation quality-sensitive work) should pass a lighter model. */
export async function claudeComplete(
  apiKey: string,
  systemPrompt: string,
  userText: string,
  maxTokens = 512,
  model = "claude-opus-5"
): Promise<CompletionResult> {
  const anthropic = getAnthropicClient(apiKey);
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    system: systemPrompt,
    messages: [{ role: "user", content: userText }],
  });

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content");
  return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}

/** Same shape as claudeComplete, plus a single image alongside the text —
 * used for the calendar-photo extraction pipeline. Claude's vision input
 * takes the image as its own content block ahead of the text instruction. */
export async function claudeVisionComplete(
  apiKey: string,
  systemPrompt: string,
  userText: string,
  imageBase64: string,
  imageMediaType: "image/jpeg" | "image/png" | "image/webp",
  maxTokens = 1024,
  model = "claude-opus-5"
): Promise<CompletionResult> {
  const anthropic = getAnthropicClient(apiKey);
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content");
  return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
}
