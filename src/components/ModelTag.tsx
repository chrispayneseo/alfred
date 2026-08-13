import type { ModelSource } from "../types";

const labels: Record<ModelSource, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

export function ModelTag({ model }: { model: ModelSource }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide ${
        model === "claude" ? "text-claude" : "text-chatgpt"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
      {labels[model]}
    </span>
  );
}
