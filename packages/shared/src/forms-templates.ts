// Starter forms configs (forms.ts) for the CLI's `fling forms init` and the MCP servers'
// `fling_forms_template`, written once so every client offers the same ones. Each uses readable,
// typed `oneOf` options (`const` for the stored value, `title` for what reviewers read),
// `required` for what must be answered, and radio widgets for short choices. Browser-safe.

import type { FormsConfig } from './forms.ts'

export const FORM_TEMPLATE_NAMES = ['labels', 'rubric', 'compare', 'issue', 'survey'] as const
export type FormTemplateName = (typeof FORM_TEMPLATE_NAMES)[number]

/** What each template collects, for help text and tool descriptions. */
export const FORM_TEMPLATE_DESCRIPTIONS: Record<FormTemplateName, string> = {
  labels: 'a verdict per page plus notes; each reviewer sees only their own (blind labelling)',
  rubric: 'several criteria scored 1 to 5, each with what the score means, per page',
  compare: 'a preference between A and B (or a tie) and the reason, per page',
  issue: 'a comment type for flagging a passage: severity and category',
  survey: 'free-form questions answered once per page',
}

const score = (title: string, description: string) => ({
  title,
  description,
  type: 'integer',
  oneOf: [
    { const: 1, title: '1: poor' },
    { const: 2, title: '2: weak' },
    { const: 3, title: '3: adequate' },
    { const: 4, title: '4: good' },
    { const: 5, title: '5: excellent' },
  ],
})

const TEMPLATES: Record<FormTemplateName, FormsConfig> = {
  labels: {
    title: 'Labels',
    forms: [
      {
        id: 'label',
        title: 'Label this page',
        kind: 'page',
        visibility: 'own',
        schema: {
          type: 'object',
          required: ['verdict'],
          properties: {
            verdict: {
              title: 'Verdict',
              type: 'string',
              oneOf: [
                { const: 'pass', title: 'Pass: it does what it should' },
                { const: 'partial', title: 'Partial: some of it is right' },
                { const: 'fail', title: 'Fail: it gets it wrong' },
              ],
            },
            notes: { type: 'string', title: 'Notes', maxLength: 2000 },
          },
        },
        uiSchema: { verdict: { 'ui:widget': 'radio' }, notes: { 'ui:widget': 'textarea' } },
      },
    ],
  },
  rubric: {
    title: 'Scores',
    forms: [
      {
        id: 'rubric',
        title: 'Score this page',
        kind: 'page',
        visibility: 'everyone',
        schema: {
          type: 'object',
          required: ['accuracy', 'clarity', 'completeness'],
          properties: {
            accuracy: score('Accuracy', 'Is what it says correct?'),
            clarity: score('Clarity', 'Could the intended reader follow it first time?'),
            completeness: score('Completeness', 'Does it cover everything it needs to?'),
            notes: { type: 'string', title: 'Notes', maxLength: 2000 },
          },
        },
        uiSchema: {
          accuracy: { 'ui:widget': 'radio', 'ui:options': { inline: true } },
          clarity: { 'ui:widget': 'radio', 'ui:options': { inline: true } },
          completeness: { 'ui:widget': 'radio', 'ui:options': { inline: true } },
          notes: { 'ui:widget': 'textarea' },
        },
      },
    ],
  },
  compare: {
    title: 'Comparison',
    forms: [
      {
        id: 'compare',
        title: 'Which is better?',
        kind: 'page',
        visibility: 'own',
        schema: {
          type: 'object',
          required: ['preference', 'reason'],
          properties: {
            preference: {
              title: 'Preference',
              type: 'string',
              oneOf: [
                { const: 'a', title: 'A is better' },
                { const: 'tie', title: 'About the same' },
                { const: 'b', title: 'B is better' },
              ],
            },
            reason: { type: 'string', title: 'Why?', minLength: 1, maxLength: 2000 },
          },
        },
        uiSchema: { preference: { 'ui:widget': 'radio' }, reason: { 'ui:widget': 'textarea' } },
      },
    ],
  },
  issue: {
    title: 'Issues',
    forms: [
      {
        id: 'issue',
        title: 'Flag an issue',
        kind: 'comment',
        visibility: 'everyone',
        schema: {
          type: 'object',
          required: ['severity', 'category'],
          properties: {
            severity: {
              title: 'Severity',
              type: 'string',
              oneOf: [
                { const: 'blocker', title: 'Blocker: must fix before release' },
                { const: 'major', title: 'Major: should fix' },
                { const: 'minor', title: 'Minor: fix if there is time' },
              ],
            },
            category: {
              title: 'Category',
              type: 'string',
              oneOf: [
                { const: 'accuracy', title: 'Wrong or misleading' },
                { const: 'clarity', title: 'Hard to follow' },
                { const: 'tone', title: 'Wrong tone' },
                { const: 'other', title: 'Something else' },
              ],
            },
            details: { type: 'string', title: 'Details', maxLength: 2000 },
          },
        },
        uiSchema: {
          severity: { 'ui:widget': 'radio' },
          category: { 'ui:widget': 'radio' },
          details: { 'ui:widget': 'textarea' },
        },
      },
    ],
  },
  survey: {
    title: 'Feedback',
    forms: [
      {
        id: 'survey',
        title: 'Your feedback',
        kind: 'page',
        visibility: 'everyone',
        schema: {
          type: 'object',
          required: ['useful'],
          properties: {
            useful: {
              title: 'Was this page useful?',
              type: 'string',
              oneOf: [
                { const: 'yes', title: 'Yes' },
                { const: 'somewhat', title: 'Somewhat' },
                { const: 'no', title: 'No' },
              ],
            },
            liked: { type: 'string', title: 'What worked well?', maxLength: 2000 },
            improve: { type: 'string', title: 'What would you change?', maxLength: 2000 },
          },
        },
        uiSchema: {
          useful: { 'ui:widget': 'radio' },
          liked: { 'ui:widget': 'textarea' },
          improve: { 'ui:widget': 'textarea' },
        },
      },
    ],
  },
}

/** A fresh copy of a template, with `title` as the config's title when given. */
export function formsTemplate(name: FormTemplateName, title?: string): FormsConfig {
  const config = structuredClone(TEMPLATES[name])
  return title?.trim() ? { ...config, title: title.trim() } : config
}

export const isFormTemplateName = (name: string): name is FormTemplateName =>
  (FORM_TEMPLATE_NAMES as readonly string[]).includes(name)
