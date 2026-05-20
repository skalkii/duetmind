export function SiteHeader() {
  return (
    <header className="border-b border-edge/60">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5">
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
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted sm:inline">
          interaction model · v0.1
        </span>
      </div>
    </header>
  )
}
