export interface LlmEnv {
  anthropicApiKey: string;
  openaiApiKey: string;
  openaiModel: string;
}

const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";

/** Takes a raw env source rather than loading one itself — see google/env.ts
 * for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadLlmEnv(source: Record<string, string | undefined>): LlmEnv {
  return {
    anthropicApiKey: source.ANTHROPIC_API_KEY ?? "",
    openaiApiKey: source.OPENAI_API_KEY ?? "",
    openaiModel: source.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  };
}
