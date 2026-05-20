import { useConversationStore } from '../state/conversationStore'

export function ConversationView() {
  const messages = useConversationStore((s) => s.messages)
  const slowReplyText = useConversationStore((s) => s.slowReplyText)
  const replyInFlight = useConversationStore((s) => s.replyInFlight)

  const hasContent = messages.length > 0 || (replyInFlight && slowReplyText)

  if (!hasContent) {
    return (
      <section className="w-full max-w-lg" aria-label="Conversation transcript">
        <p className="text-center text-xs italic text-cream-muted">
          Conversation will appear here once the session starts.
        </p>
      </section>
    )
  }

  return (
    <section
      className="flex w-full max-w-lg flex-col gap-3"
      aria-label="Conversation transcript"
    >
      <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream-muted">
        conversation
      </h2>
      <ol
        className="flex flex-col gap-3 px-1"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
      >
        {messages.map((m, i) => (
          <li
            key={`${m.ts}-${i}`}
            className={`max-w-[88%] rounded-2xl border px-3 py-2.5 text-sm leading-relaxed sm:max-w-[78%] sm:px-4 ${
              m.role === 'user'
                ? 'self-end border-fast/60 bg-fast/15 text-cream dark:border-fast/30 dark:bg-fast/10'
                : 'self-start border-slow/60 bg-slow/15 text-cream dark:border-slow/30 dark:bg-slow/10'
            }`}
          >
            <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-cream-muted">
              {m.role}
              {m.source ? ` · ${m.source}` : ''}
            </span>
            <span className="mt-1 block font-display text-base italic">
              {m.text}
            </span>
          </li>
        ))}
        {replyInFlight && slowReplyText && (
          <li className="max-w-[88%] self-start rounded-2xl border border-slow/60 bg-slow/15 px-3 py-2.5 text-sm leading-relaxed text-cream dark:border-slow/30 dark:bg-slow/10 sm:max-w-[78%] sm:px-4">
            <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-slow">
              assistant · streaming
            </span>
            <span className="mt-1 block font-display text-base italic">
              {slowReplyText}
              <span
                aria-hidden="true"
                className="ml-1 inline-block h-3 w-1.5 bg-slow align-middle motion-safe:animate-pulse"
              />
            </span>
          </li>
        )}
      </ol>
    </section>
  )
}
