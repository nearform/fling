/**
 * The view beacon: a small script a version whose pages count views has in each HTML page's copy
 * (`.counted/<path>`, rendering.ts) and in the pages Fling renders for it (Markdown, the Paths home
 * page). Once per page load it posts to SITE_SEEN_PATH on the site's own host, which the platform
 * counts (views.ts). It sends nothing but the request: no cookie of its own, no identifier, no
 * page address.
 *
 * What it leaves out: a page being prerendered counts once it is shown, never before; a page in
 * a frame of its own site (the review shell frames sites that way, and so may a site's own pages)
 * does not post, while a site embedded in another site's page does. A single-page app counts its
 * first load, not its navigations.
 *
 * Review mode counts all the same: the review shell posts SITE_SEEN_PATH itself for each page it
 * frames that carries the beacon (`carriesViewBeacon`), once per load of the frame, and never in
 * preview mode (the site page's preview tile). The shell decides rather than the beacon because
 * the shell knows its own mode and is served fresh on every host, while the beacon is baked into
 * each live version's copies at go-live, so a change to it would reach a site only when it is
 * published again. The beacon's frame skip is what keeps a review-mode load to one view, not two.
 * The shell's post is the same request as the beacon's, from the same host, so it passes the same
 * routing decision and access checks and records nothing more.
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

/**
 * Whether a page carries the view beacon, from its `<script>`s: the pages a load counts a view for,
 * which the review shell reads off each page it frames. Any script posting to SITE_SEEN_PATH
 * counts, so a copy made with an earlier beacon still does.
 */
export function carriesViewBeacon(scripts: ArrayLike<{ textContent: string | null }>): boolean {
  const target = JSON.stringify(SITE_SEEN_PATH)
  for (let i = 0; i < scripts.length; i++) {
    if (scripts[i]?.textContent?.includes(target)) return true
  }
  return false
}
