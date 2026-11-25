---
title: Visitors, reviews and limits
part: servers
order: 50
summary: Who can call a site's server, what it knows about them, and the limits it runs within.
requires: [servers]
sources: [packages/shared/src/site-routing.ts, packages/shared/src/site-server.ts, apps/api/src/servers/shell.ts, apps/api/src/servers/index.ts, apps/api/src/config.ts, apps/api/src/deletion.ts, apps/web/src/pages/Review.tsx, apps/web/src/components/site/SiteServer.tsx]
verified: 0a10243
---

A site's server sits behind the site's access, like its pages. It learns who is calling from
{{instance:name}}, never from the browser, and runs within limits that keep one site from slowing
the others.

## Who can call it

**The same people who can open the site.** A request to `/api/…` passes every check a page does
before the server sees it. On a site that needs sign-in, someone who hasn't signed in is sent to
sign in, as for a page; a site that is [only for you](/guide/share/who-can-open) has an API only
for you.

**Anyone, on a public site or through a [share link](/guide/share/share-links).** Anyone can then
call `/api/…` directly, without the page, and use the server's secrets through it. That is why
publishing a server on a public site asks first. If an endpoint spends money or acts for someone,
refuse it when nobody is signed in.

**Only the site's own pages can send it changes.** Every site shares `{{instance:sites}}`, so to
stop another site's page posting to yours as your visitor, a request other than GET, HEAD or
OPTIONS from any page that isn't on the site itself is refused (`cross_origin`). Your own page's `fetch('/api/…')`
always passes, and so do `curl` and other servers, which carry no one's sign-in.

## Who is calling

{{instance:name}} tells the server in one request header, `x-fling-viewer`:

```json
{"id":"v_3f9a2c71","email":"ana@example.com","guest":false}
```

- `id` is the **viewer id**: the same for this person on this site, different on every other. Log
  it rather than the email (see [Logs](/guide/servers/logs#people-in-the-log-are-viewer-ids)).
- `guest` is true for someone invited from outside as a reviewer.
- There is no header on a public site or through a share link.

The browser's cookies never reach the server, and a header of that name sent by the browser is
dropped, so neither can be forged.

## Reviews

The [review page](/guide/feedback/comments) shows the site as it is, so reviewers are real
visitors and the server sees each of them. While the live version has a server, the review page
says so above the site: what reviewers see may differ, and what they do is real. If a button posts
to a chat channel, it posts during a review too.

## Limits

Each site's server runs within limits {{instance:name}} sets; the site's **Server** tab shows the
ones it has. Unless the instance says otherwise:

| Limit | |
|---|---|
| Time per request, a streamed answer included | {{fact:server-timeout}} |
| Requests a second, to one site | {{fact:server-rps}} |
| Request body | {{fact:server-body-max}} |
| Server bundle | {{fact:server-bundle-max}} |
| Site secrets | {{fact:site-secrets-max}} per site, {{fact:site-secret-max-size}} each |

Some Flings also limit the CPU time of a request, and how many copies of one site's server run at
once. Only an admin can change a site's limits, and some Flings serve a request for at most
{{fact:server-timeout-ceiling}} whatever the limit says.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| 403 `cross_origin` | A POST (or another change) to `/api/…` came from a page that isn't on the site | Call `/api/…` from the site's own pages |
| 405 | A method other than GET or HEAD outside `/api/` | Post forms to a path under `/api/` |
| 302 to sign in | Nobody is signed in, on a site that needs sign-in | Sign in, or call it from the page once signed in |
| 504 `server_timeout`, or an answer cut off | The request ran past its time limit, streamed answers included | Do less per request, or stop slow calls earlier. An admin can raise the limit for the site |
| 502 `server_cpu_limit` | The request used more CPU time than the instance allows | Do less work per request. Avoid a busy loop timed by `Date.now()`: on some Flings the clock only moves while the server waits for something |
| 502 `server_failed` | The server crashed or threw | Read its [logs](/guide/servers/logs) |
| A failed `fetch` to another service | Where servers may not reach the internet, every call to another host fails | Check **Outbound network** on the Server tab; ask an admin |
| 429 | More requests a second than the site's limit | Slow down, or ask an admin to raise it |
| 413 `too_large` | The request body is over the limit | Send less, or ask an admin |
| 503 `server_stopped` | An admin stopped the site's server | Ask an admin |<!-- requires: recoverableDeletes -->
| 503 `server_stopped`, on a site an admin restored | Its server waits for its [secrets](/guide/servers/secrets) to be set again, or didn't start once they were | Set them: it starts when the last is set, and each later set or removal tries again. Or fix the server and publish again |<!-- /requires -->
| A 403 or 404 from your server arrives as a 300 with an `x-fling-status` header | {{instance:name}} hasn't finished setting up site servers | Ask whoever runs {{instance:name}} to deploy it again |

## Good to know

- `/api/…` answers are never cached between visitors: every request reaches the server. Your
  `Cache-Control` goes to the browser as you set it, except that on a site that isn't public,
  `public` becomes `private` and `s-maxage` is dropped. Without one, the answer is
  `private, no-store`.
- `/api/…` takes any method; the rest of the site is GET and HEAD only.
- A server can be stopped and started at any time, so keep nothing in memory between requests.
- On some Flings a server can't start timers or make requests while it loads: do that in the first
  request instead.
