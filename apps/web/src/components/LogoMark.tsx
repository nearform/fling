/**
 * The mark before the product name: the instance's logo when its brand has one (`logoDarkUrl` in
 * the dark theme, falling back to `logoUrl`), otherwise Fling's generic mark — an italic block F
 * filled with a rainbow, on a dark outline and offset shadow with a white rim for dark backgrounds. The name is rendered beside it as real text, so the mark
 * is decorative either way.
 */
import { useId } from 'react'
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

/** The F, sheared 13°: shared by every layer below. */
const F =
  '11.15,4.5 29.15,4.5 27.77,10.5 16.27,10.5 15.46,14 23.46,14 22.19,19.5 14.19,19.5 12.35,27.5 5.85,27.5'
const OUTLINE = '#1c1c3a'
const RAINBOW = ['#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2']

/** Also the art of public/logo.svg, public/favicon.svg, 404.html's icon and the .mcpb icon. */
export function GenericMark({ className = 'w-7 h-7' }: { className?: string }) {
  // One gradient per mark: ids are document-wide and a page can show several marks.
  const rainbow = `fling-rainbow-${useId()}`
  return (
    <svg className={`flex-none ${className}`} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={rainbow} x1="0" y1="0" x2=".35" y2="1">
          {RAINBOW.map((color, i) => (
            <stop key={color} offset={i / (RAINBOW.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
      </defs>
      <g strokeLinejoin="round">
        <polygon
          points={F}
          transform="translate(1.5 1.5)"
          fill={OUTLINE}
          stroke="#fff"
          strokeWidth="3.2"
        />
        <polygon points={F} fill="#fff" stroke="#fff" strokeWidth="3.2" />
        <polygon
          points={F}
          transform="translate(1.5 1.5)"
          fill={OUTLINE}
          stroke={OUTLINE}
          strokeWidth="1.6"
        />
        <polygon points={F} fill={`url(#${rainbow})`} stroke={OUTLINE} strokeWidth="1.6" />
      </g>
    </svg>
  )
}
