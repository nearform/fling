/**
 * Review mode: the site in a frame, its comments beside it. Signed-in members of the instance
 * review anyone's site they can open; the owner too. The site's own responses are untouched: the
 * frame is the site as everyone sees it (its sign-in cookie is the app's, on the shared parent
 * domain, so private sites load too).
 *
 * The frame holds the review shell (`/_fling/review.html` on the site's origin), which frames the
 * site and talks to this page over the review bridge (@fling/shared/review-bridge). The shell
 * reports where the frame is (path and hash route, through SPA navigation), keeps it on the site,
 * turns a click or a drag into an anchor when placing a pin, reports text the reviewer selects
 * (which pins the new comment to it, unless they placed a pin), draws the pins and other
 * reviewers' pointers, and says when a pin is clicked. This page owns the data: new comments attach to the path the
 * shell reports, and the path bar and `?path=` follow it. With the `live` capability, the site's
 * live room (useLive) shows who else is reviewing, where they point, and refetches comments as
 * soon as anyone changes them.
 *
 * The comments panel sits beside the frame while the frame keeps most of the width, and over the
 * site as a sheet from the bottom when it can't (the stylesheet's container query decides, and
 * says so in `--review-sheet`). The reviewer shows and hides it from the header; the choice is
 * kept per browser, and a thread link or a clicked pin shows it.
 */
import {
  authorLabel,
  type Comment,
  type CommentAnchor,
  type CommentList,
  type CommentThread,
  commentThreads,
  type PageMessage,
  pageMessage,
  reviewShellUrl,
  ShellMessageSchema,
} from '@fling/shared'
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  EllipsisHorizontalIcon,
  MapPinIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ConfirmModal } from '../components/ConfirmModal'
import { LogoMark } from '../components/LogoMark'
import ThemeToggle from '../components/ThemeToggle'
import { UserMenu } from '../components/UserMenu'
import { useInstance } from '../hooks/instance'
import { useCommentActions, useComments } from '../hooks/queries'
import { type Live, useLive } from '../hooks/useLive'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { ApiError, errorMessage } from '../lib/api'
import { fullDate, shortVersion, timeAgo } from '../lib/format'
import { DEFAULT_INSTANCE_NAME } from '../lib/instance'
import {
  cursorsAt,
  dropExited,
  initials,
  type PresenceCircle,
  presenceCircles,
  reconcileCircles,
  type ShownCircle,
} from '../lib/live'
import {
  type FrameLocation,
  frameUrl,
  linkHost,
  openCountsByPath,
  openThreadCount,
  PANEL_CHOICE_KEY,
  type PanelChoice,
  panelChoice,
  panelOpen,
  pinsFor,
  reviewTarget,
  targetString,
  visibleThreads,
} from '../lib/review'
import { showToast } from '../lib/toast'

/** The id of the pin being placed, before its comment exists. */
const NEW_PIN = 'new'

/** The comments panel's id, for the toggle's `aria-controls`. */
const PANEL_ID = 'review-comments'

/**
 * Whether the comments panel is a sheet over the site, as the stylesheet's container query on the
 * review body decides (`--review-sheet: 1` on the frame), so the layout's threshold lives in CSS.
 */
function useSheetLayout(
  body: RefObject<HTMLElement | null>,
  probe: RefObject<HTMLElement | null>
): boolean {
  const [sheet, setSheet] = useState(false)
  useLayoutEffect(() => {
    const container = body.current
    const el = probe.current
    if (!container || !el) return
    const read = () =>
      setSheet(getComputedStyle(el).getPropertyValue('--review-sheet').trim() === '1')
    read()
    const observer = new ResizeObserver(read)
    observer.observe(container)
    return () => observer.disconnect()
  }, [body, probe])
  return sheet
}

export default function Review() {
  const name = useParams().name ?? ''
  const instance = useInstance()
  const commentsOn = instance?.capabilities.comments === true
  const live = useLive(name, commentsOn && instance?.capabilities.live === true)
  const comments = useComments(name, { live: live.connected })

  if (instance && !commentsOn) {
    return <Message title="Review mode is off">This instance has comments turned off.</Message>
  }
  if (comments.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center app-canvas">
        <span className="loading loading-spinner loading-md text-muted" role="status" />
      </div>
    )
  }
  if (comments.isError) {
    const missing = comments.error instanceof ApiError && comments.error.status === 404
    return (
      <Message title={missing ? `No site named "${name}"` : 'Could not load the review'}>
        {missing
          ? 'It may have been deleted or renamed, or it is not one you can review.'
          : errorMessage(comments.error)}
      </Message>
    )
  }
  return <ReviewSession name={name} list={comments.data} live={live} />
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center app-canvas p-4">
      <div className="surface-panel max-w-md space-y-3 text-center">
        <h1 className="text-lg">{title}</h1>
        <p className="text-sm text-secondary">{children}</p>
        <Link to="/" className="btn btn-sm">
          <ArrowLeftIcon className="h-4 w-4" aria-hidden /> Your sites
        </Link>
      </div>
    </div>
  )
}

function ReviewSession({ name, list, live }: { name: string; list: CommentList; live: Live }) {
  const [params, setParams] = useSearchParams()
  // The shell loads once, on the page asked for; after that it navigates itself and reports.
  const [initial] = useState(() => reviewTarget(params.get('path')))
  const [shellSrc] = useState(() => reviewShellUrl(list.site.url, targetString(initial)))
  const siteOrigin = new URL(list.site.url).origin
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [at, setAt] = useState<FrameLocation>(initial)
  const atRef = useRef(at)
  atRef.current = at

  const [draftPath, setDraftPath] = useState(targetString(initial))
  const [scope, setScope] = useState<'page' | 'all'>('page')
  const [showResolved, setShowResolved] = useState(false)
  const [showPins, setShowPins] = useState(true)
  const [placing, setPlacing] = useState(false)
  // The new comment's pin: placed (a spot or a box), or taken from text selected in the page.
  const [pin, setPin] = useState<{
    anchor: CommentAnchor
    at: FrameLocation
    from: 'placed' | 'selection'
  } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const threads = useMemo(() => commentThreads(list.comments), [list.comments])
  const shown = visibleThreads(threads, { path: scope === 'page' ? at.path : null, showResolved })
  const counts = openCountsByPath(threads)
  const openCount = openThreadCount(threads)

  // The comments panel: the reviewer's choice in this browser, shown for this visit by anything
  // that points at a thread. As a sheet it steps aside while a pin is placed, so the page is free.
  const body = useRef<HTMLDivElement>(null)
  const frameBox = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const sheet = useSheetLayout(body, frameBox)
  const [choice, setChoice] = useLocalStoragePreference<PanelChoice>(
    PANEL_CHOICE_KEY,
    'auto',
    String,
    panelChoice
  )
  const [revealed, setRevealed] = useState(false)
  const panelWanted = panelOpen({ choice, revealed, sheet })
  const panelShown = panelWanted && !(sheet && placing)
  const togglePanel = () => {
    if (sheet && placing) {
      setPlacing(false)
      return
    }
    setChoice(panelWanted ? 'closed' : 'open')
    setRevealed(false)
  }
  // On a narrow header the path bar, reload, open, presence and theme fold behind one button. The
  // stylesheet decides when; outside it the button is hidden and the tools are always shown.
  const toolsButton = useRef<HTMLButtonElement>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => {
    if (!toolsOpen) return
    const close = (e: Event) => {
      const t = e.target as Node | null
      if (
        t &&
        (document.getElementById('review-tools')?.contains(t) || toolsButton.current?.contains(t))
      )
        return
      setToolsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setToolsOpen(false)
      toolsButton.current?.focus()
    }
    // A tap in the frame moves focus into it, which blurs this window.
    window.addEventListener('blur', close)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('blur', close)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolsOpen])

  // Bumped to bring the composer into view and focus it (a pin placed, text selected).
  const [composeRequest, setComposeRequest] = useState(0)

  const hidePanel = () => {
    setChoice('closed')
    setRevealed(false)
    toggle.current?.focus()
  }

  const post = useCallback(
    (m: Parameters<typeof pageMessage>[0]) => {
      frame.current?.contentWindow?.postMessage(pageMessage(m) satisfies PageMessage, siteOrigin)
    },
    [siteOrigin]
  )

  const go = useCallback(
    (next: string) => {
      const target = reviewTarget(next)
      setDraftPath(targetString(target))
      post({ type: 'navigate', path: targetString(target) })
    },
    [post]
  )

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id)
      if (!id) return
      const thread = threads.find(t => t.comment.id === id)
      if (!thread) return
      const { anchor, path } = thread.comment
      const target = { path, hash: anchor?.hash ?? '' }
      const here = atRef.current
      if (path !== here.path || (anchor && target.hash !== here.hash)) go(targetString(target))
      if (anchor) post({ type: 'focusPin', id })
    },
    [threads, go, post]
  )

  // The shell's messages: only from the site's origin, only from this frame, only well-formed.
  const handlers = useRef<(m: ReturnType<typeof ShellMessageSchema.parse>) => void>(() => {})
  handlers.current = m => {
    switch (m.type) {
      case 'ready':
        setReady(true)
        break
      case 'location': {
        const next = { path: m.path, hash: m.hash }
        setAt(next)
        setDraftPath(targetString(next))
        // Follow the frame without a history entry per step inside the site.
        setParams(next.path === '/' && !next.hash ? {} : { path: targetString(next) }, {
          replace: true,
        })
        break
      }
      case 'pinPlaced':
        // Alt places a pin without pin mode, so the page checks here who may comment.
        if (!list.can.create) break
        setPin({ anchor: m.anchor, at: atRef.current, from: 'placed' })
        setPlacing(false)
        setRevealed(true)
        setComposeRequest(n => n + 1)
        break
      case 'textSelected':
        // Selecting text pins the new comment to it, but never moves a pin the reviewer placed.
        if (!list.can.create) break
        setPin(p =>
          p?.from === 'placed' ? p : { anchor: m.anchor, at: atRef.current, from: 'selection' }
        )
        // The panel opens on the composer, holding the quote and focused, ready to type. The
        // frame reports a selection only once it has settled, so on a phone this follows the
        // reviewer lifting their finger from the handles.
        setRevealed(true)
        setComposeRequest(n => n + 1)
        break
      case 'pinCancelled':
        setPlacing(false)
        break
      case 'pinClicked': {
        if (m.id === NEW_PIN) break
        const thread = threads.find(t => t.comment.id === m.id)
        if (!thread) break
        if (scope === 'page' && thread.comment.path !== at.path) setScope('all')
        if (thread.comment.resolvedAt !== null) setShowResolved(true)
        setSelectedId(m.id)
        setRevealed(true)
        break
      }
      case 'cursor':
        live.sendCursor(atRef.current, m.anchor)
        break
      case 'blocked':
        showToast(`That link leaves the site: ${linkHost(m.href)}`, 'info', 8000, {
          action: { label: 'Open in new tab', href: m.href },
        })
        break
      case 'escape':
        setSelectedId(null)
        setPlacing(false)
        break
    }
  }
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== siteOrigin || e.source !== frame.current?.contentWindow) return
      const parsed = ShellMessageSchema.safeParse(e.data)
      if (parsed.success) handlers.current(parsed.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [siteOrigin])

  // What the shell draws, sent whenever it changes (and when the shell says it is ready).
  const pins = useMemo(() => {
    if (!showPins) return []
    const list = pinsFor(threads, at, { showResolved, selectedId })
    if (pin && pin.at.path === at.path && pin.at.hash === at.hash) {
      list.push({
        id: NEW_PIN,
        n: threads.length + 1,
        anchor: pin.anchor,
        selected: true,
        resolved: false,
      })
    }
    return list
  }, [threads, at, showResolved, selectedId, showPins, pin])
  const cursors = useMemo(() => cursorsAt(live.peers, at), [live.peers, at])
  useEffect(() => {
    if (ready) post({ type: 'pins', pins })
  }, [ready, pins, post])
  useEffect(() => {
    if (ready) post({ type: 'cursors', cursors })
  }, [ready, cursors, post])
  useEffect(() => {
    if (ready) post({ type: 'placing', on: placing })
  }, [ready, placing, post])

  // A pin belongs to the page it was placed on: moving on drops it.
  useEffect(() => {
    setPin(p => (p && (p.at.path !== at.path || p.at.hash !== at.hash) ? null : p))
  }, [at])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setPlacing(false)
      setSelectedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (selectedId && panelShown) {
      document
        .getElementById(`thread-${selectedId}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedId, panelShown])

  // A link to a thread (`&thread=<id>`, as notification emails make) selects it once the shell is
  // ready and the thread is listed.
  const [linkedThread, setLinkedThread] = useState(() => params.get('thread'))
  useEffect(() => {
    if (!linkedThread || !ready) return
    const thread = threads.find(t => t.comment.id === linkedThread)
    if (!thread) return
    setLinkedThread(null)
    if (thread.comment.path !== atRef.current.path) setScope('all')
    if (thread.comment.resolvedAt !== null) setShowResolved(true)
    setRevealed(true)
    select(linkedThread)
  }, [linkedThread, ready, threads, select])

  const instanceName = useInstance()?.name ?? DEFAULT_INSTANCE_NAME

  return (
    <div className="review-layout app-canvas">
      <header className="review-header app-header border-b">
        <div className="review-header-row">
          <Link
            to="/"
            className="btn btn-ghost btn-sm gap-2 px-2"
            aria-label={`${instanceName}: back to your sites`}
          >
            <LogoMark className="w-6 h-6" />
            <span className="review-brand font-semibold tracking-tight">{instanceName}</span>
          </Link>
          <span className="review-divider" aria-hidden />
          <h1 className="review-title">
            <span className="review-title-label">Review </span>
            <span className="font-mono text-sm">{list.site.name}</span>
          </h1>
          <button
            ref={toolsButton}
            type="button"
            className="review-tools-button btn btn-ghost btn-sm btn-square"
            aria-label="Page, reload and open"
            title="Page, reload and open"
            aria-expanded={toolsOpen}
            aria-controls="review-tools"
            onClick={() => setToolsOpen(o => !o)}
          >
            <EllipsisHorizontalIcon className="h-5 w-5" aria-hidden />
          </button>
          <div id="review-tools" className="review-tools" data-open={toolsOpen || undefined}>
            <form
              className="review-pathbar join"
              onSubmit={(e: { preventDefault(): void }) => {
                e.preventDefault()
                go(draftPath)
                setToolsOpen(false)
              }}
            >
              <label className="sr-only" htmlFor="review-path">
                Page path
              </label>
              <input
                id="review-path"
                className="input input-sm join-item font-mono"
                value={draftPath}
                onChange={e => setDraftPath(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="btn btn-sm join-item">
                Go
              </button>
            </form>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              aria-label="Reload the page"
              title="Reload the page"
              onClick={() => post({ type: 'reload' })}
            >
              <ArrowPathIcon className="h-4 w-4" aria-hidden />
            </button>
            <a
              href={frameUrl(list.site.url, targetString(at))}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm"
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden />
              Open
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <Presence live={live} at={at} />
            <ThemeToggle />
          </div>
          <UserMenu />
          <button
            ref={toggle}
            type="button"
            className={`review-toggle btn btn-sm gap-1.5 ${panelShown ? 'btn-active' : 'btn-ghost'}`}
            aria-expanded={panelShown}
            aria-controls={PANEL_ID}
            title={panelShown ? 'Hide the comments' : 'Show the comments'}
            onClick={togglePanel}
          >
            <ChatBubbleLeftRightIcon className="h-4 w-4" aria-hidden />
            <span className="review-toggle-label">Comments</span>
            <span className="review-count">
              {openCount}
              <span className="sr-only"> open</span>
            </span>
          </button>
        </div>
      </header>

      <div ref={body} className="review-body">
        <div ref={frameBox} className="review-frame">
          <iframe
            ref={frame}
            title={`${list.site.name}${at.path}`}
            src={shellSrc}
            // Another origin, so allow-same-origin gives it nothing of the app's; without
            // allow-top-navigation the site can't navigate the review page away.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>

        <aside
          id={PANEL_ID}
          className="review-aside"
          aria-labelledby="review-comments-title"
          hidden={!panelShown}
        >
          <div className="flex items-center gap-2">
            <h2 id="review-comments-title" className="text-sm font-semibold">
              Comments
            </h2>
            <span className="text-xs text-secondary">{openCount} open</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square ms-auto"
              aria-label="Hide the comments"
              title="Hide the comments"
              aria-expanded={panelShown}
              aria-controls={PANEL_ID}
              onClick={hidePanel}
            >
              <XMarkIcon className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div className="join" role="group" aria-label="Which comments">
              <button
                type="button"
                className={`btn btn-xs join-item ${scope === 'page' ? 'btn-active' : ''}`}
                aria-pressed={scope === 'page'}
                onClick={() => setScope('page')}
              >
                This page
              </button>
              <button
                type="button"
                className={`btn btn-xs join-item ${scope === 'all' ? 'btn-active' : ''}`}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
              >
                All pages
              </button>
            </div>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={showResolved}
                onChange={e => setShowResolved(e.target.checked)}
              />
              Resolved
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={showPins}
                onChange={e => setShowPins(e.target.checked)}
              />
              Pins
            </label>
          </div>

          <div className="review-threads">
            <Composer
              name={name}
              path={at.path}
              canCreate={list.can.create}
              pin={pin?.anchor ?? null}
              placing={placing}
              focusRequest={composeRequest}
              onPlace={() => setPlacing(p => !p)}
              onClearPin={() => setPin(null)}
            />
            {shown.length === 0 ? (
              <div className="space-y-2 py-6 text-center text-sm text-secondary">
                <ChatBubbleLeftRightIcon className="mx-auto h-6 w-6 text-muted" aria-hidden />
                <p>
                  {scope === 'page' ? `No open comments on ${at.path}.` : 'No open comments yet.'}
                </p>
                {scope === 'page' && counts.size > 0 && (
                  <p>
                    Other pages have some:{' '}
                    {[...counts.entries()].map(([p, n], i) => (
                      <span key={p}>
                        {i > 0 && ', '}
                        <button type="button" className="link" onClick={() => go(p)}>
                          {p}
                        </button>{' '}
                        ({n})
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ) : (
              <ol className="space-y-3">
                {shown.map(t => (
                  <Thread
                    key={t.comment.id}
                    name={name}
                    thread={t}
                    number={threads.indexOf(t) + 1}
                    list={list}
                    onPage={t.comment.path === at.path}
                    selected={t.comment.id === selectedId}
                    onSelect={() => select(t.comment.id)}
                  />
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * Who has the review open: a row of overlapping circles (picture or initials, in their colour),
 * you first, one per person however many tabs; people on other pages dimmed; past five, a "+N"
 * that lists everyone. Circles emerge as people arrive and shrink away as they leave.
 */
function Presence({ live, at }: { live: Live; at: FrameLocation }) {
  const { you, peers } = live
  const circles = useMemo(
    () => (you ? presenceCircles({ you, peers }, at) : { shown: [], more: [] }),
    [you, peers, at]
  )
  const [drawn, setDrawn] = useState<ShownCircle[]>([])
  const [listing, setListing] = useState(false)
  useEffect(() => setDrawn(d => reconcileCircles(d, circles.shown)), [circles.shown])
  // Drop leaving circles even if their animation never reports its end (a hidden tab).
  const leaving = drawn.some(d => d.phase === 'exit')
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setDrawn(d => d.filter(x => x.phase !== 'exit')), 1000)
    return () => clearTimeout(t)
  }, [leaving])

  const everyone = [...circles.shown, ...circles.more]
  return (
    <div className="review-presence ms-auto">
      <p className="sr-only" aria-live="polite">
        {live.announcement}
      </p>
      <ul className="flex items-center" aria-label="Reviewing now">
        {drawn.map(d => (
          <li
            key={d.circle.key}
            className={`review-avatar-slot is-${d.phase}`}
            style={{ '--delay': `${d.delay}ms`, '--peer': d.circle.colour } as CSSProperties}
            onAnimationEnd={e => {
              if (d.phase === 'exit' && e.target === e.currentTarget) {
                setDrawn(x => dropExited(x, d.circle.key))
              }
            }}
          >
            <Avatar circle={d.circle} />
          </li>
        ))}
        {circles.more.length > 0 && (
          <li className="review-avatar-slot relative">
            <button
              type="button"
              className="review-avatar review-avatar-more"
              aria-expanded={listing}
              aria-label={`${circles.more.length} more: show everyone`}
              title="Everyone reviewing"
              onClick={() => setListing(l => !l)}
              onFocus={() => setListing(true)}
              onBlur={() => setListing(false)}
            >
              +{circles.more.length}
            </button>
            {listing && (
              <ul className="review-presence-list surface-panel">
                {everyone.map(c => (
                  <li key={c.key} className="flex items-center gap-2">
                    <span
                      className="review-presence-dot"
                      style={{ backgroundColor: c.colour }}
                      aria-hidden
                    />
                    {circleLabel(c)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
      </ul>
    </div>
  )
}

const circleLabel = (c: PresenceCircle) =>
  `${c.name}${c.you ? ' (you)' : ''}${c.page ? ` · on ${c.page}` : ''}`

function Avatar({ circle }: { circle: PresenceCircle }) {
  const [broken, setBroken] = useState(false)
  const label = circleLabel(circle)
  const picture = circle.picture && !broken ? circle.picture : null
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`review-avatar ${circle.here ? '' : 'is-away'} ${picture ? 'has-picture' : ''}`}
      style={{ backgroundColor: circle.colour }}
    >
      {picture ? (
        <img src={picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        initials(circle.name)
      )}
    </span>
  )
}

/**
 * The new comment: one line ("Add a comment…") until it is used, then the full composer with its
 * pin and buttons. It stays open while it holds text or a pin, or while one is being placed, and
 * closes after posting or cancelling. `focusRequest` changing brings it into view and focuses it.
 */
function Composer({
  name,
  path,
  canCreate,
  pin,
  placing,
  focusRequest,
  onPlace,
  onClearPin,
}: {
  name: string
  path: string
  canCreate: boolean
  pin: CommentAnchor | null
  placing: boolean
  focusRequest: number
  onPlace: () => void
  onClearPin: () => void
}) {
  const actions = useCommentActions(name)
  const [body, setBody] = useState('')
  const [active, setActive] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const expanded = active || body.trim() !== '' || pin !== null || placing

  useEffect(() => {
    if (focusRequest === 0) return
    form.current?.scrollIntoView({ block: 'nearest' })
    field.current?.focus({ preventScroll: true })
  }, [focusRequest])

  if (!canCreate) return null
  const close = () => {
    setActive(false)
    field.current?.blur()
  }
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!body.trim()) return
    actions.add.mutate(
      { body, path, ...(pin ? { anchor: pin } : {}) },
      {
        onSuccess: () => {
          setBody('')
          onClearPin()
          close()
        },
      }
    )
  }
  const cancel = () => {
    setBody('')
    onClearPin()
    if (placing) onPlace()
    close()
  }
  return (
    <form
      ref={form}
      className="review-composer surface-panel !p-2"
      data-expanded={expanded || undefined}
      onSubmit={submit}
      onFocus={() => setActive(true)}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(false)
      }}
    >
      <label htmlFor="review-new" className={expanded ? 'text-sm text-secondary' : 'sr-only'}>
        Comment on <span className="font-mono">{path}</span>
      </label>
      <textarea
        ref={field}
        id="review-new"
        rows={1}
        className="textarea review-textarea w-full"
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
          if (e.key === 'Escape' && !body.trim()) {
            e.stopPropagation()
            cancel()
          }
        }}
        placeholder={expanded ? 'What should change?' : 'Add a comment…'}
        maxLength={4000}
      />
      {expanded && (
        <div className="flex flex-wrap items-center gap-2">
          {pin ? (
            <span className="badge badge-sm tone-primary h-auto min-w-0 max-w-full gap-1">
              <MapPinIcon className="h-3 w-3 shrink-0" aria-hidden />
              {pin.quote ? (
                <span className="truncate" title={pin.quote}>
                  “{pin.quote}”
                </span>
              ) : (
                <span>
                  {pin.ew !== undefined || pin.docW !== undefined ? 'Pinned box' : 'Pinned'}
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-square h-4 min-h-4 w-4"
                aria-label="Remove the pin"
                onClick={onClearPin}
              >
                <XMarkIcon className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={`btn btn-ghost btn-xs ${placing ? 'btn-active' : ''}`}
              aria-pressed={placing}
              onClick={onPlace}
              title="Click a spot or drag a box in the page, or select text in it: the pin stays on that element as the page scrolls. Shortcut: hold Alt (⌥) and click or drag in the page"
            >
              <MapPinIcon className="h-3.5 w-3.5" aria-hidden /> Pin to a spot
            </button>
          )}
          <span className="ms-auto flex gap-1">
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!body.trim() || actions.add.isPending}
            >
              Comment
            </button>
          </span>
        </div>
      )}
    </form>
  )
}

function Thread({
  name,
  thread,
  number,
  list,
  onPage,
  selected,
  onSelect,
}: {
  name: string
  thread: CommentThread
  number: number
  list: CommentList
  onPage: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { comment, replies } = thread
  const actions = useCommentActions(name)
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const [deleting, setDeleting] = useState<Comment | null>(null)
  const resolved = comment.resolvedAt !== null

  // The reply field is one line until it is focused or holds text.
  const replyField = useRef<HTMLTextAreaElement>(null)
  const replyOpen = replying || reply.trim() !== ''
  const cancelReply = () => {
    setReply('')
    setReplying(false)
    replyField.current?.blur()
  }
  const sendReply = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!reply.trim()) return
    actions.add.mutate({ body: reply, parentId: comment.id }, { onSuccess: cancelReply })
  }

  return (
    <li
      id={`thread-${comment.id}`}
      className={`review-thread surface-panel space-y-2 !p-3 ${resolved ? 'opacity-70' : ''} ${selected ? 'review-thread-selected' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
        <button
          type="button"
          className="review-number"
          aria-pressed={selected}
          title={comment.anchor ? 'Show its pin' : 'Select this thread'}
          onClick={onSelect}
        >
          <span className="sr-only">Thread </span>
          {number}
        </button>
        {!onPage && (
          <button type="button" className="link font-mono" onClick={onSelect}>
            {comment.path}
          </button>
        )}
        {comment.anchor && (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 hover:underline"
            title="Show its pin in the page"
            onClick={onSelect}
          >
            <MapPinIcon className="h-3.5 w-3.5" aria-hidden /> Pinned
          </button>
        )}
        {resolved && (
          <span className="badge badge-xs badge-ghost gap-1">
            <CheckCircleIcon className="h-3 w-3" aria-hidden /> Resolved
          </span>
        )}
      </div>
      {comment.anchor?.quote && (
        <blockquote className="review-quote text-sm text-secondary">
          <button
            type="button"
            className="text-start"
            title="Show it in the page"
            onClick={onSelect}
          >
            {comment.anchor.quote}
          </button>
        </blockquote>
      )}
      <CommentBody comment={comment} list={list} onDelete={() => setDeleting(comment)} />
      {replies.length > 0 && (
        <ol className="review-replies space-y-2">
          {replies.map(r => (
            <li key={r.id}>
              <CommentBody comment={r} list={list} onDelete={() => setDeleting(r)} />
            </li>
          ))}
        </ol>
      )}
      {list.can.create && (
        <form
          className="review-reply"
          data-expanded={replyOpen || undefined}
          onSubmit={sendReply}
          onFocus={() => setReplying(true)}
          onBlur={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setReplying(false)
          }}
        >
          <textarea
            ref={replyField}
            rows={1}
            className="textarea textarea-sm review-textarea w-full"
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply(e)
              if (e.key === 'Escape' && !reply.trim()) {
                e.stopPropagation()
                cancelReply()
              }
            }}
            aria-label={`Reply to thread ${number}`}
            placeholder="Reply…"
            maxLength={4000}
          />
          {replyOpen && (
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost btn-xs" onClick={cancelReply}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary btn-xs"
                disabled={!reply.trim() || actions.add.isPending}
              >
                Reply
              </button>
            </div>
          )}
        </form>
      )}
      {list.can.resolve && (
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={actions.resolve.isPending}
            onClick={() => actions.resolve.mutate({ id: comment.id, resolved: !resolved })}
          >
            <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden />
            {resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      )}
      <ConfirmModal
        isOpen={deleting !== null}
        title={deleting?.parentId === null ? 'Delete this thread?' : 'Delete this reply?'}
        message={
          deleting?.parentId === null && replies.length > 0
            ? `Its ${replies.length} ${replies.length === 1 ? 'reply goes' : 'replies go'} too. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmText="Delete"
        confirmButtonClass="btn-error"
        isLoading={actions.remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          deleting && actions.remove.mutate(deleting.id, { onSettled: () => setDeleting(null) })
        }
      />
    </li>
  )
}

function CommentBody({
  comment,
  list,
  onDelete,
}: {
  comment: Comment
  list: CommentList
  onDelete: () => void
}) {
  const older = comment.versionId !== null && comment.versionId !== list.site.currentVersionId
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-[color:var(--text-primary)]">
          {authorLabel(comment.author)}
        </span>
        <time
          className="shrink-0 text-muted"
          dateTime={comment.createdAt}
          title={fullDate(comment.createdAt)}
        >
          {timeAgo(comment.createdAt)}
        </time>
        {older && (
          <span
            className="shrink-0 text-muted"
            title={`Written while version ${comment.versionId} was live; the site has changed since`}
          >
            · on {shortVersion(comment.versionId)}
          </span>
        )}
        {comment.canDelete && (
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square ms-auto h-5 min-h-5 w-5"
            aria-label="Delete comment"
            title="Delete"
            onClick={onDelete}
          >
            <TrashIcon className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      <p className="review-text text-sm">{comment.body}</p>
    </div>
  )
}
