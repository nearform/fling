/**
 * The site page's overview: where the site is served, its review page (when the instance has
 * comments), the version being served, whether it is a single-page app and when it was created
 * and last updated.
 */
import type { SiteDetail } from '@fling/shared'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { useInstance } from '../../hooks/instance'
import { displayUrl, formatBytes, fullDate, shortVersion, timeAgo } from '../../lib/format'
import { CopyButton } from '../CopyButton'
import { ReviewButton } from '../SiteButtons'
import { SiteSection } from './SiteSection'

export function SiteOverview({ site }: { site: SiteDetail }) {
  const instance = useInstance()
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const current = site.versions.find(v => v.id === site.currentVersionId)

  return (
    <SiteSection title="Overview">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <Row label="URL">
          <span className="flex min-w-0 items-center">
            {site.archived ? (
              <span className="truncate text-muted" title="Archived: offline until unarchived">
                {displayUrl(site.url)}
              </span>
            ) : (
              <a
                href={site.url}
                target="_blank"
                rel="noreferrer"
                className="link link-hover inline-flex min-w-0 items-center gap-1"
              >
                <span className="truncate">{displayUrl(site.url)}</span>
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
            <CopyButton text={site.url} label={`Copy the URL of ${site.name}`} />
          </span>
        </Row>
        {reviewable && (
          <Row label="Review">
            <ReviewButton name={site.name} />
          </Row>
        )}
        <Row label="Current version">
          {site.currentVersionId ? (
            <span>
              <code className="text-xs" title={site.currentVersionId}>
                {shortVersion(site.currentVersionId)}
              </code>
              {current && (
                <span className="text-secondary">
                  {' · '}
                  {current.fileCount} file{current.fileCount === 1 ? '' : 's'},{' '}
                  {formatBytes(current.totalBytes)}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted">None yet</span>
          )}
        </Row>
        <Row label="Single-page app">
          {site.spa ? 'Yes: unknown paths serve /index.html' : 'No: unknown paths are a 404'}
        </Row>
        <Row label="Created">
          <span title={fullDate(site.createdAt)}>{timeAgo(site.createdAt)}</span>
        </Row>
        <Row label="Updated">
          <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
        </Row>
      </dl>
    </SiteSection>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-secondary">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}
