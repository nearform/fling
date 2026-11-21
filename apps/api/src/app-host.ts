/**
 * The app host of a platform where one host routes (the Cloudflare Worker, the Node host): which
 * paths the API answers, and the headers the web UI is served with, so the UI behaves as it does
 * behind the AWS app distribution (deploy.yml's cache headers, CloudFront's managed
 * SecurityHeadersPolicy).
 */

/**
 * The app paths the API answers (the rest is the web UI): the AWS module's `api_paths`, plus
 * `/dev/`, which the API mounts only with the dev login on.
 */
export function isApiPath(path: string): boolean {
  return (
    path === '/healthz' ||
    path === '/mcp' ||
    ['/api/', '/auth/', '/mcp/', '/oauth/', '/.well-known/', '/notifications/', '/dev/'].some(p =>
      path.startsWith(p)
    )
  )
}

/** The headers CloudFront's managed SecurityHeadersPolicy adds to the UI on AWS. */
export const UI_SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-xss-protection': '1; mode=block',
}

/** The Claude Desktop extension, served for download from the UI. */
export const MCPB_PATH = '/downloads/fling.mcpb'

/**
 * The headers a UI file is served with: `index.html` (every client-side route) revalidates,
 * content-hashed `/assets/` are immutable, the rest is kept five minutes; the extension downloads
 * as a file. Strict-Transport-Security only over https.
 */
export function uiHeaders(path: string, contentType: string, https: boolean): Headers {
  const headers = new Headers()
  if (contentType.startsWith('text/html')) headers.set('cache-control', 'no-cache')
  else if (path.startsWith('/assets/')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable')
  } else headers.set('cache-control', 'public, max-age=300')
  if (path === MCPB_PATH) {
    headers.set('content-type', 'application/octet-stream')
    headers.set('content-disposition', 'attachment; filename="fling.mcpb"')
  }
  for (const [name, value] of Object.entries(UI_SECURITY_HEADERS)) {
    if (https || name !== 'strict-transport-security') headers.set(name, value)
  }
  return headers
}
