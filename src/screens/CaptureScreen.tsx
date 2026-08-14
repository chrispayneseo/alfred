import { useEffect, useRef, useState } from "react";
import { Screen } from "../components/Screen";
import { submitCapture } from "../integrations/notion/api";
import { clearPendingShare, readPendingShare } from "../lib/shareStore";

interface RecentCapture {
  id: string;
  text: string;
  kind: "task" | "note";
  project: string;
}

export function CaptureScreen() {
  const [text, setText] = useState("");
  const [sharedImage, setSharedImage] = useState<string | undefined>();
  const [sharedUrl, setSharedUrl] = useState<string | undefined>();
  const [recent, setRecent] = useState<RecentCapture[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    readPendingShare().then((share) => {
      if (!share) return;
      const parts = [share.title, share.text, share.url].filter(Boolean);
      setText(parts.join(" — "));
      setSharedUrl(share.url);
      setSharedImage(share.imageDataUrl);
      clearPendingShare();
    });
  }, []);

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    setError(undefined);
    try {
      const source = sharedUrl || sharedImage ? "share-target" : "manual";
      const result = await submitCapture(trimmed, source);
      setRecent((prev) => [
        { id: result.inbox.id, text: trimmed, kind: result.filed.kind, project: result.filed.project },
        ...prev,
      ]);
      setText("");
      setSharedUrl(undefined);
      setSharedImage(undefined);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1200);
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong saving that.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Screen title="Capture" subtitle="Jot it down — sort it out later">
      <div className="flex flex-col gap-3">
        {sharedImage && (
          <img src={sharedImage} alt="Shared attachment" className="max-h-40 rounded-xl border border-line object-cover dark:border-line-dark" />
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              handleSave();
            }
          }}
          placeholder="What's on your mind?"
          rows={5}
          className="w-full resize-none rounded-2xl border border-line bg-paper-raised px-4 py-3 text-base text-ink outline-none placeholder:text-ink-faint focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark dark:placeholder:text-ink-faint-dark"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            aria-disabled
            title="Voice capture — coming soon"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-ink-faint opacity-50 dark:border-line-dark dark:text-ink-faint-dark"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            disabled
            aria-disabled
            title="Attach image — coming soon"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-ink-faint opacity-50 dark:border-line-dark dark:text-ink-faint-dark"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="9" cy="10" r="1.5" />
              <path d="m4 17 5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={!text.trim() || isSaving}
            className="ml-auto rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
          >
            {isSaving ? "Saving…" : justSaved ? "Saved" : "Save"}
          </button>
        </div>

        {error && <p className="text-xs text-claude">{error}</p>}

        {recent.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
              Recent captures
            </h2>
            <ul className="space-y-3">
              {recent.slice(0, 8).map((item) => (
                <li key={item.id} className="text-sm text-ink dark:text-ink-dark">
                  {item.text}
                  <span className="ml-2 text-xs text-ink-faint dark:text-ink-faint-dark">
                    {item.kind === "task" ? "Task" : "Note"} · {item.project}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Screen>
  );
}
