export function SiteFooter() {
  return (
    <footer className="border-t border-edge/60 bg-ink-deep/40">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6 text-xs text-cream-muted sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono uppercase tracking-[0.16em]">
          runs offline · no api keys · no telemetry
        </p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 font-mono">
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
