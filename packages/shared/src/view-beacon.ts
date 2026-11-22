/**
 * The view beacon: a small script a version whose pages count views has in each HTML page's copy
 * (`.counted/<path>`, rendering.ts) and in the pages Fling renders for it (Markdown, the Paths home
 * page). Once per page load it posts to SITE_SEEN_PATH on the site's own host, which the platform
 * counts (views.ts). It sends nothing but the request: no cookie of its own, no identifier, no
 * page address.
 *
 * What it leaves out: a page being prerendered counts once it is shown, never before; a page in
 * a frame of its own site (the review shell and the app's previews frame sites that way, and so
 * may a site's own pages) does not count, while a site embedded in another site's page does. A
 * single-page app counts its first load, not its navigations.
 */
import { SITE_SEEN_PATH } from './route-keys.ts'

/** The `<script>` the copies carry. */
export const VIEW_BEACON = `<script>(function(){function f(){try{if(window.parent!==window&&window.parent.location.host===location.host)return}catch(e){}try{navigator.sendBeacon(${JSON.stringify(SITE_SEEN_PATH)})}catch(e){}}if(document.prerendering)document.addEventListener("prerenderingchange",f,{once:true});else f()})()</script>`

/** `html` with the beacon before its last `</body>`, else at its end. */
export function withViewBeacon(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>')
  if (at === -1) return html + VIEW_BEACON
  return html.slice(0, at) + VIEW_BEACON + html.slice(at)
}
