// The JSON Schema draft 2020-12 metaschema as one self-contained schema, for checking a form's
// schema (forms.ts, `checkFormSchema`). Browser-safe, no dependencies.
//
// The published metaschema splits into vocabularies that point back at the whole with
// `$dynamicRef: "#meta"`, which @cfworker/json-schema does not support. Here the vocabularies
// (core, applicator, unevaluated, validation, meta-data, format-annotation, content, and the
// deprecated keywords the published one still accepts) are merged into one object and every
// `$dynamicRef: "#meta"` is a plain `$ref: "#"`. Without extended metaschemas the two accept the
// same schemas.

const meta = { $ref: '#' } as const

export const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

export const METASCHEMA_2020_12 = {
  $schema: JSON_SCHEMA_2020_12,
  type: ['object', 'boolean'],
  properties: {
    // core
    $id: { $ref: '#/$defs/uriReferenceString', pattern: '^[^#]*#?$' },
    $schema: { $ref: '#/$defs/uriString' },
    $ref: { $ref: '#/$defs/uriReferenceString' },
    $anchor: { $ref: '#/$defs/anchorString' },
    $dynamicRef: { $ref: '#/$defs/uriReferenceString' },
    $dynamicAnchor: { $ref: '#/$defs/anchorString' },
    $vocabulary: {
      type: 'object',
      propertyNames: { $ref: '#/$defs/uriString' },
      additionalProperties: { type: 'boolean' },
    },
    $comment: { type: 'string' },
    $defs: { type: 'object', additionalProperties: meta },
    // applicator
    prefixItems: { $ref: '#/$defs/schemaArray' },
    items: meta,
    contains: meta,
    additionalProperties: meta,
    properties: { type: 'object', additionalProperties: meta },
    patternProperties: {
      type: 'object',
      additionalProperties: meta,
      propertyNames: { format: 'regex' },
    },
    dependentSchemas: { type: 'object', additionalProperties: meta },
    propertyNames: meta,
    if: meta,
    // biome-ignore lint/suspicious/noThenProperty: the JSON Schema keyword
    then: meta,
    else: meta,
    allOf: { $ref: '#/$defs/schemaArray' },
    anyOf: { $ref: '#/$defs/schemaArray' },
    oneOf: { $ref: '#/$defs/schemaArray' },
    not: meta,
    // unevaluated
    unevaluatedItems: meta,
    unevaluatedProperties: meta,
    // validation
    type: {
      anyOf: [
        { $ref: '#/$defs/simpleTypes' },
        { type: 'array', items: { $ref: '#/$defs/simpleTypes' }, minItems: 1, uniqueItems: true },
      ],
    },
    const: true,
    enum: { type: 'array', items: true },
    multipleOf: { type: 'number', exclusiveMinimum: 0 },
    maximum: { type: 'number' },
    exclusiveMaximum: { type: 'number' },
    minimum: { type: 'number' },
    exclusiveMinimum: { type: 'number' },
    maxLength: { $ref: '#/$defs/nonNegativeInteger' },
    minLength: { $ref: '#/$defs/nonNegativeInteger' },
    pattern: { type: 'string', format: 'regex' },
    maxItems: { $ref: '#/$defs/nonNegativeInteger' },
    minItems: { $ref: '#/$defs/nonNegativeInteger' },
    uniqueItems: { type: 'boolean' },
    maxContains: { $ref: '#/$defs/nonNegativeInteger' },
    minContains: { $ref: '#/$defs/nonNegativeInteger' },
    maxProperties: { $ref: '#/$defs/nonNegativeInteger' },
    minProperties: { $ref: '#/$defs/nonNegativeInteger' },
    required: { $ref: '#/$defs/stringArray' },
    dependentRequired: { type: 'object', additionalProperties: { $ref: '#/$defs/stringArray' } },
    // meta-data
    title: { type: 'string' },
    description: { type: 'string' },
    default: true,
    deprecated: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    writeOnly: { type: 'boolean' },
    examples: { type: 'array', items: true },
    // format-annotation
    format: { type: 'string' },
    // content
    contentEncoding: { type: 'string' },
    contentMediaType: { type: 'string' },
    contentSchema: meta,
    // deprecated, still accepted by the published metaschema
    definitions: { type: 'object', additionalProperties: meta },
    dependencies: {
      type: 'object',
      additionalProperties: { anyOf: [meta, { $ref: '#/$defs/stringArray' }] },
    },
    $recursiveAnchor: { $ref: '#/$defs/anchorString' },
    $recursiveRef: { $ref: '#/$defs/uriReferenceString' },
  },
  $defs: {
    anchorString: { type: 'string', pattern: '^[A-Za-z_][-A-Za-z0-9._]*$' },
    uriString: { type: 'string', format: 'uri' },
    uriReferenceString: { type: 'string', format: 'uri-reference' },
    schemaArray: { type: 'array', minItems: 1, items: meta },
    nonNegativeInteger: { type: 'integer', minimum: 0 },
    simpleTypes: { enum: ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'] },
    stringArray: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  },
} as const
