/**
 * The Guide at `/guide/<part>/<page>`: a left nav of the pages this reader sees (by part, with a
 * search over every page's text), the page, and its sections on wide screens. Readable signed out,
 * so it has its own shell rather than the app's: the instance's mark and name, a way back into the
 * app (or to sign in), the theme toggle.
 */
import {
  GUIDE_PARTS,
  type GuidePage,
  guideHref,
  guidePageVisible,
  resolveGuideText,
} from '@fling/shared'
import { Bars3Icon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { LogoMark } from '../../components/LogoMark'
import ThemeToggle from '../../components/ThemeToggle'
import { GUIDE_PAGES } from '../../guide/content'
import { guideContextFor } from '../../guide/context'
import { renderGuideMarkdown } from '../../guide/render'
import { searchGuide } from '../../guide/search'
import { useInstance } from '../../hooks/instance'
import { useMe } from '../../hooks/queries'
import { copyText } from '../../lib/clipboard'
import { DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import '../../guide/guide.css'

/** Close the mobile drawer after choosing a page (the desktop nav is always open). */
function closeDrawer() {
  const toggle = document.getElementById('guide-drawer') as HTMLInputElement | null
  if (toggle) toggle.checked = false
}

function GuideNav({ pages, current }: { pages: readonly GuidePage[]; current?: string }) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => (query.trim() ? searchGuide(pages, query) : null), [pages, query])
  return (
    <nav aria-label="Guide" className="guide-nav">
      <input
        type="search"
        className="input input-sm w-full"
        placeholder="Search the guide"
        aria-label="Search the guide"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      {matches ? (
        <ul className="guide-nav-list" aria-live="polite">
          {matches.length === 0 && (
            <li className="text-muted text-sm px-2.5 py-1.5">No pages match.</li>
          )}
          {matches.map(page => (
            <li key={page.slug}>
              <NavLink
                to={guideHref(page.slug)}
                onClick={closeDrawer}
                className="nav-item block px-2.5 py-1.5"
                data-active={page.slug === current}
              >
                <span className="block">{page.meta.title}</span>
                <span className="block text-xs text-muted">{page.meta.summary}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      ) : (
        GUIDE_PARTS.map(part => {
          const inPart = pages.filter(p => p.meta.part === part.id)
          if (inPart.length === 0) return null
          return (
            <section key={part.id} aria-labelledby={`guide-part-${part.id}`}>
              <h2 id={`guide-part-${part.id}`} className="guide-nav-part">
                {part.label}
              </h2>
              <ul className="guide-nav-list">
                {inPart.map(page => (
                  <li key={page.slug}>
                    <NavLink
                      to={guideHref(page.slug)}
                      onClick={closeDrawer}
                      title={page.meta.summary}
                      className="nav-item block px-2.5 py-1"
                      data-active={page.slug === current}
                      aria-current={page.slug === current ? 'page' : undefined}
                    >
                      {page.meta.title}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </section>
          )
        })
      )}
    </nav>
  )
}

/** The page's HTML, with in-app navigation for guide links and a copy button on each code block. */
function GuideArticle({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // biome-ignore lint/correctness/useExhaustiveDependencies: new HTML means new code blocks to equip
  useEffect(() => {
    const root = ref.current
    if (!root) return
    for (const pre of root.querySelectorAll('pre')) {
      if (pre.querySelector('.guide-copy')) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'guide-copy btn btn-ghost btn-xs'
      button.textContent = 'Copy'
      button.addEventListener('click', async () => {
        try {
          await copyText(pre.querySelector('code')?.textContent?.replace(/\n$/, '') ?? '')
          button.textContent = 'Copied'
        } catch {
          button.textContent = 'Select and copy'
        }
        setTimeout(() => {
          button.textContent = 'Copy'
        }, 1500)
      })
      pre.append(button)
    }
  }, [html])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates clicks on the links inside, which are keyboard-reachable themselves
    // biome-ignore lint/a11y/noStaticElementInteractions: as above
    <div
      ref={ref}
      className="guide-prose"
      onClick={e => {
        const a = (e.target as HTMLElement).closest('a')
        const href = a?.getAttribute('href')
        if (!a || !href || a.target || e.metaKey || e.ctrlKey || e.shiftKey) return
        if (href.startsWith('/') && !href.startsWith('//')) {
          e.preventDefault()
          navigate(href)
        }
      }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the guide's pages are written in this repository
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default function Guide() {
  const params = useParams()
  const { hash } = useLocation()
  const instance = useInstance()
  const { data: me } = useMe()
  const ctx = useMemo(() => guideContextFor(instance, me, window.location.origin), [instance, me])
  const pages = GUIDE_PAGES.filter(p => guidePageVisible(p, ctx.reader))
  const slug = params['*']?.replace(/\/$/, '') || pages[0]?.slug
  const index = pages.findIndex(p => p.slug === slug)
  const page = pages[index]
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME

  const rendered = useMemo(
    () => (page ? renderGuideMarkdown(resolveGuideText(page.body, ctx).text) : null),
    [page, ctx]
  )

  useEffect(() => {
    document.title = `${page?.meta.title ?? 'Guide'} · ${name} guide`
  }, [page, name])

  // A new page starts at the top, or at the section its address names.
  useEffect(() => {
    if (!rendered) return
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [rendered, hash])

  const prev = index > 0 ? pages[index - 1] : undefined
  const next = index >= 0 ? pages[index + 1] : undefined

  return (
    <div className="drawer lg:drawer-open min-h-screen app-canvas">
      <input id="guide-drawer" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex flex-col min-h-screen">
        <header className="app-header sticky top-0 z-30 flex items-center border-b px-3 gap-2 h-14">
          <label
            htmlFor="guide-drawer"
            className="btn btn-ghost btn-sm btn-square lg:hidden"
            aria-label="Open the guide's pages"
          >
            <Bars3Icon className="w-5 h-5" />
          </label>
          <Link to={guideHref()} className="flex items-center gap-2 lg:hidden">
            <LogoMark className="w-5 h-5" />
            <span className="font-semibold tracking-tight">{name} guide</span>
          </Link>
          <div className="flex-1" />
          <Link to="/" className="btn btn-ghost btn-sm">
            {me ? `Back to ${name}` : 'Sign in'}
          </Link>
          <ThemeToggle />
        </header>

        <div className="guide-body">
          <main className="guide-main">
            {page && rendered ? (
              <article>
                <p className="guide-kicker">
                  {GUIDE_PARTS.find(p => p.id === page.meta.part)?.label}
                </p>
                <h1 className="guide-title">{page.meta.title}</h1>
                <GuideArticle html={rendered.html} />
                <nav className="guide-pager" aria-label="Previous and next pages">
                  {prev ? (
                    <Link to={guideHref(prev.slug)} className="guide-pager-link">
                      <ChevronLeftIcon className="w-4 h-4" aria-hidden />
                      <span>
                        <span className="text-xs text-muted block">Previous</span>
                        {prev.meta.title}
                      </span>
                    </Link>
                  ) : (
                    <span />
                  )}
                  {next && (
                    <Link to={guideHref(next.slug)} className="guide-pager-link guide-pager-next">
                      <span>
                        <span className="text-xs text-muted block">Next</span>
                        {next.meta.title}
                      </span>
                      <ChevronRightIcon className="w-4 h-4" aria-hidden />
                    </Link>
                  )}
                </nav>
              </article>
            ) : (
              <article>
                <h1 className="guide-title">No such page</h1>
                <p className="text-secondary">
                  This guide has no page at that address. Search for it in the list, or start from{' '}
                  <Link className="link" to={guideHref()}>
                    the beginning
                  </Link>
                  .
                </p>
              </article>
            )}
          </main>
          {rendered && rendered.outline.length > 1 && (
            <aside className="guide-toc" aria-label="On this page">
              <p className="guide-nav-part">On this page</p>
              <ul>
                {rendered.outline.map(h => (
                  <li key={h.id}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </div>

      <div className="drawer-side z-40">
        <label
          htmlFor="guide-drawer"
          aria-label="Close the guide's pages"
          className="drawer-overlay"
        />
        <aside className="app-nav guide-side h-full border-r flex flex-col">
          <Link
            to={guideHref()}
            onClick={closeDrawer}
            className="h-14 flex-none flex items-center gap-2.5 px-4 border-b border-[var(--border-default)]"
          >
            <LogoMark className="w-6 h-6" />
            <span className="font-semibold tracking-tight">{name} guide</span>
          </Link>
          <GuideNav pages={pages} current={page?.slug} />
        </aside>
      </div>
    </div>
  )
}
