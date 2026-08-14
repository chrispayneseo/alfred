export type ModelChoice = "claude" | "chatgpt";

// v1: keyword/heuristic routing — cheaper and more predictable than an
// LLM-based router to start. Coding/technical requests go to Claude;
// everything else (writing, summarizing, general Q&A) goes to ChatGPT.
const CODING_KEYWORDS = [
  "code",
  "coding",
  "debug",
  "bug",
  "function",
  "error",
  "exception",
  "stack trace",
  "compile",
  "syntax",
  "refactor",
  "regex",
  "algorithm",
  "endpoint",
  "api",
  "database",
  "sql",
  "json",
  "yaml",
  "script",
  "terminal",
  "bash",
  "shell",
  "git",
  "github",
  "docker",
  "kubernetes",
  "npm",
  "backend",
  "frontend",
  "framework",
  "library",
  "repository",
  "python",
  "javascript",
  "typescript",
  "java",
  "c++",
  "c#",
  "rust",
  "golang",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "html",
  "css",
  "react",
  "vue",
  "angular",
  "node.js",
  "nodejs",
];

export function routeToModel(text: string): ModelChoice {
  const lower = text.toLowerCase();
  return CODING_KEYWORDS.some((keyword) => lower.includes(keyword)) ? "claude" : "chatgpt";
}
