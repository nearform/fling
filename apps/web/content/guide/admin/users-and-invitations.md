---
title: Users and invitations
part: admin
order: 10
summary: See who has signed in, act as someone to help them, and invite people from outside.
audience: admin
sources: [apps/web/src/pages/AdminUsers.tsx, apps/web/src/pages/AdminInvitations.tsx, apps/web/src/components/ImpersonationBanner.tsx, apps/web/src/lib/admin.ts, apps/api/src/admin.ts, apps/api/src/invitations.ts, apps/api/src/policy.ts, apps/api/src/audit.ts, apps/api/src/config.ts]
verified: 60d6113
---

As an admin of {{instance:name}} you can see everyone who has signed in, and act as one of them to
see what they see when they ask for help. <!-- requires: invites -->You can also let in people
from outside the addresses {{instance:name}} admits, by inviting them.<!-- /requires -->

Everything here is in the web app, under **Admin** in the side menu. Only admins see it.

## Who is an admin

Whoever runs {{instance:name}} chooses its admins when they deploy it: a list of email addresses
in its configuration. You can't make someone an admin from the web app. Ask the people who run the
instance, or see [Run your own Fling](/guide/run/your-own-fling).

An admin signs in like everyone else, so their address must be one {{instance:name}} admits. Being
an admin gives you more than the Admin pages:

- You can open and review any site, including ones restricted to a few people. **Sites → All
  sites** lists every site on the instance.
- From the web app, you can change any site as its owner would: who can open it, its settings, its
  owners and publishers, its share link; roll it back, archive it, delete it, and delete any
  comment.
- You never publish to someone else's site. Only its owners and publishers do.

Whatever you do to someone else's site only because you are an admin is recorded, with your email.
From the CLI or a connected assistant, an admin can open and read any site but changes nothing on
other people's: a leaked key can't do what your browser can.

## In the web app

### Users

**Admin → Users** lists everyone who has signed in to {{instance:name}}: their name and email,
when they first signed in, when they last did, and how many sites they own. Admins carry an
**Admin** badge. <!-- requires: invites -->People invited from outside by a share or a group carry
a **Guest** badge: they review only what is shared with them.<!-- /requires -->

Type the start of an email address in the search box to find someone. **Load more** shows the
next page.

Below the list, **Recent activity** shows every impersonation's start and stop, every invitation
made or revoked, and what admins changed on other people's sites or opened of their restricted
ones. Entries are kept for {{fact:audit-days}}.

### Impersonate someone

When someone says "I can't see it", seeing {{instance:name}} as they do is often the quickest way
to help.

1. On **Admin → Users**, find them and choose **Impersonate**.
2. Read the confirmation and choose **Impersonate** again.

A bar across the top of every page says **Viewing as** and their email. Their sites, their shares
and their comments are what you see, and what you do is done as them. Choose **Stop** in that bar to
go back to your own session.

An impersonation lasts up to {{fact:impersonation-ttl}}, and never longer than your own sign-in.
While it lasts you can't:

- create CLI logins or connect apps for them, or revoke theirs;
- change what they are notified about, or read the emails sent to them;
- invite anyone;
- use the Admin pages.

There is no **Impersonate** button on your own row or on another admin's: admins can't be
impersonated.

<!-- requires: invites -->
### Invitations

{{instance:name}} admits people by their email address. Invitations let in people outside it, in
two ways:

- **Guests.** When someone shares a site or adds a person to a group with an outside address, that
  person is invited as a guest. A guest reviews what is shared with them, and public sites, and
  nothing else: they can't publish or make groups. Each person can invite only so many new
  outside addresses a day this way: {{fact:invites-per-day}}, unless whoever runs
  {{instance:name}} sets another limit.
- **Members.** You invite someone as a full member, like anyone {{instance:name}} admits.

To invite a member:

1. Open **Admin → Invitations**.
2. Under **Invite someone**, type their address, for example `ana@example.com`, and choose
   **Invite**.

They get an email with a sign-in link. It works once, within {{fact:invite-link-ttl}}. Inviting a
guest this way makes them a member. Inviting someone who already holds a member invitation sends
the email again.

The list below shows every invited address, whether they are a guest or a member, who invited them
and how, and whether they have signed in yet. Search it by the start of the address.

To take someone's access away, choose **Revoke** on their row and confirm. They can no longer sign
in, and their sessions, API keys and app connections stop working on their next request. The
invitation stays in the list, marked **Revoked**. If someone shares with them again later, they are
invited again as a guest.

Invited people sign in with a link emailed to them, never with {{instance:account}}. The sign-in
page offers **Email me a sign-in link** for their later visits.
<!-- /requires -->

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
| "Stop impersonating to get back to the admin pages." | You are acting as someone else. | Choose **Stop** in the bar at the top. |
| "Admins cannot be impersonated" | The person is an admin too. | Ask them to share their screen instead. |
| "Impersonation needs your browser session" | You tried from the CLI or an assistant. | Use the web app. |

<!-- requires: invites -->
| What you see | What it means | What to do |
|---|---|---|
| "*address* can sign in to {{instance:name}} already" | The address is one {{instance:name}} admits; it needs no invitation. | Send them {{instance:origin}}. |
| "Invited *address*, but the email was not sent" | The invitation is made; the email failed, for the reason shown. | Check **Admin → Mail**, then choose **Invite** again to resend. |
| "You can invite … people from outside {{instance:name}} a day" | Someone sharing has reached today's limit of outside addresses. | They can try tomorrow, or you invite the person on **Admin → Invitations**. |
<!-- /requires -->

## Good to know

- An admin's notifications are the same as anyone's: you hear about a site because you own it,
  publish to it or it was shared with you, not because you are an admin.
- Removing an address from the admins takes effect on its next request after the change is
  deployed.
<!-- requires: invites -->
- A guest whom no site or group names any more loses access until someone shares with them again.
- If whoever runs {{instance:name}} turns invitations off, every invitation stops counting at once;
  turned back on, they count again.
<!-- /requires -->
