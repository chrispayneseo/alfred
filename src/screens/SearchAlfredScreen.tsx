import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { searchAlfred, type PersonalSearchResponse } from "../integrations/local/personalAgent";
import { CONTENT_MAX_WIDTH, CONTENT_PADDING_X } from "../lib/layout";

export function SearchAlfredScreen() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<PersonalSearchResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    const clean = query.trim();
    if (!clean || loading) return;
    setLoading(true);
    try {
      setResult(await searchAlfred(clean));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={`mx-auto ${CONTENT_MAX_WIDTH} ${CONTENT_PADDING_X} pb-28 pt-[max(2rem,env(safe-area-inset-top))]`}>
      <h1 className="text-xl font-medium tracking-tight text-ink dark:text-ink-dark">Search Alfred</h1>
      <p className="mt-1 text-sm text-ink-soft dark:text-ink-soft-dark">Search the personal information Alfred keeps locally on your Dell.</p>

      <form onSubmit={handleSearch} className="mt-6 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What are you looking for?"
          aria-label="Search Alfred"
          className="min-w-0 flex-1 rounded-2xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-ink-soft dark:border-line-dark dark:bg-paper-dark dark:text-ink-dark"
        />
        <button type="submit" disabled={loading || !query.trim()} className="rounded-2xl bg-ink px-4 py-3 text-sm text-paper disabled:opacity-40 dark:bg-ink-dark dark:text-paper-dark">
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      <p className="mt-2 text-[11px] text-ink-faint dark:text-ink-faint-dark">Local-first. For Gmail, Calendar or wider connected questions, use Ask Alfred so Core can choose the permitted source.</p>

      {error && <p role="alert" className="mt-5 rounded-2xl border border-line px-4 py-3 text-sm text-claude dark:border-line-dark">{error}</p>}

      {result && (
        <section className="mt-7">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">Results</h2>
            <span className="text-xs text-ink-faint dark:text-ink-faint-dark">{result.count}</span>
          </div>
          {result.results.length === 0 ? (
            <p className="rounded-2xl border border-line px-4 py-4 text-sm text-ink-faint dark:border-line-dark dark:text-ink-faint-dark">Nothing matching that was found locally.</p>
          ) : (
            <ul className="space-y-2">
              {result.results.map((item) => {
                const safeUrl = typeof item.url === "string" && (/^\/settings\?memory=\d+$/.test(item.url) || /^\/today\?localItem=[a-zA-Z0-9_%.-]+$/.test(item.url));
                const body = (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium text-ink dark:text-ink-dark">{item.title}</p>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">{item.kind}</span>
                    </div>
                    {item.snippet && <p className="mt-1 text-xs text-ink-soft dark:text-ink-soft-dark">{item.snippet}</p>}
                    {item.due && <p className="mt-1 text-[11px] text-ink-faint dark:text-ink-faint-dark">Due {item.due}</p>}
                  </>
                );
                return (
                  <li key={item.id} className="rounded-2xl border border-line bg-paper-raised px-4 py-3 dark:border-line-dark dark:bg-paper-raised-dark">
                    {safeUrl ? <Link to={item.url!} className="block">{body}</Link> : body}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
