/**
 * The site page's live preview (`thumbnails` capability): the home page as a desktop browser shows
 * it (PREVIEW_VIEWPORT), scaled down to the tile with CSS, loaded when it scrolls into view and
 * out of reach of the pointer, the keyboard and screen readers; a link over it opens the site.
 *
 * The frame holds the review shell in preview mode (`previewShellUrl`) on the site's own origin,
 * so private and restricted sites load as they do in review mode (the app's sign-in cookie is on
 * the shared parent domain, and a restricted site's pass is set within the frame). When the viewer
 * owns or publishes the site and its thumbnail is missing or of another version
 * (`wantsThumbnail`), the page asks the shell to draw one of the current version once the home
 * page has settled (`capture`), and keeps what comes back (`captured`) as the thumbnail of the
 * version the shell says it shows. While the sites host still serves an older version the shell
 * draws nothing (`captureFailed`, `stale`) and the page leaves it: the next view retries. The
 * faded logo mark shows until the frame has loaded.
 */
import {
  pageMessage,
  previewShellUrl,
  ShellMessageSchema,
  type SiteDetail,
  wantsThumbnail,
} from '@fling/shared'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSaveThumbnail } from '../../hooks/queries'
import { ThumbnailPlaceholder } from '../SiteThumbnail'

export function SitePreview({ site }: { site: SiteDetail }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const src = useMemo(() => previewShellUrl(site.url), [site.url])
  const siteOrigin = useMemo(() => new URL(site.url).origin, [site.url])
  const [loaded, setLoaded] = useState(false)
  const save = useSaveThumbnail(site.name)
  // The version the shell was asked to draw, once per version: what its picture is of.
  const askedFor = useRef<string | null>(null)
  const wanted = wantsThumbnail(site) ? site.currentVersionId : null
  const latest = useRef({ wanted, save: save.mutate })
  latest.current = { wanted, save: save.mutate }

  useEffect(() => {
    const ask = () => {
      const version = latest.current.wanted
      if (!version || askedFor.current === version) return
      askedFor.current = version
      frame.current?.contentWindow?.postMessage(
        pageMessage({ type: 'capture', versionId: version }),
        siteOrigin
      )
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== siteOrigin || e.source !== frame.current?.contentWindow) return
      const parsed = ShellMessageSchema.safeParse(e.data)
      if (!parsed.success) return
      const m = parsed.data
      if (m.type === 'ready') ask()
      else if (m.type === 'captured' && askedFor.current) {
        latest.current.save({ versionId: m.versionId, png: m.png })
      } else if (m.type === 'captureFailed') {
        console.info(`No thumbnail of ${site.name}: ${m.reason}`)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [siteOrigin, site.name])

  // A new version while the page is open: the shell is ready already, so ask again.
  useEffect(() => {
    if (!loaded || !wanted || askedFor.current === wanted) return
    askedFor.current = wanted
    frame.current?.contentWindow?.postMessage(
      pageMessage({ type: 'capture', versionId: wanted }),
      siteOrigin
    )
  }, [loaded, wanted, siteOrigin])

  return (
    <figure className="site-preview" data-loaded={loaded || undefined}>
      <ThumbnailPlaceholder />
      {/* `inert` as an attribute: React 18 has no prop for it. */}
      <div className="site-preview-viewport" {...{ inert: '' }}>
        <iframe
          ref={frame}
          src={src}
          title={`A preview of ${site.name}'s home page`}
          loading="lazy"
          tabIndex={-1}
          // Another origin, so allow-same-origin gives it nothing of the app's; nothing more
          // than scripts, since nobody can use it.
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setLoaded(true)}
        />
      </div>
      <a className="site-preview-open" href={site.url} target="_blank" rel="noreferrer">
        <span className="sr-only">Open {site.name} (opens in a new tab)</span>
        <ArrowTopRightOnSquareIcon className="site-preview-open-icon" aria-hidden />
      </a>
    </figure>
  )
}
