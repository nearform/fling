/**
 * The card every page OUTSIDE the shell renders in (login): brand header + theme toggle over
 * `main-gradient`, or over a full-screen `backdrop` (login's `ThreadBackground`).
 */
import type { ReactNode } from 'react'
import { LogoMark } from './LogoMark'
import ThemeToggle from './ThemeToggle'

interface AuthCardProps {
  children: ReactNode
  /** `max-w-md` (default) or wider for lists */
  width?: 'md' | 'lg'
  /** Rendered under the card */
  footer?: ReactNode
  /** A full-screen layer behind the card in place of `main-gradient` (login's `ThreadBackground`) */
  backdrop?: ReactNode
}

export function AuthCard({ children, width = 'md', footer, backdrop }: AuthCardProps) {
  return (
    <div
      className={`relative isolate min-h-screen flex flex-col items-center justify-center px-4 py-10 ${backdrop ? '' : 'main-gradient'}`}
    >
      {backdrop}
      <div className={`w-full ${width === 'lg' ? 'max-w-lg' : 'max-w-md'}`}>
        <div className="surface-panel !p-0 overflow-hidden">
          <div className="flex h-14 items-center justify-between px-6 border-b border-[color:var(--border-subtle)]">
            <span className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-sm font-semibold tracking-tight">Fling</span>
            </span>
            <ThemeToggle />
          </div>
          <div className="p-6 md:p-8">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-secondary">{footer}</div>}
      </div>
    </div>
  )
}
