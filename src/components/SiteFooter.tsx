export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-edge/60 bg-ink-deep/40">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-5 py-5 text-center text-[11px] text-cream-muted sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-6 sm:text-left sm:text-xs">
        <p className="font-mono uppercase tracking-[0.12em] sm:tracking-[0.16em]">
          runs offline · no api keys · no telemetry
        </p>
        <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 font-mono sm:justify-end sm:gap-x-5 sm:gap-y-2">
          <a
            href="https://thinkingmachines.ai/blog/interaction-models/"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-fast"
          >
            spec
          </a>
          <a
            href="https://huggingface.co/docs/transformers.js/"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-slow"
          >
            transformers.js
          </a>
          <a
            href="https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-cream"
          >
            SmolLM2-360M
          </a>
        </nav>
      </div>
    </footer>
  )
}
