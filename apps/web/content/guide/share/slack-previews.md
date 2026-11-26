---
title: Previews in Slack
part: share
order: 50
summary: Post a site's link in Slack and it shows its title, picture and who can open it.
requires: [slackUnfurls]
sources: [apps/api/src/slack/**, apps/api/src/routes/slack.ts]
verified: 08b20a3
---

When you post a link to a site in Slack, {{instance:name}} shows a small preview card under it:
the title of the site's home page, when it was last published and by whom, who can open it when
that isn't everyone signed in, a link to open it, and a small picture of it.
<!-- requires: comments -->
The title and the **Review** link open the site's review page, where people leave comments.
<!-- /requires -->
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

- **The card shows only the site's name.** That is the card for a link whose site you can't open,
  and nobody learns more from it than from the address. {{instance:name}} knows you by the email
  address on your Slack profile: check it is the address you sign in to {{instance:name}} with,
  that you have signed in at least once, and that this address can open the site. An archived
  site, a site with nothing published yet, a share link and any other page of {{instance:name}}
  get the same card.

## Good to know

- The card goes to the whole channel, as a screenshot would. Before you post a link to a site only
  a few people can open, think about who is in the channel. They still can't open the site.
- The picture is the one the site's page in {{instance:name}} shows. A site without one gets a card
  without a picture.
