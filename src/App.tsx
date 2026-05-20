import { useState } from 'react'
import { ConversationView } from './components/ConversationView'
import { DebugPanel } from './components/DebugPanel'
import { SessionPanel } from './components/SessionPanel'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import type { TickDecision } from './types/protocol'

export default function App() {
  const [lastDecision, setLastDecision] = useState<TickDecision | null>(null)
  const [lastBargeMs, setLastBargeMs] = useState<number | null>(null)

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-cream focus:outline focus:outline-2 focus:outline-fast"
      >
        Skip to content
      </a>
      <SiteHeader />

      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col items-center justify-start px-5 py-10 sm:px-6"
      >
        <div className="flex w-full max-w-xl flex-col items-center gap-8 text-center">
          <div className="space-y-3">
            <h1 className="font-display text-4xl italic leading-[1.05] tracking-tight text-cream sm:text-5xl">
              two brains,
              <br />
              one tick loop.
            </h1>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-cream-muted">
              A browser-native interaction model. The fast brain decides{' '}
              <span className="text-fast">when</span> to listen, nod, or
              interrupt; the slow brain decides{' '}
              <span className="text-slow">what</span> to say.
            </p>
          </div>

          <SessionPanel
            onDecision={setLastDecision}
            onBargeInLatency={setLastBargeMs}
          />

          <ConversationView />

          <DebugPanel lastDecision={lastDecision} lastBargeMs={lastBargeMs} />
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
