import { loadEnv } from "vite";

export interface NtfyEnv {
  topic: string;
}

export function loadNtfyEnv(): NtfyEnv {
  const env = loadEnv("development", process.cwd(), "");
  return { topic: env.NTFY_TOPIC ?? "" };
}
