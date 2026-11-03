/**
 * One form of a site's forms config, rendered from its JSON Schema and UI schema by
 * react-jsonschema-form with its DaisyUI theme, so it takes the instance's theme in light and dark.
 * The review page loads this module lazily (`LazyResponseForm` in `components/review/Forms.tsx`):
 * the renderer and its validator are most of the forms feature's weight, and only sites with forms
 * need them.
 *
 * The browser checks the data against the schema with Ajv on draft 2020-12, the draft the server
 * validates against, so most mistakes show before a request; the server has the last word, and
 * the field errors of its `invalid_response` come back in `errors` and show under their fields.
 * The form's title is the caller's to show (a section heading, the composer's type picker), so the
 * schema's root title is left out, and choices written without a `type` get one
 * (`renderableSchema`). The buttons are the caller's too (`children`).
 */
import type { FieldError, FormDefinition } from '@fling/shared'
import type { IChangeEvent, ThemeProps } from '@rjsf/core'
import { withTheme } from '@rjsf/core'
import { Templates, Theme } from '@rjsf/daisyui'
import type {
  DescriptionFieldProps,
  ErrorSchema,
  FieldErrorProps,
  FieldHelpProps,
  ObjectFieldTemplateProps,
  RJSFSchema,
  RJSFValidationError,
  TitleFieldProps,
  UiSchema,
} from '@rjsf/utils'
import { errorId, helpId } from '@rjsf/utils'
import { customizeValidator } from '@rjsf/validator-ajv8'
import Ajv2020 from 'ajv/dist/2020'
import { type ReactNode, useMemo, useState } from 'react'
import { errorTree, renderableSchema } from '../lib/forms'

type Data = Record<string, unknown>

const validator = customizeValidator<Data>({
  AjvClass: Ajv2020 as unknown as NonNullable<Parameters<typeof customizeValidator>[0]>['AjvClass'],
})

/** A nested object's heading: quiet, sized for the side panel. */
function TitleField({ id, title }: TitleFieldProps<Data>) {
  return (
    <p id={id} className="text-sm font-semibold">
      {title}
    </p>
  )
}

function DescriptionField({ id, description }: DescriptionFieldProps<Data>) {
  if (!description) return null
  return (
    <div id={id} className="text-xs text-secondary">
      {description}
    </div>
  )
}

function FieldErrors({ errors, fieldPathId }: FieldErrorProps<Data>) {
  if (!errors?.length) return null
  return (
    <ul id={errorId(fieldPathId)} className="response-form-errors text-xs">
      {errors.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: messages may repeat and never reorder
        <li key={i}>{e}</li>
      ))}
    </ul>
  )
}

function FieldHelp({ help, fieldPathId }: FieldHelpProps<Data>) {
  if (!help) return null
  return (
    <div id={helpId(fieldPathId)} className="text-xs text-muted">
      {help}
    </div>
  )
}

const NestedObject = Templates.ObjectFieldTemplate as (
  props: ObjectFieldTemplateProps<Data>
) => ReactNode

/** The root object as a plain stack of fields (the theme's is a raised card); nested ones as themed. */
function ObjectField(props: ObjectFieldTemplateProps<Data>) {
  if (props.fieldPathId.path.length > 0) {
    return <NestedObject {...props} />
  }
  return (
    <div className="grid gap-3">
      {props.description && <div className="text-xs text-secondary">{props.description}</div>}
      {props.properties.map(p => (p.hidden ? p.content : <div key={p.name}>{p.content}</div>))}
    </div>
  )
}

/** A missing answer says so under its own field, in the server's words. */
const sayRequired = (errors: RJSFValidationError[]) =>
  errors.map(e => (e.name === 'required' ? { ...e, message: 'is required' } : e))

const Form = withTheme<Data>({
  ...(Theme as ThemeProps<Data>),
  templates: {
    ...(Theme as ThemeProps<Data>).templates,
    TitleFieldTemplate: TitleField,
    DescriptionFieldTemplate: DescriptionField,
    FieldErrorTemplate: FieldErrors,
    FieldHelpTemplate: FieldHelp,
    ObjectFieldTemplate: ObjectField,
  },
})

export interface ResponseFormProps {
  form: FormDefinition
  /** the answers to start from (my earlier response) */
  data?: Data
  /** unique on the page: field ids start with it */
  idPrefix: string
  /** the server's field errors for the last submission */
  errors?: readonly FieldError[]
  disabled?: boolean
  onSubmit: (data: Data) => void
  /** the data changed (the caller drops stale server errors) */
  onChange?: (data: Data) => void
  /** the buttons, inside the form: a `type="submit"` one submits */
  children: ReactNode
}

export default function ResponseForm({
  form,
  data,
  idPrefix,
  errors,
  disabled,
  onSubmit,
  onChange,
  children,
}: ResponseFormProps) {
  const [formData, setFormData] = useState<Data>(() => data ?? {})
  const schema = useMemo(() => renderableSchema(form.schema) as RJSFSchema, [form.schema])
  const extraErrors = useMemo(
    () => (errors?.length ? (errorTree(errors) as ErrorSchema<Data>) : undefined),
    [errors]
  )
  return (
    <Form
      className="response-form"
      idPrefix={idPrefix}
      schema={schema}
      uiSchema={(form.uiSchema ?? {}) as UiSchema<Data>}
      validator={validator}
      formData={formData}
      disabled={disabled}
      // A choice's first option is never an answer the reviewer didn't give.
      experimental_defaultFormStateBehavior={{ constAsDefaults: 'never' }}
      showErrorList={false}
      transformErrors={sayRequired}
      noHtml5Validate
      focusOnFirstError
      {...(extraErrors ? { extraErrors } : {})}
      onChange={(e: IChangeEvent<Data>) => {
        const next = e.formData ?? {}
        setFormData(next)
        onChange?.(next)
      }}
      onSubmit={(e: IChangeEvent<Data>) => onSubmit(e.formData ?? {})}
    >
      {children}
    </Form>
  )
}
