import OpenAI, { toFile } from "openai";
import type { ChatTurn } from "./types.js";

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

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

/** Transcribes a short voice-capture recording via Whisper. Used only for
 * the Capture screen's voice input — the returned text is shown to the user
 * to review/edit before it enters the normal capture pipeline, never filed
 * automatically. */
export async function transcribeAudio(apiKey: string, audio: Buffer, mimeType: string): Promise<string> {
  const openai = getOpenAiClient(apiKey);
  const file = await toFile(audio, `capture.${extensionForMimeType(mimeType)}`, { type: mimeType });
  const response = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
  return response.text;
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

/** Same shape as chatGptComplete, plus a single image alongside the text —
 * used for the calendar-photo extraction pipeline. */
export async function chatGptVisionComplete(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string,
  imageBase64: string,
  imageMediaType: "image/jpeg" | "image/png" | "image/webp",
  maxTokens = 1024
): Promise<string> {
  const openai = getOpenAiClient(apiKey);
  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:${imageMediaType};base64,${imageBase64}` } },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("ChatGPT returned no text content");
  return text;
}
