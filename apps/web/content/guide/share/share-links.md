---
title: Share links
part: share
order: 20
summary: A secret link that opens a private site to anyone who has it, without signing in.
requires: [shareLinks]
sources: [apps/api/src/sites.ts, apps/api/src/policy.ts, packages/shared/src/hosts.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteAccess.tsx, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

A share link opens a private site to anyone who has the link, without signing in. Use one for a
client or a colleague who can't sign in to {{instance:name}}. The site stays private to everyone
else, and you can replace or remove the link at any time.

A share link looks like `https://s--<token>.{{instance:sites}}`. It works on top of the site's
[access level](/guide/share/who-can-open): even a site only you can open is open to whoever holds
its link.

## In your assistant

- "Give me a share link for `q3-report`."
- "Replace the share link for `q3-report`: the old one went to the wrong person."
- "Remove the share link for `q3-report`."

The assistant hands the link back and reminds you that anyone with it can open the site.

## On the command line

```sh
fling share q3-report             # print the link, creating one if there is none
fling share q3-report --refresh   # replace it: the old link stops working
fling share q3-report --revoke    # remove it
```

`fling ls` shows each site's link in its SHARE column. While a site limited to specific people has
a link, `fling access` warns that anyone with the link can still open it.

## In the web app

Open the site from **Sites** and go to its **Access** section. Under **Also share with a link**:

- **Create link** makes one and copies it.
- **Copy share link** copies it again.
- **Refresh the share link** gives you a new link. The old one stops working straight away.
- **Revoke the share link** removes it. Whoever you chose above can still open the site.

Refresh and revoke ask you to confirm first.

## When it goes wrong

- **A new link doesn't open yet**: a new link takes a few seconds to reach everywhere. The command
  line waits for it before it prints the link.
- **You can't see or make a link**: only a site's owners manage its share link. Publishers don't
  see it. See [Owners and publishers](/guide/share/owners-and-publishers).
- **Someone has a link they shouldn't**: refresh it, and send the new link only to the people who
  need it.

## Good to know

- A site has one share link at a time.
- Someone with a share link can open the site, but can't comment on it or download its files. The
  review page needs sign-in.
- A public site doesn't need a link: anyone can already open it.
