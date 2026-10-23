/**
 * The 404: the animated thread full-screen, a big "404", a randomly chosen line and a way home.
 * One component in two places — the SPA's catch-all route (`homeHref` `/`) and the standalone
 * `404.html` the sites distribution serves on every site host (`homeHref` the app's absolute URL).
 * It deliberately uses a plain `<a>` and no router, so the standalone bundle stays small.
 */
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useThreadTone } from '../hooks/useDocumentTheme'
import { LogoMark } from './LogoMark'
import ThemeToggle from './ThemeToggle'
import { ThreadBackground } from './ThreadBackground'

export const NOT_FOUND_MESSAGES = [
  'This fling flew too far.',
  'Nothing landed here… yet.',
  'Flung into the void.',
  'Whoops — that throw missed the catch.',
  'This link has left the building.',
  'Wide of the mark. Way wide.',
  'The thread runs out here.',
] as const

export function pickMessage(random: () => number = Math.random): string {
  return NOT_FOUND_MESSAGES[Math.floor(random() * NOT_FOUND_MESSAGES.length)]
}

export function NotFound({ homeHref = '/' }: { homeHref?: string }) {
  const [message] = useState(pickMessage)
  const tone = useThreadTone()

  return (
    <div className="relative isolate min-h-screen flex flex-col">
      <ThreadBackground tone={tone} />
      <header className="flex items-center justify-between px-5 py-4">
        <a href={homeHref} className="flex items-center gap-2.5" aria-label="Fling home">
          <LogoMark />
          <span className="text-sm font-semibold tracking-tight">Fling</span>
        </a>
        <ThemeToggle />
      </header>
      <main className="flex-1 grid place-items-center px-6 pb-16 text-center">
        <div className="max-w-xl">
          <p
            className="font-medium leading-none tracking-tighter text-[clamp(6rem,22vw,12rem)]"
            aria-hidden="true"
          >
            404
          </p>
          <h1 className="mt-4 text-2xl md:text-3xl">{message}</h1>
          <p className="mt-3 text-secondary">
            There's nothing at this address. The site may have been archived or deleted, or the link
            was mistyped.
          </p>
          <a href={homeHref} className="btn btn-primary mt-8">
            <ArrowLeftIcon className="h-4 w-4" />
            Back to Fling home
          </a>
        </div>
      </main>
    </div>
  )
}
