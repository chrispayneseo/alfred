import { useState, type ReactNode } from "react";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

export interface TileDef {
  id: string;
  title: ReactNode;
  content: ReactNode;
}

interface TodayTileGridProps {
  tiles: TileDef[];
  defaultLayout: Layout;
  /** localStorage key — bump this (e.g. -v2) if the tile set ever changes
   * shape enough that old saved layouts stop making sense. */
  storageKey: string;
}

const COLS = 4;
const ROW_HEIGHT = 90;
const MARGIN: readonly [number, number] = [16, 16];

/** Merges a saved layout with the current tile set: keeps saved
 * positions/sizes for tiles that still exist, drops entries for tiles that
 * no longer exist, and appends default positions for any new tile the
 * saved layout doesn't know about yet (e.g. after a future update adds a
 * widget) — so a stale save never hides a tile or crashes on a missing id. */
function reconcileLayout(saved: Layout, defaultLayout: Layout, tileIds: string[]): Layout {
  const savedIds = new Set(saved.map((item) => item.i));
  const kept = saved.filter((item) => tileIds.includes(item.i));
  const missing = defaultLayout.filter((item) => !savedIds.has(item.i));
  return [...kept, ...missing];
}

function loadLayout(storageKey: string, defaultLayout: Layout, tileIds: string[]): Layout {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultLayout;
    return reconcileLayout(JSON.parse(raw) as Layout, defaultLayout, tileIds);
  } catch {
    return defaultLayout;
  }
}

const GRIP_DOTS = [
  [6, 6],
  [12, 6],
  [18, 6],
  [6, 12],
  [12, 12],
  [18, 12],
] as const;

/** Desktop-only (see useIsDesktop in TodayScreen) Android-widget-style tile
 * board — drag a tile by its header to move it, drag its bottom-right
 * corner to resize, both persisted to localStorage per device (this app is
 * only ever used on this Mac + one phone, so there's no cross-device sync
 * to worry about). Mobile keeps the plain stacked section layout entirely
 * untouched — see TodayScreen. */
export function TodayTileGrid({ tiles, defaultLayout, storageKey }: TodayTileGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();
  const tileIds = tiles.map((t) => t.id);
  const [layout, setLayout] = useState<Layout>(() => loadLayout(storageKey, defaultLayout, tileIds));

  function handleLayoutChange(next: Layout) {
    setLayout(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  function resetLayout() {
    setLayout(defaultLayout);
    localStorage.removeItem(storageKey);
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-ink-faint dark:text-ink-faint-dark">
          Drag a tile's header to move it, its bottom-right corner to resize.
        </p>
        <button
          onClick={resetLayout}
          className="shrink-0 text-xs text-ink-faint underline decoration-ink-faint/40 underline-offset-2 hover:text-ink-soft dark:text-ink-faint-dark dark:hover:text-ink-soft-dark"
        >
          Reset layout
        </button>
      </div>
      <div ref={containerRef}>
        {mounted && (
          <GridLayout
            width={width}
            layout={layout}
            onLayoutChange={handleLayoutChange}
            gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: MARGIN, containerPadding: [0, 0], maxRows: Infinity }}
            dragConfig={{ handle: ".tile-drag-handle" }}
            resizeConfig={{ handles: ["se"] }}
          >
            {tiles.map((tile) => (
              <div
                key={tile.id}
                className="flex flex-col overflow-hidden rounded-xl border border-line bg-paper-raised/60 dark:border-line-dark dark:bg-paper-raised-dark/40"
              >
                <div className="tile-drag-handle flex shrink-0 cursor-grab items-center gap-2 border-b border-line px-4 py-2.5 active:cursor-grabbing dark:border-line-dark">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" className="shrink-0 text-ink-faint/50 dark:text-ink-faint-dark/50">
                    {GRIP_DOTS.map(([cx, cy]) => (
                      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.4" />
                    ))}
                  </svg>
                  <h2 className="truncate text-xs font-medium uppercase tracking-wide text-ink-faint dark:text-ink-faint-dark">
                    {tile.title}
                  </h2>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-4">{tile.content}</div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>
    </div>
  );
}
