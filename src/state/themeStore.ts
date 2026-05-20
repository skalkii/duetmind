/**
 * Theme preference store with persistence.
 *
 * The user picks one of three modes:
 *   - 'light'   → force the light palette
 *   - 'dark'    → force the dark palette
 *   - 'system'  → follow `prefers-color-scheme`
 *
 * The applied theme (`resolved`) is computed from the mode + the current
 * system preference and pushed onto `<html data-theme="...">`, which the
 * CSS variable layer in `index.css` reads.
 *
 * Persisted via localStorage so reloads keep the user's choice.
 */

import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'duetmind:theme'

function readPersistedMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system'
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

function systemPrefersLight(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: light)').matches === true
  )
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemPrefersLight() ? 'light' : 'dark'
}

interface ThemeState {
  readonly mode: ThemeMode
  setMode(mode: ThemeMode): void
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readPersistedMode(),
  setMode(mode) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, mode)
    }
    set({ mode })
  },
}))
