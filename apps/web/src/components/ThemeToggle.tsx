import { MoonIcon, SunIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'

export const THEMES = ['fling-light', 'fling-dark'] as const
export type Theme = (typeof THEMES)[number]

function readStoredTheme(): string | null {
  try {
    return localStorage.getItem('theme')
  } catch {
    return null
  }
}

/**
 * Normalise whatever is stored to a valid theme so state never starts out of sync with the
 * DOM (an invalid stored value made the first click a visual no-op). Mirrors index.html.
 */
export function getInitialTheme(): Theme {
  const saved = readStoredTheme()
  if (saved === 'fling-dark' || saved === 'fling-light') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'fling-dark' : 'fling-light'
}

/** Light/dark switch. The `data-theme` attribute IS the state; localStorage remembers it. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // privacy mode — the attribute still carries the theme for this page
    }
  }, [theme])

  const isLight = theme === 'fling-light'

  return (
    <button
      type="button"
      onClick={() => setTheme(isLight ? 'fling-dark' : 'fling-light')}
      className="btn btn-ghost btn-sm btn-circle"
      title={`Switch to ${isLight ? 'dark' : 'light'} mode`}
      aria-label={`Switch to ${isLight ? 'dark' : 'light'} mode`}
    >
      {isLight ? <MoonIcon className="w-5 h-5" /> : <SunIcon className="w-5 h-5" />}
    </button>
  )
}
