import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarScanReview } from "../components/CalendarScanReview";
import { Screen } from "../components/Screen";
import { extractCalendarPhoto, type ExtractResult } from "../integrations/calendarPhoto/api";
import {
  fetchProjects,
  isMultiCaptureResult,
  submitCapture,
  submitMultiCapture,
  type ApiProject,
  type CaptureItem,
} from "../integrations/notion/api";
import { createRecipe, extractRecipeFromUrl, type MealType, type RecipeExtraction } from "../integrations/recipes/api";
import { compressImage } from "../lib/compressImage";
import { expectBackgrounding } from "../lib/lock";
import { clearPendingShare, readPendingShare } from "../lib/shareStore";
import { useVoiceRecorder } from "../lib/useVoiceRecorder";

type CaptureMode = "text" | "voice" | "scan-calendar" | "recipe";

const MEAL_TYPES: MealType[] = ["Breakfast", "Lunch", "Dinner", "Snack", "Baking"];

type RecipeReview = Omit<RecipeExtraction, "mealType"> & { mealType: MealType };

// If backgrounding for the camera causes the OS to reload the page (see
// lib/lock.ts's comment on expectBackgrounding), all component state —
// including which tab was selected — is wiped along with everything else.
// The photo itself can't be recovered either way (a File object can't
// survive that), but landing back on "Scan calendar" instead of the default
// "Text" tab at least means retaking it is one tap, not three.
const SCAN_MODE_PENDING_KEY = "alfred.capture.scanCalendarPending";

interface RecentCapture {
  id: string;
  text: string;
  kind: "task" | "note";
  project: string;
}

interface ReviewItem extends CaptureItem {
  id: string;
}

function CaptureReview({
  items,
  projects,
  onChange,
  onRemove,
  onFile,
  onCancel,
  filing,
  error,
}: {
  items: ReviewItem[];
  projects: ApiProject[];
  onChange: (id: string, patch: Partial<CaptureItem>) => void;
  onRemove: (id: string) => void;
  onFile: () => void;
  onCancel: () => void;
  filing: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
        Looks like a few things — review before filing:
      </p>

      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-2xl border border-line px-4 py-3 dark:border-line-dark">
            <div className="flex items-start gap-2">
              <input
                value={item.text}
                onChange={(e) => onChange(item.id, { text: e.target.value })}
                className="flex-1 rounded-lg border border-line bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark"
              />
              <button
                onClick={() => onRemove(item.id)}
                aria-label="Remove item"
                className="mt-1.5 shrink-0 text-ink-faint/60 hover:text-claude dark:text-ink-faint-dark/60"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <div className="flex gap-1 rounded-full border border-line p-0.5 dark:border-line-dark">
                {(["task", "note"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => onChange(item.id, { type })}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                      item.type === type
                        ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                        : "text-ink-soft dark:text-ink-soft-dark"
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>

              <select
                value={item.project}
                onChange={(e) => onChange(item.id, { project: e.target.value })}
                className="rounded-full border border-line bg-paper-raised px-2.5 py-1 text-[11px] text-ink-soft outline-none dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-soft-dark"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
                {!projects.some((p) => p.name === item.project) && <option value={item.project}>{item.project}</option>}
              </select>
            </div>

            {item.locationTrigger !== undefined && (
              <div className="mt-2 flex items-center gap-2">
                <span className="shrink-0 text-[11px] text-ink-faint dark:text-ink-faint-dark">When at</span>
                <input
                  value={item.locationTrigger}
                  onChange={(e) => onChange(item.id, { locationTrigger: e.target.value })}
                  placeholder="location"
                  className="flex-1 rounded-full border border-line bg-paper-raised px-2.5 py-1 text-[11px] text-ink-soft outline-none focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-soft-dark"
                />
              </div>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-sm text-ink-faint dark:text-ink-faint-dark">Nothing left — removed them all.</li>
        )}
      </ul>

      {error && <p className="text-xs text-claude">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={onFile}
          disabled={filing || items.length === 0}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
        >
          {filing ? "Filing…" : `File ${items.length || ""} item${items.length === 1 ? "" : "s"}`}
        </button>
        <button
          onClick={onCancel}
          disabled={filing}
          className="text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft disabled:opacity-50 dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
        >
          Cancel
        </button>
      </div>
    </div>
  );
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

  const [reviewItems, setReviewItems] = useState<ReviewItem[]>();
  const [reviewSource, setReviewSource] = useState<"manual" | "share-target">("manual");
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [filing, setFiling] = useState(false);
  const [reviewError, setReviewError] = useState<string>();

  const [mode, setMode] = useState<CaptureMode>(() => (sessionStorage.getItem(SCAN_MODE_PENDING_KEY) ? "scan-calendar" : "text"));
  const [extracting, setExtracting] = useState(false);
  const [scanResult, setScanResult] = useState<ExtractResult>();
  const [scanError, setScanError] = useState<string>();
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [recipeUrl, setRecipeUrl] = useState("");
  const [extractingRecipe, setExtractingRecipe] = useState(false);
  const [recipeExtractError, setRecipeExtractError] = useState<string>();
  const [recipeReview, setRecipeReview] = useState<RecipeReview>();
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [recipeSaved, setRecipeSaved] = useState(false);

  const handleTranscribed = useCallback((transcript: string) => {
    const trimmed = transcript.trim();
    if (!trimmed) return;
    setText((prev) => (prev.trim() ? `${prev.trim()}\n${trimmed}` : trimmed));
    inputRef.current?.focus();
  }, []);
  const voice = useVoiceRecorder(handleTranscribed);

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

      if (isMultiCaptureResult(result)) {
        setReviewItems(result.items.map((item, i) => ({ ...item, id: `${Date.now()}-${i}` })));
        setReviewSource(source);
        if (projects.length === 0) fetchProjects().then(setProjects).catch(() => undefined);
        return;
      }

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

  function handleReviewChange(id: string, patch: Partial<CaptureItem>) {
    setReviewItems((prev) => prev?.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function handleReviewRemove(id: string) {
    setReviewItems((prev) => prev?.filter((item) => item.id !== id));
  }

  function handleReviewCancel() {
    setReviewItems(undefined);
    setReviewError(undefined);
    inputRef.current?.focus();
  }

  async function handleReviewFile() {
    if (!reviewItems || reviewItems.length === 0) return;
    setFiling(true);
    setReviewError(undefined);
    try {
      const { results } = await submitMultiCapture(
        reviewItems.map(({ text: t, type, project, locationTrigger }) => ({ text: t, type, project, locationTrigger })),
        reviewSource
      );
      setRecent((prev) => [
        ...results.map((r) => ({ id: r.inbox.id, text: r.inbox.text, kind: r.filed.kind, project: r.filed.project })),
        ...prev,
      ]);
      setReviewItems(undefined);
      setText("");
      setSharedUrl(undefined);
      setSharedImage(undefined);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1200);
      inputRef.current?.focus();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Something went wrong filing those.");
    } finally {
      setFiling(false);
    }
  }

  function handleModeChange(next: CaptureMode) {
    sessionStorage.removeItem(SCAN_MODE_PENDING_KEY);
    setMode(next);
    setScanResult(undefined);
    setScanError(undefined);
    setRecipeUrl("");
    setRecipeExtractError(undefined);
    setRecipeReview(undefined);
  }

  async function handleExtractRecipe() {
    const url = recipeUrl.trim();
    if (!url) return;
    setExtractingRecipe(true);
    setRecipeExtractError(undefined);
    try {
      const result = await extractRecipeFromUrl(url);
      setRecipeReview({ ...result, mealType: result.mealType ?? "Dinner" });
    } catch (err) {
      setRecipeExtractError(err instanceof Error ? err.message : "Couldn't read that page.");
    } finally {
      setExtractingRecipe(false);
    }
  }

  async function handleSaveRecipe() {
    if (!recipeReview) return;
    setSavingRecipe(true);
    try {
      await createRecipe(recipeReview.title, recipeReview.mealType, {
        cuisineType: recipeReview.cuisineType,
        prepTime: recipeReview.prepTime,
        cookTime: recipeReview.cookTime,
        sourceUrl: recipeReview.sourceUrl,
        ingredients: recipeReview.ingredients,
        method: recipeReview.method,
        tags: recipeReview.tags,
      });
      setRecipeUrl("");
      setRecipeReview(undefined);
      setRecipeSaved(true);
      window.setTimeout(() => setRecipeSaved(false), 1200);
    } catch (err) {
      setRecipeExtractError(err instanceof Error ? err.message : "Couldn't save that recipe.");
    } finally {
      setSavingRecipe(false);
    }
  }

  async function handlePhotoSelected(event: React.ChangeEvent<HTMLInputElement>) {
    sessionStorage.removeItem(SCAN_MODE_PENDING_KEY);
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setExtracting(true);
    setScanError(undefined);
    try {
      const { base64, mimeType } = await compressImage(file);
      const result = await extractCalendarPhoto(base64, mimeType);
      setScanResult(result);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Couldn't read that photo.");
    } finally {
      setExtracting(false);
    }
  }

  function handleScanDone() {
    setScanResult(undefined);
    setMode("text");
  }

  return (
    <Screen title="Capture" subtitle="Jot it down — sort it out later">
      <div className="flex flex-col gap-3">
        {sharedImage && (
          <img src={sharedImage} alt="Shared attachment" className="max-h-40 rounded-xl border border-line object-cover dark:border-line-dark" />
        )}

        {reviewItems ? (
          <CaptureReview
            items={reviewItems}
            projects={projects}
            onChange={handleReviewChange}
            onRemove={handleReviewRemove}
            onFile={handleReviewFile}
            onCancel={handleReviewCancel}
            filing={filing}
            error={reviewError}
          />
        ) : scanResult ? (
          <CalendarScanReview result={scanResult} onDone={handleScanDone} onCancel={() => setScanResult(undefined)} />
        ) : (
          <>
            <div className="flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
              {(
                [
                  { value: "text", label: "Text" },
                  { value: "voice", label: "Voice" },
                  { value: "scan-calendar", label: "Scan calendar" },
                  { value: "recipe", label: "Recipe" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleModeChange(opt.value)}
                  className={`flex-1 rounded-full py-1.5 text-xs font-medium transition-colors ${
                    mode === opt.value
                      ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                      : "text-ink-soft dark:text-ink-soft-dark"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {mode === "scan-calendar" ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-line px-4 py-8 text-center dark:border-line-dark">
                <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
                  Take a photo of a handwritten wall calendar — Alfred will read it and let you review each entry
                  before anything's added to your calendar.
                </p>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handlePhotoSelected}
                />
                <button
                  type="button"
                  onClick={() => {
                    expectBackgrounding();
                    sessionStorage.setItem(SCAN_MODE_PENDING_KEY, "1");
                    photoInputRef.current?.click();
                  }}
                  disabled={extracting}
                  className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                >
                  {extracting ? "Reading photo…" : "Take or choose a photo"}
                </button>
                {scanError && <p className="text-xs text-claude">{scanError}</p>}
              </div>
            ) : mode === "recipe" ? (
              <div className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-6 dark:border-line-dark">
                {!recipeReview ? (
                  <>
                    <p className="text-sm text-ink-soft dark:text-ink-soft-dark">
                      Paste a link to a recipe — Alfred will read the page and pull out the recipe for your Recipe
                      Bank.
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={recipeUrl}
                        onChange={(e) => setRecipeUrl(e.target.value)}
                        placeholder="https://…"
                        className="min-w-0 flex-1 rounded-full border border-line bg-paper-raised px-4 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark dark:placeholder:text-ink-faint-dark"
                      />
                      <button
                        type="button"
                        onClick={handleExtractRecipe}
                        disabled={extractingRecipe || !recipeUrl.trim()}
                        className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                      >
                        {extractingRecipe ? "Reading…" : "Read recipe"}
                      </button>
                    </div>
                    {recipeExtractError && <p className="text-xs text-claude">{recipeExtractError}</p>}
                    {recipeSaved && <p className="text-xs text-ink-soft dark:text-ink-soft-dark">Saved to your Recipe Bank.</p>}
                  </>
                ) : (
                  <>
                    <input
                      value={recipeReview.title}
                      onChange={(e) => setRecipeReview({ ...recipeReview, title: e.target.value })}
                      className="w-full rounded-lg border border-line bg-paper-raised px-3 py-1.5 text-sm text-ink outline-none focus:border-ink-faint dark:border-line-dark dark:bg-paper-raised-dark dark:text-ink-dark dark:focus:border-ink-faint-dark"
                    />
                    <div className="flex gap-1 rounded-full border border-line p-1 dark:border-line-dark">
                      {MEAL_TYPES.map((mt) => (
                        <button
                          key={mt}
                          onClick={() => setRecipeReview({ ...recipeReview, mealType: mt })}
                          className={`flex-1 rounded-full py-1 text-xs font-medium transition-colors ${
                            recipeReview.mealType === mt
                              ? "bg-ink text-paper dark:bg-ink-dark dark:text-paper-dark"
                              : "text-ink-soft dark:text-ink-soft-dark"
                          }`}
                        >
                          {mt}
                        </button>
                      ))}
                    </div>
                    <p className="rounded-lg bg-paper-raised px-3 py-2 text-xs text-ink-soft dark:bg-paper-raised-dark dark:text-ink-soft-dark">
                      {recipeReview.ingredients.length} ingredients — {recipeReview.method.slice(0, 180)}…
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleSaveRecipe}
                        disabled={savingRecipe || !recipeReview.title.trim()}
                        className="flex-1 rounded-full bg-ink py-1.5 text-xs font-medium text-paper transition-colors disabled:opacity-50 dark:bg-ink-dark dark:text-paper-dark"
                      >
                        {savingRecipe ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => setRecipeReview(undefined)}
                        className="flex-1 rounded-full border border-line py-1.5 text-xs font-medium text-ink-soft dark:border-line-dark dark:text-ink-soft-dark"
                      >
                        Cancel
                      </button>
                    </div>
                    {recipeExtractError && <p className="text-xs text-claude">{recipeExtractError}</p>}
                  </>
                )}
              </div>
            ) : (
              <>
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
                  {mode === "voice" && (
                    <button
                      type="button"
                      onClick={voice.state === "recording" ? voice.stop : voice.start}
                      disabled={voice.state === "transcribing" || voice.state === "unsupported"}
                      aria-label={
                        voice.state === "recording"
                          ? "Stop recording"
                          : voice.state === "transcribing"
                            ? "Transcribing…"
                            : "Start voice capture"
                      }
                      title={voice.state === "unsupported" ? "Voice capture isn't supported in this browser" : undefined}
                      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50 ${
                        voice.state === "recording"
                          ? "border-claude bg-claude/10 text-claude"
                          : "border-line text-ink-faint hover:border-ink hover:text-ink dark:border-line-dark dark:text-ink-faint-dark dark:hover:border-ink-dark dark:hover:text-ink-dark"
                      }`}
                    >
                      {voice.state === "recording" && (
                        <span className="absolute inset-0 animate-ping rounded-full bg-claude/30" aria-hidden="true" />
                      )}
                      {voice.state === "transcribing" ? (
                        <svg viewBox="0 0 24 24" width="18" height="18" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="18" height="18" className="relative" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v3" strokeLinecap="round" />
                        </svg>
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!text.trim() || isSaving}
                    className="ml-auto rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-opacity disabled:opacity-30 dark:bg-ink-dark dark:text-paper-dark"
                  >
                    {isSaving ? "Saving…" : justSaved ? "Saved" : "Save"}
                  </button>
                </div>

                {voice.state === "recording" && (
                  <p className="text-xs text-claude">Recording… tap the mic again to stop.</p>
                )}
                {voice.state === "transcribing" && (
                  <p className="text-xs text-ink-faint dark:text-ink-faint-dark">Transcribing…</p>
                )}
                {voice.error && <p className="text-xs text-claude">{voice.error}</p>}

                {error && <p className="text-xs text-claude">{error}</p>}
              </>
            )}
          </>
        )}

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
