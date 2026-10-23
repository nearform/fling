import { useEffect, useState } from 'react'
import type { Theme } from '../components/ThemeToggle'

function readTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'fling-dark'
    ? 'fling-dark'
    : 'fling-light'
}

/**
 * The theme in force, following `ThemeToggle`: the `data-theme` attribute on `<html>` IS the state,
 * so this watches the attribute rather than keeping a second copy of it.
 */
export function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** The ThreadBackground tone that matches the theme in force. */
export function useThreadTone(): 'dark' | 'light' {
  return useDocumentTheme() === 'fling-dark' ? 'dark' : 'light'
}
