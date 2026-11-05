/**
 * Search over the Guide's pages, in the browser (every page is bundled), case- and
 * accent-insensitively. The pages that name what was typed come first: every word in the title or
 * summary, or the words as a phrase in the text. Only when none does, any page with every word
 * somewhere. Titles rank first, then summaries; ties keep nav order.
 */
import type { GuidePage } from '@fling/shared'

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const plain = (markdown: string) =>
  markdown
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[`*_#>[\]()|]/g, ' ')

export function searchGuide(pages: readonly GuidePage[], query: string): GuidePage[] {
  const phrase = fold(query).trim().replace(/\s+/g, ' ')
  const terms = phrase.split(' ').filter(Boolean)
  if (terms.length === 0) return [...pages]
  const scored = pages.map((page, i) => {
    const title = fold(page.meta.title)
    const head = `${title} ${fold(page.meta.summary)}`
    const text = fold(plain(page.body)).replace(/\s+/g, ' ')
    const rank = terms.every(t => title.includes(t))
      ? 0
      : terms.every(t => head.includes(t))
        ? 1
        : text.includes(phrase)
          ? 2
          : terms.every(t => text.includes(t))
            ? 3
            : 4
    return { page, rank, i }
  })
  const named = scored.filter(s => s.rank < 3)
  const found = named.length > 0 ? named : scored.filter(s => s.rank === 3)
  return found.sort((a, b) => a.rank - b.rank || a.i - b.i).map(s => s.page)
}
