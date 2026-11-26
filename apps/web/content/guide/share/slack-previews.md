---
title: Previews in Slack
part: share
order: 50
summary: Post a site's link in Slack and it shows its title, picture and who can open it.
requires: [slackUnfurls]
sources: [apps/api/src/slack/**, apps/api/src/routes/slack.ts]
verified: 08b20a3
---

When you post a link to a site in Slack, {{instance:name}} shows a preview card under it: the
title of the site's home page, a picture of it, who can open it, when it was last published and by
whom. The card has buttons to open the site, review it and see its details in {{instance:name}}.
Anyone in the channel sees the card, but only people who can open the site get in when they
click.

## In Slack

Paste the link in a message, as you would any link. Any of these get a card:

- the site's address, or any page of it: `{{instance:site:q3-report}}`
- its review page: `{{instance:origin}}/review/q3-report`
- its page in {{instance:name}}: `{{instance:origin}}/sites/q3-report`

You get a card for any site you can open, not only your own. A colleague who can open a site
everyone signed in can see gets a card for it too.

## When it goes wrong

- **The link shows a plain card.** {{instance:name}} knows you by the email address on your Slack
  profile. Check it is the address you sign in to {{instance:name}} with, and that you have
  signed in at least once. You also get a plain card for a site you can't open, an archived site
  or a site with nothing published yet.
- **A share link shows the site's own preview.** Share links open for anyone, so Slack previews
  them itself.

## Good to know

- The card goes to the whole channel, as a screenshot would. Before you post a link to a site only
  a few people can open, think about who is in the channel. They still can't open the site.
- The picture is the one the site's page in {{instance:name}} shows. A site without one gets a card
  without a picture.
