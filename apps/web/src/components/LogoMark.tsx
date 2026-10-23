import { LogoMark as LabsLogoMark } from '@nearform/labs-ui-components/labs-header'

/**
 * The Nearform N_ monogram (DESIGN.md § Logo) — the art is `@nearform/labs-ui-components`' one
 * copy, shared with every Nearform Labs app; this wrapper keeps the app's sizing and colour. The
 * "N" takes `currentColor` (Midnight on light, White on dark, via `text-base-content`) and the
 * underscore bar is `--labs-accent`, which `index.css` maps to `--nf-green`. The product name is
 * rendered beside it as real text, so the mark is decorative. The same art is `public/logo.svg`
 * and `public/favicon.svg` (those switch the N's colour with a `prefers-color-scheme` media query
 * instead).
 */
export function LogoMark({ className = 'w-7 h-7' }: { className?: string }) {
  return <LabsLogoMark className={`flex-none text-base-content ${className}`} />
}
