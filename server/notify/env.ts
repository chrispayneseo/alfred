export interface NtfyEnv {
  topic: string;
}

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadNtfyEnv(source: Record<string, string | undefined>): NtfyEnv {
  return { topic: source.NTFY_TOPIC ?? "" };
}
