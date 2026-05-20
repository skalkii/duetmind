import { MicButton } from './components/MicButton'
import { SpeakBox } from './components/SpeakBox'
import { TranscriptView } from './components/TranscriptView'

export default function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-8 px-6 py-12 text-center">
      <header className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-semibold tracking-tight text-white">
          DuetMind
        </h1>
        <p className="max-w-md text-sm text-zinc-400">
          Browser-native interaction model. Two brains, one tick loop.
        </p>
      </header>

      <MicButton />
      <TranscriptView />
      <SpeakBox />

      <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">
        T1.3 TTS + barge-in
      </span>
    </main>
  )
}
