import { ThemeToggle } from './ThemeToggle'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-edge/60 bg-ink/80 backdrop-blur supports-[backdrop-filter]:bg-ink/60">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-3 sm:px-6 sm:py-4">
        <a
          href="/"
          className="group flex items-center gap-3 text-cream no-underline"
          aria-label="DuetMind home"
        >
          <span
            aria-hidden="true"
            className="relative inline-flex h-6 w-9 items-center"
          >
            <span className="absolute left-0 h-5 w-5 rounded-full border border-fast/70" />
            <span className="absolute left-3 h-5 w-5 rounded-full border border-slow/70" />
          </span>
          <span className="font-display text-2xl italic leading-none tracking-tight">
            DuetMind
          </span>
        </a>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted sm:inline">
            interaction model · v0.1
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
