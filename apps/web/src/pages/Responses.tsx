/**
 * A site's progress view (the `forms` capability): how far reviewing has got, named after the
 * forms config's title ("Labels · 12 / 51"). Per form, a page × reviewer matrix whose cells open
 * the review page on that page, and the responses to download as CSV or JSON Lines. What it shows
 * is what the export gives the caller: on an `own` form, a reviewer sees only their own responses,
 * and the site's owners and admins see everyone's.
 */
import {
  type FormDefinition,
  type FormProgress,
  type ResponseExportFormat,
  responsesFileName,
} from '@fling/shared'
import { ArrowDownTrayIcon, ChatBubbleLeftRightIcon, CheckIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { NotFound } from '../components/NotFound'
import { PageHeader } from '../components/PageHeader'
import { useInstance } from '../hooks/instance'
import { useResponses } from '../hooks/queries'
import { ApiError, api, errorMessage } from '../lib/api'
import { progressLabel, progressMatrix, siteProgress } from '../lib/forms'
import { reviewHref } from '../lib/review'
import { showToast } from '../lib/toast'

/** Save a blob as a file the browser downloads. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export default function Responses() {
  const { name = '' } = useParams()
  const instance = useInstance()
  const formsOn = instance?.capabilities.forms === true
  const responses = useResponses(name, formsOn && name !== '')
  const [saving, setSaving] = useState<ResponseExportFormat | null>(null)

  if (instance && !formsOn) return <NotFound />
  if (responses.isPending) {
    return (
      <div className="grid place-items-center py-12">
        <span
          className="loading loading-spinner loading-md text-muted"
          role="status"
          aria-label="Loading"
        />
      </div>
    )
  }
  if (responses.isError) {
    if (responses.error instanceof ApiError && responses.error.status === 404) return <NotFound />
    return (
      <div className="mx-auto max-w-5xl">
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(responses.error)}
          <button type="button" className="btn btn-sm" onClick={() => responses.refetch()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const data = responses.data
  const title = data.title
  const totals = siteProgress({ forms: data.forms }, data.progress)
  const heading = title
    ? totals
      ? progressLabel(title, totals.done, totals.total)
      : `${title} · ${data.responses.length}`
    : 'Responses'
  const download = async (format: ResponseExportFormat) => {
    setSaving(format)
    try {
      saveBlob(await api.downloadResponses(name, format), responsesFileName(name, title, format))
    } catch (error) {
      showToast(errorMessage(error), 'error')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        breadcrumbs={[{ to: '/', label: 'Sites' }]}
        title={heading}
        description={
          title ? (
            <>
              {data.responses.length === 1 ? '1 response' : `${data.responses.length} responses`} on{' '}
              <span className="font-mono">{name}</span>
            </>
          ) : (
            <>
              <span className="font-mono">{name}</span>’s live version has no forms.
            </>
          )
        }
        actions={
          <>
            <Link
              to={reviewHref(name)}
              className="btn btn-xs h-7 min-h-7 gap-1 px-2 text-sm font-normal tone-primary"
            >
              <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden /> Review
            </Link>
            {title &&
              (['csv', 'jsonl'] as const).map(format => (
                <button
                  key={format}
                  type="button"
                  className="btn btn-xs h-7 min-h-7 gap-1 px-2 text-sm font-normal"
                  disabled={saving !== null}
                  title={`Download ${responsesFileName(name, title, format)}`}
                  onClick={() => download(format)}
                >
                  {saving === format ? (
                    <span className="loading loading-spinner loading-xs" aria-hidden />
                  ) : (
                    <ArrowDownTrayIcon className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {format.toUpperCase()}
                </button>
              ))}
          </>
        }
      />
      {data.forms.map(form => {
        const progress = data.progress.find(p => p.form === form.id)
        return progress ? (
          <FormMatrix key={form.id} name={name} form={form} progress={progress} />
        ) : null
      })}
    </div>
  )
}

/** One form's page × reviewer matrix. */
function FormMatrix({
  name,
  form,
  progress,
}: {
  name: string
  form: FormDefinition
  progress: FormProgress
}) {
  const matrix = progressMatrix(progress)
  const titleId = `matrix-${form.id}`
  return (
    <section className="surface-panel space-y-3" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={titleId} className="text-base font-semibold">
          {form.title}
        </h2>
        <span className="text-sm text-secondary tabular-nums">
          {matrix.answered} / {matrix.rows.length} pages answered
        </span>
        <span className="text-xs text-muted">
          {form.kind === 'page' ? 'One response per reviewer per page' : 'A type of comment'}
          {form.visibility === 'own' ? ' · each reviewer sees only their own' : ''}
        </span>
      </div>
      {matrix.rows.length === 0 ? (
        <p className="text-sm text-secondary">It applies to none of the live version’s pages.</p>
      ) : (
        <div className="responses-matrix">
          <table className="table table-xs">
            <thead>
              <tr>
                <th scope="col">Page</th>
                {matrix.reviewers.map(r => (
                  <th key={r} scope="col" className="responses-reviewer" title={r}>
                    {r}
                  </th>
                ))}
                {matrix.reviewers.length === 0 && (
                  <th scope="col" className="font-normal text-muted">
                    No responses yet
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map(row => (
                <tr key={row.path}>
                  <th scope="row" className="font-mono font-normal">
                    <Link to={reviewHref(name, row.path)} className="link link-hover">
                      {row.path}
                    </Link>
                  </th>
                  {row.done.map((done, i) => {
                    const reviewer = matrix.reviewers[i] as string
                    return (
                      <td key={reviewer} className="text-center">
                        <Link
                          to={reviewHref(name, row.path)}
                          className={`responses-cell ${done ? 'is-done' : ''}`}
                          aria-label={`${row.path}: ${reviewer} ${done ? 'answered' : 'has not answered'}`}
                          title={`${reviewer} ${done ? 'answered' : 'has not answered'} on ${row.path}`}
                        >
                          {done && <CheckIcon className="h-3.5 w-3.5" aria-hidden />}
                        </Link>
                      </td>
                    )
                  })}
                  {matrix.reviewers.length === 0 && <td />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
