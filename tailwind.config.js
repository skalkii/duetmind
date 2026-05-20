/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        'ink-deep': 'rgb(var(--color-ink-deep) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--color-surface-2) / <alpha-value>)',
        cream: 'rgb(var(--color-cream) / <alpha-value>)',
        'cream-muted': 'rgb(var(--color-cream-muted) / <alpha-value>)',
        edge: 'rgb(var(--color-edge) / <alpha-value>)',
        fast: 'rgb(var(--color-fast) / <alpha-value>)',
        slow: 'rgb(var(--color-slow) / <alpha-value>)',
        coral: 'rgb(var(--color-coral) / <alpha-value>)',
      },
      fontFamily: {
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        sans: ['Geist', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
