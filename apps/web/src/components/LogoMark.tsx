/**
 * The Nearform N_ monogram (same art as `public/logo.svg`). The "N" takes `currentColor`
 * (Midnight on light, White on dark, via `text-base-content`) and the underscore bar is Nearform
 * Green. The product name is rendered beside it as real text, so the mark is decorative.
 */
export function LogoMark({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg
      className={`flex-none text-base-content ${className}`}
      viewBox="60.17 60.17 111.65 86.48"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="m60.18,60.18h11.3l36.71,53.4v-53.4h12.17v75.36h-11.3l-36.71-53.4v53.4h-12.17V60.18Z"
      />
      <path fill="var(--nf-green)" d="m126.51,135.54h45.29v11.09h-45.29v-11.09Z" />
    </svg>
  )
}
