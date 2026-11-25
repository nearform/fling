---
title: Notifications
part: feedback
order: 30
summary: What you hear about, such as a site shared with you or a new comment, and how to change it.
requires: [notifications]
sources: [packages/shared/src/notifications.ts, apps/api/src/notifications/**, apps/web/src/pages/Notifications.tsx, apps/web/src/lib/notifications.ts, apps/cli/src/commands/notifications.ts, packages/shared/src/mcp-tools.ts]
verified: 0a10243
---

{{instance:name}} tells you when something happens that involves you, so you don't have to keep
checking. You choose what you hear about, one kind of event at a time, or mute everything.

- **Someone shares a site with you**: the people added to who can open a site.
- **Someone shares a site with a group you are in**: the members of a group added to who can open
  a site.
<!-- requires: siteRoles -->
- **Someone makes you an owner of a site**, or **a publisher**: the people added, or the members of
  the groups added.
<!-- /requires -->
- **Someone adds you to a group**: the people added.
<!-- requires: comments -->
- **Someone comments on your site**: the site's owners, when a new thread starts. On the page of a
  [Path](/guide/team-sites/paths), the Path's owners instead.
- **Someone replies in your thread**: whoever started the thread and everyone who replied in it.
<!-- /requires -->
<!-- requires: archivePolicy -->
- Under **Your sites**, **Your site is about to be archived**: nobody has viewed or published a site
  you own for a while, and it will be archived on the date given unless someone does. **Your
  archived site is about to be deleted**: a site of yours archived for nobody using it will be
  deleted on the date given unless an owner unarchives it. Every owner hears, the members of an
  owner group included. See [Sites nobody uses](/guide/publish/sites-nobody-uses).
<!-- /requires -->

You never hear about what you did yourself. Each of these is on until you turn it off.

<!-- requires: email -->
Notifications come by email. Several close together about the same site come as one email, and
after an email about comments on a site, the next one for that site waits a little. Every email has
a **Stop these emails** link that turns that kind of email off in one click.
<!-- /requires -->

## In your assistant

- "Why am I getting emails about comments?"
- "Stop emailing me when someone comments on my sites."
- "Mute all my notifications."

The assistant only changes the settings you ask about.

## On the command line

```sh
fling notifications                                    # every event: on or off, * where you chose
fling notifications set comment.created email off     # turn one off
fling notifications set comment.created email default # back to the default
fling notifications mute                               # stop everything (your choices are kept)
fling notifications unmute
fling notifications sent                               # what was sent to you in the last 30 days
```

## In the web app

Open your account menu and choose **Notifications**. Under **Tell me when**, each event has a
switch for each way of being told. **Your choice** marks the ones you changed from the default;
switch one back to the default to clear it.

**Mute everything** stops all notifications and keeps your choices for when you turn it off.
**What was sent to you** lists the last 30 days, newest first.

## When it goes wrong

- **You expected to hear and didn't**: check that the event is on and that you haven't muted
  everything. Then check **What was sent to you**.
<!-- requires: email -->
- **An email is listed as sent but you can't find it**: look in your spam folder.
<!-- /requires -->
<!-- requires: email, comments -->
- **Too many emails about comments**: turn off **Someone comments on your site**, or use the **Stop
  these emails** link in one of them.
<!-- /requires -->

## Good to know

- Saving the same list of people or groups again tells nobody: only people newly added hear.
<!-- requires: archivePolicy -->
- Turning off **Your site is about to be archived** stops the email, not the archive: the site's
  page still says when it will be archived.
<!-- /requires -->
- A site that first goes live open to specific people tells them it was shared with them.
- While an admin is acting as you, they can see your settings but not change them, and can't see
  what was sent to you.
