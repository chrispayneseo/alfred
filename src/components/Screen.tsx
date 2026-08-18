import type { ReactNode } from "react";
import { CONTENT_MAX_WIDTH, CONTENT_PADDING_X } from "../lib/layout";

interface ScreenProps {
  title: string;
  subtitle?: string;
  headerAction?: ReactNode;
  children: ReactNode;
}

export function Screen({ title, subtitle, headerAction, children }: ScreenProps) {
  return (
    <div className={`mx-auto flex min-h-dvh ${CONTENT_MAX_WIDTH} flex-col ${CONTENT_PADDING_X} pb-28 pt-[max(2rem,env(safe-area-inset-top))] lg:pb-24`}>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-ink dark:text-ink-dark">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-soft dark:text-ink-soft-dark">{subtitle}</p>}
        </div>
        {headerAction}
      </header>
      {children}
    </div>
  );
}
