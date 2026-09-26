import { Link } from "react-router-dom";
import { SearchAlfredScreen } from "./SearchAlfredScreen";

export function LibraryScreen() {
  return <div>
    <div className="mx-auto max-w-[90rem] px-5 pt-[max(1rem,env(safe-area-inset-top))] lg:px-10">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-accent">Library</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link to="/search" className="rounded-full bg-ink px-3 py-1.5 text-xs text-paper dark:bg-ink-dark dark:text-paper-dark">Search everything</Link>
        <Link to="/browse" className="rounded-full border border-line px-3 py-1.5 text-xs dark:border-line-dark">Browse</Link>
        <Link to="/freelance" className="rounded-full border border-line px-3 py-1.5 text-xs dark:border-line-dark">Projects</Link>
        <Link to="/meal-plan" className="rounded-full border border-line px-3 py-1.5 text-xs dark:border-line-dark">Meals</Link>
      </div>
    </div>
    <SearchAlfredScreen />
  </div>;
}
