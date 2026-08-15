export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
