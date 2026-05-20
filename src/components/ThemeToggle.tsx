import { useEffect } from 'react'
import {
  resolveTheme,
  useThemeStore,
  type ThemeMode,
} from '../state/themeStore'

/**
 * Three-segment pill: light / system / dark. Also installs the effect
 * that pushes the resolved theme onto `<html data-theme="...">` and
 * subscribes to `prefers-color-scheme` while the mode is 'system'.
 */
export function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)

  useEffect(() => {
    const apply = (): void => {
      document.documentElement.dataset['theme'] = resolveTheme(mode)
    }
    apply()
    if (mode !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [mode])

  const options: Array<{ value: ThemeMode; label: string; icon: string }> = [
    { value: 'light', label: 'Light theme', icon: '☀' },
    { value: 'system', label: 'System theme', icon: '◐' },
    { value: 'dark', label: 'Dark theme', icon: '☾' },
  ]

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center rounded-full border border-edge/70 bg-ink-deep/40 p-0.5"
    >
      {options.map((o) => {
        const active = o.value === mode
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => setMode(o.value)}
            className={`h-6 w-6 rounded-full text-[12px] leading-none transition ${
              active
                ? 'bg-fast/20 text-fast'
                : 'text-cream-muted hover:text-cream'
            }`}
          >
            <span aria-hidden="true">{o.icon}</span>
          </button>
        )
      })}
    </div>
  )
}
