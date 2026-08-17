export interface RecipeEmailEnv {
  resendApiKey: string;
  destinationEmail: string;
}

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadRecipeEmailEnv(source: Record<string, string | undefined>): RecipeEmailEnv {
  return {
    resendApiKey: source.RESEND_API_KEY ?? "",
    destinationEmail: source.RECIPE_EMAIL_TO ?? "",
  };
}
