/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#0d0b14',
          deep: '#06050a',
        },
        surface: {
          DEFAULT: '#17141f',
          2: '#1f1a2b',
        },
        cream: {
          DEFAULT: '#f0ead2',
          muted: '#a39893',
        },
        edge: '#2d2738',
        fast: '#ffb86b',
        slow: '#b083ff',
        coral: '#ff6b8a',
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
