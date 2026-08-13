import type { ReactNode } from "react";

interface ScreenProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function Screen({ title, subtitle, children }: ScreenProps) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-28 pt-[max(2rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <h1 className="text-xl font-medium tracking-tight text-ink dark:text-ink-dark">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-soft dark:text-ink-soft-dark">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}
