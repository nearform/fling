---
title: Settings
part: admin
order: 30
summary: See how the instance is configured, and choose the route table's format.
audience: admin
sources: [apps/web/src/pages/AdminSettings.tsx, apps/web/src/lib/admin.ts, apps/api/src/config.ts, apps/api/src/admin.ts, apps/api/src/route-format.ts]
verified: 0669f1e87
---

The **Settings** page shows how {{instance:name}} is configured as it runs: who may sign in, its
addresses, its brand, which features are on, how it sends email. The settings are read only:
every value comes from the instance's deployment, so whoever runs {{instance:name}} changes it
there and deploys again. The one thing you choose here is the route table's format.

## In the web app

Open **Admin → Settings**. The values are in groups:

| Group | What it holds |
|---|---|
| **Sign-in** | The email domains and addresses that may sign in, the admins, and the sign-in provider |
| **Sites** | The app's address, the sites' domain, and who can open a new site by default |
| **Branding** | The instance's name, the install command it shows, its logo, favicon and colours |
| **Features** | Comments, live review, outside invitations and their daily limit, how many versions of each site are kept, and site servers: who may publish one, what they may reach and their limits |
| **Mail** | How email is sent, and from which address |
| **Platform** | Where its data and files are kept |

Each row shows a setting's name, the value the instance runs with, and **set** if the deployment
gave it or **default** if it falls back to Fling's own. Secrets show only whether they are set,
never their value.

Each group links to the part of the deploy guide, for AWS and for Cloudflare, that explains its
settings.

## The route table

The **Route table** panel shows how every site's address finds its files. Where the instance keeps
its routes in a store with a size limit, the panel shows how full it is.

The format is **JSON** until you choose otherwise. **Compact** takes about a third of the room,
for an instance whose route table is filling up. Choose **Switch to Compact** (or **Switch to
JSON**) and confirm. Sites published from then on take the new format at once; the others are
rewritten in the background over the next maintenance runs, and the panel shows how many are
done. Sites keep working throughout.

> **Warning** Before whoever runs {{instance:name}} rolls it back to an older release, switch back
> to JSON and wait until the panel says the rewrite has finished. Older releases read only JSON.

## What you change here, and what at deploy

Apart from the route table's format, nothing on this page changes from the web app. What admins
do day to day is elsewhere:

| You want to | Where |
|---|---|
| Help someone by seeing what they see | [Users](/guide/admin/users-and-invitations#impersonate-someone) |
| Let someone from outside in, or take their access away, where invitations are on | [Invitations](/guide/admin/users-and-invitations) |
| Change who can open a site, or delete it | The site's own page, as an admin |
| Check email is getting through | [Mail](/guide/admin/mail) |<!-- requires: servers -->
| Stop a site's server, change its limits, or find out who a viewer id belongs to | The site's **Server** tab, as an admin ([Logs and the Server tab](/guide/servers/logs#for-admins)) |<!-- /requires -->

Everything on this page is set at deploy by whoever runs {{instance:name}}: who may sign in and
who the admins are, the name and brand, the addresses, and which features are on. See
[Run your own Fling](/guide/run/your-own-fling).

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
| "Stop impersonating to get back to the admin pages." | You are acting as someone else. | Choose **Stop** in the bar at the top. |
| The route table is nearly full | The instance has a lot of sites, Paths or share links for its route store. | Switch to compact; if it is compact already, ask whoever runs {{instance:name}}. |
| A value isn't what you expected | The deployment didn't set it (it shows **default**), or set it differently. | Ask whoever runs {{instance:name}} to change it and deploy again. |

## Good to know

- A change to who can open new sites by default applies to sites created after it; existing
  sites keep their access.
