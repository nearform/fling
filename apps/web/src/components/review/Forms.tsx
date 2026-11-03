/**
 * The review page's forms (the `forms` capability): the tab of page-kind forms beside the comments,
 * named after the config's title, with the reviewer's progress over the site; a response shown as
 * its answers (`ResponseView`, in threads and in the tab); and the form renderer, loaded only when
 * a form is shown (`LazyResponseForm`).
 */
import {
  authorLabel,
  type Comment,
  type FieldError,
  type FormDefinition,
  type FormsConfig,
  responseFields,
} from '@fling/shared'
import { ArrowRightIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { lazy, Suspense, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInstance } from '../../hooks/instance'
import { useCommentActions, useForms, useResponses } from '../../hooks/queries'
import { ApiError } from '../../lib/api'
import { fullDate, timeAgo } from '../../lib/format'
import {
  formsOfKind,
  type MyProgress,
  nextPending,
  progressLabel,
  responsesHref,
  responsesTo,
  siteProgress,
} from '../../lib/forms'
import { showToast } from '../../lib/toast'
import type { ResponseFormProps } from '../ResponseForm'

const ResponseForm = lazy(() => import('../ResponseForm'))

/** The form renderer, with a spinner while its module loads. */
export function LazyResponseForm(props: ResponseFormProps) {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-4">
          <span
            className="loading loading-spinner loading-sm text-muted"
            role="status"
            aria-label="Loading the form"
          />
        </div>
      }
    >
      <ResponseForm {...props} />
    </Suspense>
  )
}

/**
 * The link to a site's progress view, named after its forms config ("Labels · 12 / 51": pages
 * where every page-kind form has a response). Nothing when the instance or the site has no forms.
 */
export function ResponsesLink({ name, className }: { name: string; className: string }) {
  const on = useInstance()?.capabilities.forms === true
  const config = useForms(name, on).data?.config ?? null
  const responses = useResponses(name, config !== null)
  if (!config) return null
  const totals = responses.data ? siteProgress(config, responses.data.progress) : null
  return (
    <Link to={responsesHref(name)} className={className}>
      {totals ? progressLabel(config.title, totals.done, totals.total) : config.title}
    </Link>
  )
}

/** A response's answers, labelled with the schema's titles, in its order. */
export function ResponseView({
  form,
  data,
  showTitle = false,
}: {
  form: Pick<FormDefinition, 'title' | 'schema'>
  data: Record<string, unknown>
  showTitle?: boolean
}) {
  const fields = responseFields(form, data)
  return (
    <div className="grid gap-1">
      {showTitle && <p className="text-xs font-medium text-secondary">{form.title}</p>}
      {fields.length === 0 ? (
        <p className="text-sm text-muted">No answers</p>
      ) : (
        <dl className="response-view">
          {fields.map(f => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd className="review-text">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * The forms tab: my progress over the site and the way to the next page waiting for my response,
 * then each page-kind form that applies to this page, prefilled with my response, and the others'
 * responses the server lets me see.
 */
export function FormsPanel({
  name,
  config,
  path,
  pageResponses,
  email,
  canCreate,
  progress,
  onGo,
}: {
  name: string
  config: FormsConfig
  path: string
  pageResponses: readonly Comment[]
  email: string | null | undefined
  canCreate: boolean
  progress: MyProgress | null
  onGo: (path: string) => void
}) {
  const forms = formsOfKind(config, path, 'page')
  const next = progress ? nextPending(progress.pending, path) : null
  const total = progress?.pages.length ?? 0
  const done = progress?.done.length ?? 0
  return (
    <div className="grid grid-cols-1 gap-3">
      {progress && total > 0 && (
        <div className="surface-panel grid grid-cols-1 gap-2 !p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span>
              <span className="font-semibold tabular-nums">
                {done} / {total}
              </span>{' '}
              pages done
            </span>
            <Link to={responsesHref(name)} className="link ms-auto text-xs">
              {config.title}: everyone’s
            </Link>
          </div>
          <progress
            className="progress progress-primary w-full"
            value={done}
            max={total}
            aria-label={`${done} of ${total} pages have your response`}
          />
          {next ? (
            <button type="button" className="btn btn-sm" onClick={() => onGo(next)}>
              Next page without a response
              <ArrowRightIcon className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            done === total && (
              <p className="flex items-center gap-1.5 text-sm text-secondary">
                <CheckCircleIcon className="h-4 w-4" aria-hidden /> Every page has your response
              </p>
            )
          )}
        </div>
      )}
      {forms.length === 0 ? (
        <p className="py-6 text-center text-sm text-secondary">
          Nothing to answer on <span className="font-mono">{path}</span>.
        </p>
      ) : (
        forms.map(form => (
          <PageForm
            key={`${form.id}\u0000${path}`}
            name={name}
            form={form}
            path={path}
            heading={forms.length > 1}
            canCreate={canCreate}
            // With one form on the page, saving can move straight on to the next page to answer.
            {...(forms.length === 1 && next ? { onNext: () => onGo(next) } : {})}
            {...responsesTo(pageResponses, { formId: form.id, path, email })}
          />
        ))
      )}
    </div>
  )
}

function PageForm({
  name,
  form,
  path,
  heading,
  canCreate,
  onNext,
  mine,
  others,
}: {
  name: string
  form: FormDefinition
  path: string
  heading: boolean
  canCreate: boolean
  /** go to the next page without a response, after "Save and next" */
  onNext?: () => void
  mine: Comment | undefined
  others: Comment[]
}) {
  const actions = useCommentActions(name)
  const [errors, setErrors] = useState<FieldError[]>([])
  // Which submit button sent the form: the form library hands only the data to onSubmit.
  const advance = useRef(false)
  const titleId = `form-${form.id}-title`
  const changed = mine?.updatedAt ?? mine?.createdAt
  return (
    <section className="surface-panel grid grid-cols-1 gap-3 !p-3" aria-labelledby={titleId}>
      <h3 id={titleId} className={heading ? 'text-sm font-semibold' : 'sr-only'}>
        {form.title}
      </h3>
      {canCreate ? (
        <LazyResponseForm
          // A new response (mine saved, here or elsewhere) starts the form again from it.
          key={`${mine?.id}\u0000${changed}`}
          form={form}
          {...(mine?.response ? { data: mine.response.data } : {})}
          idPrefix={`page-${form.id}`}
          errors={errors}
          disabled={actions.respond.isPending}
          onChange={() => setErrors(e => (e.length ? [] : e))}
          onSubmit={data =>
            actions.respond.mutate(
              { path, response: { formId: form.id, data } },
              {
                onSuccess: () => {
                  showToast(`Saved: ${form.title}`, 'success')
                  if (advance.current) onNext?.()
                },
                onError: e => setErrors(e instanceof ApiError ? e.fieldErrors : []),
              }
            )
          }
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">
              {changed ? (
                <time dateTime={changed} title={fullDate(changed)}>
                  Saved {timeAgo(changed)}
                </time>
              ) : (
                'Not answered yet'
              )}
            </span>
            <span className="ms-auto flex gap-1">
              {onNext && (
                <button
                  type="submit"
                  className="btn btn-ghost btn-sm"
                  disabled={actions.respond.isPending}
                  onClick={() => {
                    advance.current = false
                  }}
                >
                  Save
                </button>
              )}
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={actions.respond.isPending}
                onClick={() => {
                  advance.current = onNext !== undefined
                }}
              >
                {onNext ? 'Save and next' : 'Save'}
                {onNext && <ArrowRightIcon className="h-4 w-4" aria-hidden />}
              </button>
            </span>
          </div>
        </LazyResponseForm>
      ) : mine?.response ? (
        <ResponseView form={form} data={mine.response.data} />
      ) : (
        <p className="text-sm text-secondary">You have not answered this.</p>
      )}
      {others.length > 0 && (
        <details className="response-others">
          <summary className="cursor-pointer text-xs text-secondary">
            {others.length === 1 ? '1 other response' : `${others.length} other responses`}
          </summary>
          <ol className="mbs-2 grid gap-2">
            {others.map(c => (
              <li key={c.id} className="surface-inset grid gap-1 p-2">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-0 truncate font-medium">{authorLabel(c.author)}</span>
                  <time
                    className="ms-auto shrink-0 text-muted"
                    dateTime={c.updatedAt ?? c.createdAt}
                    title={fullDate(c.updatedAt ?? c.createdAt)}
                  >
                    {timeAgo(c.updatedAt ?? c.createdAt)}
                  </time>
                </div>
                {c.response && <ResponseView form={form} data={c.response.data} />}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
