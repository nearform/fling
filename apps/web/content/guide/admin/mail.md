---
title: Mail
part: admin
order: 20
summary: Check how the instance sends email, send a test, and see how sending went in the last day.
audience: admin
requires: [email]
sources: [apps/web/src/pages/AdminMail.tsx, apps/api/src/notifications/mail-admin.ts, apps/api/src/notifications/drain.ts, apps/api/src/policy.ts, apps/api/src/config.ts]
verified: 98b7f5e
---

{{instance:name}} sends email: notifications when someone shares a site or comments, and sign-in
links for invited people. The **Mail** page shows how it sends them, lets you send a test, and
counts what happened to the last day's messages, so you can tell whether mail is getting through.

It shows no addresses but the instance's own, and no message content. Nothing on it sends
anything unless you ask for a test.

## In the web app

Open **Admin → Mail**.

### Configuration

How {{instance:name}} sends email, read only: the service it sends through, the **From** address
and name, the **Reply-To** address, and on Amazon SES the configuration set. **Outside
invitations** says whether people from outside can be invited, and links to its value on
[Settings](/guide/admin/settings).

Whoever runs {{instance:name}} sets all of this when they deploy it. To change it, see the Email
section of the deploy guide for
[AWS]({{fact:repo-url}}/blob/main/platforms/aws/DEPLOY.md#email) or
[Cloudflare]({{fact:repo-url}}/blob/main/platforms/cloudflare/DEPLOY.md#email).

### Send a test email

1. Under **Send a test email**, type an address, for example `ana@example.com`.
2. Choose **Send test**.

The test goes straight to the email service, to any address, whether or not it can sign in to
{{instance:name}}, so online deliverability checkers work too. When it is accepted you see the
service's message id: open the email that arrives and check its headers for SPF, DKIM and DMARC
alignment. When it is refused, you see why.

You can send {{fact:mail-tests-per-hour}} test emails an hour; the page says how many are left.

### Last 24 hours

The counts for the last day, in total and hour by hour:

| Count | What it means |
|---|---|
| **Sent** | The email service accepted the message. |
| **Retrying** | The service refused it for now (busy, a passing error, or its daily quota). Fling tries again later. |
| **Given up** | It failed every retry, or the service rejected it outright, which usually means the setup is wrong. |
| **Suppressed** | The address bounced, or the service refuses to send to it. Fling doesn't email it for {{fact:suppression-days}}. |
| **Dropped** | Fling decided not to send: by then the person could no longer see the site, or had turned that notification off. |

**Recent failures** lists the latest failed sends: when, the reason the service gave, which kinds
of event the message was about, and its batch id, which is what the instance's logs name.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Not sent:" and a reason | The email service refused the test. A reason about the sender or its domain means the sending domain isn't set up with the service, or the From address isn't on it. | Fix the sending domain with the service, then send another test. |
| "You can send … test emails an hour" | You have used this hour's tests. | Wait for the next hour. |
| "Sending a test email needs your browser session" | You tried from the CLI or an assistant. | Use the web app. |
| Many **Given up** | Messages are being rejected. | Read **Recent failures**, then check the mail setup in the deploy guide. |
| **Retrying** that keeps growing | The service is throttling, or its daily quota is spent. | Messages held for the quota go out the next day (UTC). Ask the service for a higher quota if it keeps happening. |

## Good to know

- What people are notified about, and how they turn it off, is on
  [Notifications](/guide/feedback/notifications).
- Admins never read other people's email: there is no way to see what was sent to someone.
