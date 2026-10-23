/**
 * The CLI's look: the FLING logo (a left-to-right gradient with motion trails), brand colours,
 * symbols and a box for the URL a deploy hands back. Everything degrades to plain text when chalk
 * has no colour (NO_COLOR, pipes).
 */
import chalk from 'chalk'

/** Gradient stops, left to right: cyan → violet → pink. */
const STOPS: readonly [number, number, number][] = [
  [0x00, 0xe5, 0xff],
  [0x7c, 0x4d, 0xff],
  [0xff, 0x4e, 0xcd],
]

const WORDMARK = [
  '███████╗██╗     ██╗███╗   ██╗ ██████╗ ',
  '██╔════╝██║     ██║████╗  ██║██╔════╝ ',
  '█████╗  ██║     ██║██╔██╗ ██║██║  ███╗',
  '██╔══╝  ██║     ██║██║╚██╗██║██║   ██║',
  '██║     ███████╗██║██║ ╚████║╚██████╔╝',
  '╚═╝     ╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ',
]

/** Speed lines to the left of the wordmark: it has just been flung. */
const TRAILS = ['      ', '  ━━━ ', ' ━━━━ ', '   ━━ ', '      ', '      ']

const LOGO_WIDTH = TRAILS[0].length + WORDMARK[0].length

export const brand = {
  primary: chalk.hex('#7C4DFF'),
  accent: chalk.hex('#00E5FF'),
  url: (url: string) => chalk.bold.hex('#00E5FF')(url),
}

export const symbols = {
  info: chalk.hex('#7C4DFF')('◆'),
  success: chalk.green('✔'),
  warn: chalk.yellow('▲'),
  error: chalk.red('✖'),
  step: chalk.dim('│'),
}

function colourAt(t: number): [number, number, number] {
  const scaled = Math.min(Math.max(t, 0), 1) * (STOPS.length - 1)
  const i = Math.min(Math.floor(scaled), STOPS.length - 2)
  const f = scaled - i
  const a = STOPS[i] as [number, number, number]
  const b = STOPS[i + 1] as [number, number, number]
  return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number]
}

/** Colour each character of `text` along the gradient (position `offset` of `width`). */
export function gradient(text: string, width = text.length, offset = 0): string {
  if (chalk.level === 0) return text
  return [...text]
    .map((ch, i) => (ch === ' ' ? ch : chalk.rgb(...colourAt((offset + i) / (width - 1)))(ch)))
    .join('')
}

/**
 * The logo with a tagline, or a one-line wordmark when the terminal is too narrow for the big one.
 */
export function logo(options: { columns?: number; tagline?: string } = {}): string {
  const columns = options.columns || process.stderr.columns || 80
  const tagline = options.tagline ?? 'throw static files at the web, get a link back'
  if (columns < LOGO_WIDTH + 2) return `${gradient('▶▶ fling')}  ${chalk.dim(tagline)}`
  const lines = WORDMARK.map(
    (row, i) => chalk.dim(TRAILS[i] ?? '') + gradient(row, WORDMARK[0].length)
  )
  return ['', ...lines, `${' '.repeat(TRAILS[0].length)}${chalk.dim(tagline)}`, ''].join('\n')
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const ANSI = /\x1b\[[0-9;]*m/g
const visibleLength = (s: string) => s.replace(ANSI, '').length

/** A rounded box around `lines`, with an optional title in the top border. */
export function box(lines: readonly string[], title?: string): string {
  const width = Math.max(...lines.map(visibleLength), title ? visibleLength(title) + 2 : 0)
  const border = chalk.dim
  const top = title
    ? `${border('╭─')} ${title} ${border(`${'─'.repeat(width - visibleLength(title) - 1)}╮`)}`
    : border(`╭${'─'.repeat(width + 2)}╮`)
  const body = lines.map(
    line => `${border('│')} ${line}${' '.repeat(width - visibleLength(line))} ${border('│')}`
  )
  return [top, ...body, border(`╰${'─'.repeat(width + 2)}╯`)].join('\n')
}
