---
title: Comments and the review page
part: feedback
order: 10
summary: Reviewers comment on a site's pages beside the site itself; you act on them and resolve them.
requires: [comments]
sources: [apps/api/src/comments.ts, packages/shared/src/comments.ts, apps/api/src/policy.ts, apps/web/src/pages/Review.tsx, apps/web/src/components/SiteButtons.tsx, apps/cli/src/commands/comments.ts, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

Every site has a review page, `{{instance:origin}}/review/<name>`, that shows the site with its
comments beside it. Reviewers leave comments on any page, pinned to a spot or a passage if they
like. You, or your assistant, read them, fix the site, and resolve the threads.

When you publish, the result gives the review link first: it is the link to send when you want
feedback. Reviewers sign in to use it.

## Who can comment

Anyone signed in who can open the site can read, write and resolve its comments. On a site limited
to specific people and teams, that means only them, its owners and its publishers. On a public
site, the review page still needs sign-in. Someone with only a [share link](/guide/share/share-links)
can open the site but not comment.

Everyone can delete their own comments. A site's owners can delete anyone's.

## In Claude or ChatGPT

- "What feedback is there on `q3-report`?"
- "Fix what the comments on `q3-report` ask for, republish, and resolve those threads."
- "Reply to the thread about the chart on `q3-report`: the numbers are from March."

The assistant reads comments and resolves the threads it has dealt with. It only posts or deletes a
comment when you ask, because comments are signed with your name.

## On the command line

```sh
fling comments q3-report                     # open threads, by page
fling comments q3-report --all               # with resolved ones too
fling comments q3-report --path /docs/       # only one page
fling comment q3-report "Typo in the title" --path /docs/
fling comment q3-report "Fixed now" --reply <id>
fling resolve q3-report <id>                 # --reopen to open it again
fling uncomment q3-report <id>               # delete a comment (asks first unless --yes)
```

Deleting a thread deletes its replies too.

## In the web app

Press **Review** on a site's card or its page. The review page shows the site in a frame, with
**Comments** beside it. Use the **Comments** button in the header to show or hide them.

- Type in **Add a comment…** and press **Comment**. The comment is on the page you are looking at.
- To point at something, press **Pin to a spot**, then click a spot, drag a box, or select some
  text in the page. Hold Alt (⌥) and click as a shortcut.
- **This page** and **All pages** choose which comments you see. Tick **Resolved** to show resolved
  threads, and untick **Pins** to hide the pins.
- Under a thread, **Reply…** answers it and **Resolve** closes it. **Reopen** brings it back.

<!-- requires: live -->
The avatars in the header show who else is reviewing now, and their pointers show where. New
comments appear without reloading.
<!-- /requires -->

## When it goes wrong

- **"Review mode is off"**: {{instance:name}} has comments turned off.
- **"No site named …"**: it may have been deleted or renamed, or you can't open it. Ask its
  owner to let you in.
- **"the most a site can have"**: a site holds up to {{fact:comments-max}} comments. Delete some
  resolved ones first.

## Good to know

- Each comment remembers the version of the site it was written on, so feedback stays readable
  after you publish again.
- A comment holds up to {{fact:comment-max-chars}} characters.
<!-- requires: notifications -->
- A site's owners hear about new threads, and everyone in a thread hears about replies. See
  [Notifications](/guide/feedback/notifications).
<!-- /requires -->
- For labels, ratings or scores, use a [form](/guide/feedback/forms) rather than comments.
