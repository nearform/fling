/**
 * The mark before the product name: the instance's logo when its brand has one (`logoDarkUrl` in
 * the dark theme, falling back to `logoUrl`), otherwise Fling's generic mark — a throw arcing up
 * and away, drawn in the brand colours. The name is rendered beside it as real text, so the mark
 * is decorative either way.
 */
import { useInstance } from '../hooks/instance'
import { useDocumentTheme } from '../hooks/useDocumentTheme'
import { safeAssetUrl } from '../lib/instance'

export function LogoMark({ className = 'w-7 h-7' }: { className?: string }) {
  const brand = useInstance()?.brand
  const dark = useDocumentTheme() === 'fling-dark'
  const logo = safeAssetUrl((dark && brand?.logoDarkUrl) || brand?.logoUrl)
  if (logo) {
    return <img src={logo} alt="" className={`flex-none object-contain ${className}`} />
  }
  return <GenericMark className={className} />
}

/** Also the art of public/logo.svg and public/favicon.svg. */
export function GenericMark({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg className={`flex-none ${className}`} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path
        d="M8.5 23.5C11 15 15.5 10.5 23 9M17 7.8l6 1.2-1.6 5.9"
        fill="none"
        stroke="var(--primary-content)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
