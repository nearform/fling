# How Fling works

The detail behind the summary in the [README](../README.md#how-it-works).

## Instances

Each deployment of Fling (an *instance*) has its own name, domains, sign-in and look,
which it publishes at `/.well-known/fling`. The CLI, the MCP servers and the web UI read it from
there, so none of them is tied to one instance. People sign in through the instance's OpenID
Connect provider (Google, Microsoft Entra ID, Okta, Auth0, Cognito, …), or either of two side by
side (a Google client and another issuer, a button each), limited to its email domains whichever
they use. A new
site is visible only to its owner unless they choose otherwise (an instance can open new sites to
everyone signed in instead, `SITE_DEFAULT_ACCESS`); share links open a site to anyone with the
link. No site is
indexed: every sites host answers `/robots.txt` with Fling's own `Disallow: /`, whatever the site
ships.

## Access levels

Who can open a site is one of five levels: only you, teams (groups), specific
people, everyone signed in, or public. Choose it on the first deploy (`fling deploy --access
only_me|members|groups|people|public`, `access` on `fling_deploy` and `fling_publish`; the MCP
servers ask the user first) and change it later (`fling access <site> --only-me | --members |
--public`, `fling_set_access`, or the site's Access section in the web UI). A re-deploy never
changes it.

## Audiences

The owner can limit a site to listed people and groups (`fling access <site>
--add a@example.test --group design`, `fling_set_audience`, or the site's Access section in the web
UI). Each address must be one that can sign in, or, where the instance invites people from outside,
one it invites as a reviewer (see Invitations); the owner always sees the site, and share links
still open it. A **group** is a named list of people (`fling groups`, `fling_groups`, the Groups page
in the web UI): anyone signed in can see one and use it, and only its owner can change it. The edge
holds no access lists: the API checks the audience when someone signs in to the site and hands them
a 5-minute site pass for that one host, renewed without a prompt. So removing someone (from the
audience or from a group in it) takes effect within 5 minutes. **Shared with me** lists the
restricted sites other people have limited to you, or to a group you are in (`fling ls --shared`,
`fling_list { shared: true }`, the Sites page's Shared with me tab).

## Owners and publishers

A site's owners are equal: each publishes, rolls back, changes its
access and settings, its owners and publishers, and archives or deletes it. Its publishers publish
and roll back, and change nothing else. Both are people or groups (`fling owners <site> --add
a@example.test --group design`, `fling publishers <site> …`, `fling_set_owners`,
`fling_set_publishers`, or the site's Owners and publishers section in the web UI), members of the
instance only, never guests. A site always keeps at least one person as an owner, so it carries on
when whoever created it is away or leaves. Naming a group trusts whoever manages it. People given a
role are told by email, where the instance sends it.

## Paths: one site, a folder per ticket

A Path is a top-level folder of a site with its own
versions, rollback, owners and publishers: `fling deploy ./plan --name payments-plans --path
PAY-412` publishes the plan at `<payments-plans>/PAY-412/` and makes you its owner, and nothing
else on the site changes (`path` on the MCP tools). Access is the site's, so a team sets it once;
teammates and their agents publish their own Paths without colliding, and each rolls back alone
(`fling rollback payments-plans <version> --path PAY-412`). The site's home page lists its Paths,
with search and sort: by default when it has no index.html of its own, or wherever its own
index.html puts a Paths block (`<!-- fling:paths -->`; `fling paths init --template plans` writes
a starter). `fling paths <site>`, `fling_paths` and the site page list them. Comments on a Path's
pages go to its owners.

## Markdown

`.md` files are served as pages, rendered as GitHub-flavoured Markdown, with their
source at `?raw=1`; a folder's `index.md` or `README.md` is its home page. A plan written in
Markdown is published as it is.

## Retention

An instance can keep only the newest versions of each site and Path
(`VERSION_RETENTION`); older ones are deleted an hour after they are marked, unless they are
published again or rolled back to meanwhile. By default every version is kept.

## Pull

Anyone signed in who can open a site can download it to change it: `fling pull changelog`
writes its files to `./changelog`, and `fling deploy changelog` publishes the folder on the version
pulled, uploading only what changed. If someone else published the site since, the deploy stops
rather than overwrite their work: pull again and redo the change, or `--force` to replace theirs.
Agents do the same with `fling_pull`, or read the files inline with `fling_read_files` and publish
only the files they change (`base` on `fling_publish`). With `--path` (or `path`), the same for one
Path. The site page shows the command to whoever
may pull.

## Review

Anyone signed in can review a site they can open: `<app>/review/<name>` shows the site
in a frame beside its comments, threads per page that can be replied to, resolved and deleted.
- The frame follows the site's own navigation (single-page apps included) and stays on the site:
  a link elsewhere is stopped, with an offer to open it in a new tab.
- A pin is a spot you click, a box you drag, or text you select in the page (the thread quotes
  it, so agents see exactly what a comment is about); selecting its thread shows the box or text. Pins stick to the element they point at,
  whatever the reviewer's scroll or screen size; clicking one opens its thread and the other way
  round.
- Deploying and publishing give the review link first, as the one to share for feedback.
- The CLI (`fling comments`, `fling comment`), the MCP tools (`fling_comments_list`, …) and the web
  all use the same API.
- An instance turns comments off with `COMMENTS=false`; its metadata then lacks the `comments`
  capability and every client hides them.

## Structured feedback (forms)

For labels, ratings, rubric scores or eval judgements, a site can
ship forms instead of asking reviewers to type codes into comments. Put a `fling.forms.json` at
the top of the folder (`fling forms init` writes one from a template, `fling forms check` checks
it) and deploy: the file is never served, and each form is a JSON Schema the review page renders.
- A **page** form takes one answer per reviewer per page, which they can change; the review page
  shows it in a tab named after the file's `title` (Labels, Evals, …), with how many pages they
  have done and a link to the next.
- A **comment** form is a type of comment: pin a spot or select text, then fill it in. Each answer
  is a thread that can be replied to and resolved.
- `"visibility": "own"` shows reviewers only their own answers (owners and admins see everyone's),
  for blind labelling.
- `fling responses <site> --format csv` (or JSON, JSON Lines; `fling_responses_list` for agents)
  exports the answers, and `<app>/sites/<site>/responses` shows who has answered which page.

Forms come with comments: there is no switch of their own, and `COMMENTS=false` turns both off.
Agents write and check forms with `fling_forms_template` and `fling_forms_check`, and publish them
with `forms` on `fling_publish` and `fling_deploy`.

## Previews and thumbnails

A site's page in the web UI shows its home page live, as a desktop
browser sees it, scaled down; private and restricted sites included. When an owner or publisher
opens that page and the site's thumbnail is missing or of an older version, their browser draws
the home page as a small PNG and keeps it as the site's thumbnail, once the site's address serves
that version (just after a publish it can take up to a minute). The site lists show each site's
thumbnail (a faded logo until it has one), as rows or, with the List / Grid switch, as a grid of
small cards; the choice is kept per browser. The `thumbnails` capability turns this on in every client.

## Metrics

Each site counts its views and pushes, and keeps nothing about who viewed. A push is a version
going live: a publish, a rollback, or the same on one of its Paths. A view is a page load: every
HTML page a version serves has a copy with a small script, made when the version goes live and
served in the page's place, that tells the site's own host once per load that the page was viewed
(`/_fling-seen`, which passes the same access checks as the page). What `fling pull` downloads is
the page as published. The review page and previews don't count, nor do pages being prerendered,
a single-page app's navigations, or pages whose Content-Security-Policy blocks inline scripts.
Owners, publishers and admins see the counts per day, week and month, with when the site was last
viewed and last pushed: on its page in the web UI, with `fling stats`, or `fling_stats` over MCP.
An admin turns view counting on or off for every site in Admin → Usage; maintenance then adds or
removes the beacon on every live site without publishing it again, and turning it off keeps the
views counted so far. Whoever runs the instance can turn it off altogether
(`SITE_VIEW_COUNTS=off`), which removes the switch. Pushes are counted either way.
The `metrics` and `viewCounts` capabilities tell clients.

## Live review

Everyone with a site's review page open is in that site's room. New comments,
replies and resolutions appear without a refresh, each reviewer's pointer moves on the others'
screens with their name, and a row of avatars (profile picture or initials) shows who is there,
dimmed when they are on another page. The room is one WebSocket protocol on every platform: a
Durable Object on Cloudflare, an API Gateway WebSocket API on AWS, Web PubSub on Azure. An instance without it
(`LIVE=false`, or no `LIVE_URL`) lacks the `live` capability, and review works as before,
refreshing comments every 30 seconds.

## Notifications

With email set up, people hear when a site is shared with them (directly or
through a group), when they are added to a group, and when someone comments on their site or
replies in their thread; never about their own actions. Comments that arrive close together fold
into one email. Each person chooses what they hear about from every client (Settings →
Notifications, `fling notifications`, `fling_notifications_set`), and every email has a one-click
unsubscribe. Email goes out through each cloud's own service (SES on AWS, Email Service on
Cloudflare, Communication Services Email on Azure) from a sender the operator already has; admins check the setup at `/admin/mail` with a
test email, and see the whole configuration (secrets by name only) at `/admin/settings`. An
instance without a mail sender lacks the `email` and `notifications` capabilities, and every client
hides the settings. See each platform's deploy guide, Email.

## Invitations

An instance with mail can let in people from outside its email domains
(`INVITES=on`; off by default). Sharing a site, or adding someone to a group, with an outside
address invites them as a **guest**: a reviewer who sees and comments on what is shared with them
and on public sites, and nothing else (no sites, groups, API keys or app connections of their own).
Their first email is the share's notification, with a sign-in link; guests sign in with emailed
single-use links, never at the instance's identity provider. Each person invites at most
`INVITES_PER_DAY` new outside addresses a day. Admins invite full members from Admin → Invitations
and revoke any invitation there, which cuts that person off on their next request, at the sites'
edge too (within about a minute on Cloudflare). A guest no
audience or group names any more is cut off too, until someone shares with them again. See each
platform's deploy guide, Outside invitations.
