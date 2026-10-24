/**
 * Review mode: the site in a frame, its comments beside it. Signed-in members of the instance
 * review anyone's site they can open; the owner too. The site's own responses are untouched: the
 * frame is the site as everyone sees it (its sign-in cookie is the app's, on the shared parent
 * domain, so private sites load too).
 *
 * The frame is another origin, so this page can't see which page it is on or where it is
 * scrolled. The page owns the path: its path bar loads a page into the frame and new comments
 * attach to that path (and to the version being served). When the frame navigates by itself (a
 * link inside the site) the page notices only that it loaded something else, and asks for the
 * path. A pin is a point in the frame's viewport, as percentages: where the reviewer pointed,
 * shown over the frame as it is now, not following its scroll.
 */
import {
  authorLabel,
  type Comment,
  type CommentAnchor,
  type CommentList,
  type CommentThread,
  commentThreads,
} from '@fling/shared'
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  MapPinIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ConfirmModal } from '../components/ConfirmModal'
import { useInstance } from '../hooks/instance'
import { useCommentActions, useComments } from '../hooks/queries'
import { ApiError, errorMessage } from '../lib/api'
import { fullDate, shortVersion, timeAgo } from '../lib/format'
import { anchorAt, frameUrl, openCountsByPath, reviewPath, visibleThreads } from '../lib/review'

export default function Review() {
  const name = useParams().name ?? ''
  const instance = useInstance()
  const comments = useComments(name)

  if (instance && instance.capabilities.comments !== true) {
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
  return <ReviewSession name={name} list={comments.data} />
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

function ReviewSession({ name, list }: { name: string; list: CommentList }) {
  const [params, setParams] = useSearchParams()
  const path = reviewPath(params.get('path'))
  const [draftPath, setDraftPath] = useState(path)
  const [scope, setScope] = useState<'page' | 'all'>('page')
  const [showResolved, setShowResolved] = useState(false)
  const [showPins, setShowPins] = useState(true)
  const [placing, setPlacing] = useState(false)
  const [pin, setPin] = useState<CommentAnchor | null>(null)
  // The frame's loads since this page last pointed it somewhere: more than one means it moved on.
  const [loads, setLoads] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)

  const threads = useMemo(() => commentThreads(list.comments), [list.comments])
  const shown = visibleThreads(threads, { path: scope === 'page' ? path : null, showResolved })
  const counts = openCountsByPath(threads)
  const pinned = visibleThreads(threads, { path, showResolved: false }).filter(
    t => t.comment.anchor
  )
  const frameMoved = loads > 1

  useEffect(() => {
    if (!placing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlacing(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [placing])

  const go = (next: string) => {
    const normalized = reviewPath(next)
    setDraftPath(normalized)
    setParams(normalized === '/' ? {} : { path: normalized }, { replace: false })
    setLoads(0)
    setReloadKey(k => k + 1)
    setPin(null)
  }

  return (
    <div className="review-shell app-canvas">
      <header className="app-header flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Link to="/" className="btn btn-ghost btn-sm btn-square" aria-label="Back to your sites">
          <ArrowLeftIcon className="h-4 w-4" aria-hidden />
        </Link>
        <h1 className="min-w-0 truncate text-base">
          Review <span className="font-mono text-sm">{list.site.name}</span>
        </h1>
        <form
          className="review-pathbar join"
          onSubmit={(e: { preventDefault(): void }) => {
            e.preventDefault()
            go(draftPath)
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
          onClick={() => go(path)}
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden />
        </button>
        <a
          href={frameUrl(list.site.url, path)}
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost btn-sm"
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden />
          Open
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </header>

      <div className="review-body">
        <div className="review-frame">
          <iframe
            key={reloadKey}
            title={`${list.site.name}${path}`}
            src={frameUrl(list.site.url, path)}
            // Another origin, so allow-same-origin gives it nothing of the app's; without
            // allow-top-navigation the site can't navigate the review page away.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => setLoads(n => n + 1)}
          />
          {showPins && !placing && (
            <div className="review-pins" aria-hidden>
              {pinned.map(t => (
                <span
                  key={t.comment.id}
                  className="review-pin"
                  style={{
                    insetInlineStart: `${t.comment.anchor?.x}%`,
                    insetBlockStart: `${t.comment.anchor?.y}%`,
                  }}
                  title={t.comment.body}
                >
                  {threads.indexOf(t) + 1}
                </span>
              ))}
              {pin && (
                <span
                  className="review-pin review-pin-new"
                  style={{ insetInlineStart: `${pin.x}%`, insetBlockStart: `${pin.y}%` }}
                />
              )}
            </div>
          )}
          {placing && (
            <button
              type="button"
              className="review-placer"
              aria-label="Click where your comment is about"
              onClick={e => {
                setPin(anchorAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY))
                setPlacing(false)
              }}
            >
              <span className="review-placer-hint">Click where your comment is about · Esc</span>
            </button>
          )}
        </div>

        <aside className="review-aside" aria-label="Comments">
          {frameMoved && (
            <div role="status" className="alert alert-warning alert-soft text-sm">
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                The page moved on inside the frame. This page can't see where to (the site is
                another origin): type its path above and press Go, so your comments land on it.
              </span>
            </div>
          )}

          <Composer
            name={name}
            path={path}
            canCreate={list.can.create}
            pin={pin}
            placing={placing}
            onPlace={() => setPlacing(p => !p)}
            onClearPin={() => setPin(null)}
          />

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

          {shown.length === 0 ? (
            <div className="space-y-2 py-6 text-center text-sm text-secondary">
              <ChatBubbleLeftRightIcon className="mx-auto h-6 w-6 text-muted" aria-hidden />
              <p>{scope === 'page' ? `No open comments on ${path}.` : 'No open comments yet.'}</p>
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
                  onPage={t.comment.path === path}
                  onGo={() => go(t.comment.path)}
                />
              ))}
            </ol>
          )}
        </aside>
      </div>
    </div>
  )
}

function Composer({
  name,
  path,
  canCreate,
  pin,
  placing,
  onPlace,
  onClearPin,
}: {
  name: string
  path: string
  canCreate: boolean
  pin: CommentAnchor | null
  placing: boolean
  onPlace: () => void
  onClearPin: () => void
}) {
  const actions = useCommentActions(name)
  const [body, setBody] = useState('')
  if (!canCreate) return null
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!body.trim()) return
    actions.add.mutate(
      { body, path, ...(pin ? { anchor: pin } : {}) },
      {
        onSuccess: () => {
          setBody('')
          onClearPin()
        },
      }
    )
  }
  return (
    <form className="surface-panel space-y-2 !p-3" onSubmit={submit}>
      <label htmlFor="review-new" className="text-sm text-secondary">
        Comment on <span className="font-mono">{path}</span>
      </label>
      <textarea
        id="review-new"
        className="textarea review-textarea w-full"
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
        }}
        placeholder="What should change?"
        maxLength={4000}
      />
      <div className="flex flex-wrap items-center gap-2">
        {pin ? (
          <span className="badge badge-sm tone-primary gap-1">
            <MapPinIcon className="h-3 w-3" aria-hidden /> Pinned
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
            title="Point at a spot in the page as it is shown now (the pin doesn't follow scrolling)"
          >
            <MapPinIcon className="h-3.5 w-3.5" aria-hidden /> Pin to a spot
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary btn-sm ms-auto"
          disabled={!body.trim() || actions.add.isPending}
        >
          Comment
        </button>
      </div>
    </form>
  )
}

function Thread({
  name,
  thread,
  number,
  list,
  onPage,
  onGo,
}: {
  name: string
  thread: CommentThread
  number: number
  list: CommentList
  onPage: boolean
  onGo: () => void
}) {
  const { comment, replies } = thread
  const actions = useCommentActions(name)
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const [deleting, setDeleting] = useState<Comment | null>(null)
  const resolved = comment.resolvedAt !== null

  const sendReply = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!reply.trim()) return
    actions.add.mutate(
      { body: reply, parentId: comment.id },
      {
        onSuccess: () => {
          setReply('')
          setReplying(false)
        },
      }
    )
  }

  return (
    <li className={`surface-panel space-y-2 !p-3 ${resolved ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
        <span className="review-number">
          <span className="sr-only">Thread </span>
          {number}
        </span>
        {!onPage && (
          <button type="button" className="link font-mono" onClick={onGo}>
            {comment.path}
          </button>
        )}
        {comment.anchor && (
          <span className="inline-flex items-center gap-0.5" title="Pinned to a spot in the page">
            <MapPinIcon className="h-3.5 w-3.5" aria-hidden /> Pinned
          </span>
        )}
        {resolved && (
          <span className="badge badge-xs badge-ghost gap-1">
            <CheckCircleIcon className="h-3 w-3" aria-hidden /> Resolved
          </span>
        )}
      </div>
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
      {replying ? (
        <form className="space-y-2" onSubmit={sendReply}>
          <textarea
            className="textarea textarea-sm review-textarea w-full"
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply(e)
              if (e.key === 'Escape') setReplying(false)
            }}
            aria-label="Reply"
            placeholder="Reply"
            maxLength={4000}
            // biome-ignore lint/a11y/noAutofocus: opened by the Reply button, to type at once
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setReplying(false)}
            >
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
        </form>
      ) : (
        <div className="flex flex-wrap gap-1">
          {list.can.create && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setReplying(true)}
            >
              Reply
            </button>
          )}
          {list.can.resolve && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={actions.resolve.isPending}
              onClick={() => actions.resolve.mutate({ id: comment.id, resolved: !resolved })}
            >
              <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden />
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
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
