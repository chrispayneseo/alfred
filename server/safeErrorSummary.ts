/** Never pass third-party Error objects to console: nested request configs can contain credentials. */
export function safeErrorSummary(error: unknown): { type: string; status?: number } {
  if (!(error instanceof Error)) return { type: typeof error };
  const status = (error as Error & { status?: unknown }).status;
  return {
    type: error.name || "Error",
    ...(typeof status === "number" ? { status } : {}),
  };
}
