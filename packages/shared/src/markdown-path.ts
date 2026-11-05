/**
 * Which site paths are Markdown, the files Fling serves rendered (markdown.ts), and which of them
 * stands in as a folder's home page. Kept apart from the renderer so clients can ask without
 * bundling it.
 */

export const MARKDOWN_EXTENSION = /\.(md|markdown)$/i

/** Whether a site path is a Markdown file (`.md` or `.markdown`, any case). */
export const isMarkdownPath = (path: string): boolean => MARKDOWN_EXTENSION.test(path)

const HOME_PAGE_NAMES = [/^index\.(md|markdown)$/i, /^readme\.(md|markdown)$/i]

/**
 * For a version's files (site-relative, no leading slash), the folders that have no `index.html`
 * but have Markdown to stand in for one, mapped to that Markdown file's path. A folder is one that
 * directly holds a file; the root is `''`, others have no trailing slash (`docs/guide`). The
 * stand-in is `index.md`, else `README.md` (either name in any case, `.md` or `.markdown`), else
 * the folder's only Markdown file.
 */
export function markdownHomePages(files: readonly string[]): Map<string, string> {
  const folders = new Map<string, string[]>()
  for (const path of files) {
    const slash = path.lastIndexOf('/')
    const folder = slash === -1 ? '' : path.slice(0, slash)
    const names = folders.get(folder) ?? []
    names.push(path.slice(slash + 1))
    folders.set(folder, names)
  }
  const pages = new Map<string, string>()
  for (const [folder, names] of folders) {
    if (names.includes('index.html')) continue
    const markdown = names.filter(isMarkdownPath).sort()
    const chosen =
      HOME_PAGE_NAMES.map(pattern => markdown.find(name => pattern.test(name))).find(Boolean) ??
      (markdown.length === 1 ? markdown[0] : undefined)
    if (chosen) pages.set(folder, folder ? `${folder}/${chosen}` : chosen)
  }
  return pages
}
