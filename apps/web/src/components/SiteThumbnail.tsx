/**
 * A site's thumbnail on a tile of the preview's shape (16:10): the PNG of its home page that its
 * owners' and publishers' browsers keep up to date (`thumbnails` capability), or, while it has
 * none or it fails to load, the instance's logo mark faded on a neutral tile. The picture
 * is named for screen readers; the placeholder is decorative, since the card around it names the
 * site.
 */
import { thumbnailUrl } from '@fling/shared'
import { useState } from 'react'
import { LogoMark } from './LogoMark'

export function SiteThumbnail({
  name,
  thumbnail,
  className = '',
}: {
  name: string
  thumbnail?: { updatedAt: string } | undefined
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const shown = thumbnail && failed !== thumbnail.updatedAt
  return (
    <div className={`site-thumb ${className}`}>
      {shown ? (
        <img
          src={thumbnailUrl(name, thumbnail.updatedAt)}
          alt={`The home page of ${name}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(thumbnail.updatedAt)}
        />
      ) : (
        <ThumbnailPlaceholder />
      )}
    </div>
  )
}

/** The instance's logo mark, faded: where a picture of a site will be. */
export function ThumbnailPlaceholder() {
  return (
    <span className="site-thumb-placeholder" aria-hidden="true">
      <LogoMark className="site-thumb-mark" />
    </span>
  )
}
