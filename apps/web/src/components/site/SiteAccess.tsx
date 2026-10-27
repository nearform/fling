/**
 * Who can open the site: public or private, and its share link (create, copy, refresh, revoke).
 * Refreshing and revoking break the link people already have, so both ask first.
 */
import type { Site } from '@fling/shared'
import { ArrowPathIcon, LinkIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useInstance } from '../../hooks/instance'
import { useSiteActions } from '../../hooks/queries'
import { displayUrl } from '../../lib/format'
import { audienceFor, DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import { showToast } from '../../lib/toast'
import { ConfirmModal } from '../ConfirmModal'
import { CopyButton } from '../CopyButton'
import { SiteSection } from './SiteSection'

export function SiteAccess({ site }: { site: Site }) {
  const instance = useInstance()
  const actions = useSiteActions(site.name)
  const [dialog, setDialog] = useState<'refresh-share' | 'revoke-share' | null>(null)
  const close = () => setDialog(null)

  const createShare = (rotating: boolean) =>
    actions.share.mutate(undefined, {
      onSuccess: async ({ shareUrl }) => {
        close()
        try {
          await navigator.clipboard.writeText(shareUrl)
          showToast(rotating ? 'New share link copied' : 'Share link created and copied')
        } catch {
          showToast(rotating ? 'Share link refreshed' : 'Share link created')
        }
      },
    })

  return (
    <SiteSection title="Access" description="Who can open the site.">
      <div className="grid gap-2 md:grid-cols-2">
        {/* Visibility */}
        <div className="surface-inset space-y-0.5 px-3 py-2">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-sm font-medium">Public</span>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={site.visibility === 'public'}
              disabled={actions.setVisibility.isPending}
              onChange={e => actions.setVisibility.mutate(e.target.checked ? 'public' : 'private')}
            />
          </label>
          <p className="text-xs text-muted">
            {site.visibility === 'public'
              ? 'Anyone with the URL can open it.'
              : `Private: open to ${audienceFor(instance)}.`}
          </p>
        </div>

        {/* Share link */}
        <div className="surface-inset space-y-0.5 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Share link</span>
            {site.shareUrl ? (
              <span className="flex gap-0.5">
                <CopyButton text={site.shareUrl} label="Copy share link" />
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square"
                  title="Refresh the share link"
                  aria-label="Refresh the share link"
                  onClick={() => setDialog('refresh-share')}
                >
                  <ArrowPathIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square text-error"
                  title="Revoke the share link"
                  aria-label="Revoke the share link"
                  onClick={() => setDialog('revoke-share')}
                >
                  <NoSymbolIcon className="h-4 w-4" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => createShare(false)}
                disabled={actions.share.isPending}
              >
                <LinkIcon className="h-3.5 w-3.5" />
                Create
              </button>
            )}
          </div>
          {site.shareUrl ? (
            <a
              href={site.shareUrl}
              target="_blank"
              rel="noreferrer"
              className="link link-hover block truncate font-mono text-xs"
            >
              {displayUrl(site.shareUrl)}
            </a>
          ) : (
            <p className="text-xs text-muted">
              Lets anyone with the link open the site without signing in — for people who can’t sign
              in.
            </p>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={dialog === 'refresh-share'}
        title="Refresh the share link?"
        message="You'll get a new link. The old link stops working straight away, so anyone you sent it to will need the new one."
        confirmText="Refresh link"
        confirmButtonClass="btn-warning"
        isLoading={actions.share.isPending}
        onCancel={close}
        onConfirm={() => createShare(true)}
      />
      <ConfirmModal
        isOpen={dialog === 'revoke-share'}
        title="Revoke the share link?"
        message={`The link stops working straight away. People signed in to ${instance?.name ?? DEFAULT_INSTANCE_NAME} can still open the site if it is private.`}
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={actions.revokeShare.isPending}
        onCancel={close}
        onConfirm={() => actions.revokeShare.mutate(undefined, { onSettled: close })}
      />
    </SiteSection>
  )
}
