import { loadEnv } from "vite";

export interface LlmEnv {
  anthropicApiKey: string;
  openaiApiKey: string;
  openaiModel: string;
}

const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";

export function loadLlmEnv(): LlmEnv {
  const env = loadEnv("development", process.cwd(), "");
  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    openaiApiKey: env.OPENAI_API_KEY ?? "",
    openaiModel: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  };
}
