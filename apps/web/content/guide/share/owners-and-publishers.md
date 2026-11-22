---
title: Owners and publishers
part: share
order: 40
summary: Share the work on a site. Owners can do everything; publishers publish and roll back.
requires: [siteRoles]
sources: [packages/shared/src/site-roles.ts, apps/api/src/policy.ts, apps/api/src/publication.ts, apps/api/src/invitations.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteTeam.tsx, apps/web/src/components/site/RoleLists.tsx, packages/shared/src/mcp-tools.ts, apps/web/src/lib/site-tabs.ts]
verified: 1f60f9d
---

A site can have several people working on it. **Owners** have every right over it. **Publishers**
can put up new versions and roll back, and change nothing else. Use them so a team can keep a site
up to date without each person being able to delete it or change who sees it.

You own every site you make. Owners are equal, so you can hand a site over by adding a new owner and
then removing yourself.

| | Owners | Publishers |
|---|---|---|
| Publish new versions | Yes | Yes |
| Roll back to an earlier version | Yes | Yes |
| See the site's versions and files | Yes | Yes |<!-- requires: metrics -->
| See its [metrics](/guide/publish/metrics) | Yes | Yes |<!-- /requires -->
| Change who can open it, and the share link | Yes | No |
| Change its settings (such as the single-page app setting) | Yes | No |
| Change its owners and publishers | Yes | No |
| Archive, bring back from the archive, delete | Yes | No |
| Delete anyone's comment | Yes | No, only their own |<!-- requires: servers -->
| Set its site secrets, read its server's logs | Yes | Yes |<!-- /requires -->

Owners and publishers can always open the site, whatever its
[access level](/guide/share/who-can-open). Both can be people or [groups](/guide/share/groups).
Only people who can sign in to {{instance:name}} as members can hold either role. Guests can't,
even through a group.

## In your assistant

- "Make bob@example.com a publisher of `q3-report`."
- "Add the design group as publishers of `q3-report`."
- "Make cat@example.com an owner of `q3-report` too."
- "Who owns `q3-report`?"

The assistant only changes owners and publishers when you ask, and only on sites you own.

## On the command line

```sh
fling owners q3-report                            # who owns and publishes it, and your role
fling owners q3-report --add cat@example.com
fling owners q3-report --remove you@example.com   # hand it over: someone else must own it
fling publishers q3-report --add bob@example.com --group design
fling publishers q3-report --remove-group design
fling publishers q3-report --set bob@example.com  # exactly these people (groups stay)
```

`fling ls` shows your ROLE on each site. Add `--path PAY-412` to change the owners and publishers of
one [Path](/guide/team-sites/paths) instead of the whole site.

## In the web app

Open the site from **Sites**. Its **Access** tab, the one it opens on, has the **Owners and
publishers** section. Add people and groups to **Owners** or **Publishers**. Each change saves at
once.

A publisher sees the section without being able to change it. Their site page also leaves out
the **Access** section, the share link and the **Settings** tab.

## When it goes wrong

- **`last_owner`**: a site always keeps at least one person as an owner. A group alone doesn't
  count. Add another owner first.
- **"Not a member" (`email_not_allowed`)**: only members of {{instance:name}} can own or publish a
  site. Use the address they sign in with.
- **`owner_only`**: as a publisher, you tried to change something only owners can, such as the
  access level or the single-page app setting, or to publish to an archived site. Ask one of its
  owners.

## Good to know

- Someone in both lists is an owner.
<!-- requires: servers -->
- A publisher who may publish servers can read the site's [secrets](/guide/servers/secrets) by
  publishing a server that prints them. Make people publishers only if you would trust them with those keys.
<!-- /requires -->
- Naming a group trusts whoever manages it: anyone they add to the group owns or publishes the site
  too.
- A site can have up to {{fact:owner-emails-max}} owners and {{fact:publisher-emails-max}}
  publishers by address.
<!-- requires: email -->
- People you add are told by email.
<!-- /requires -->
- An admin of {{instance:name}} can change any site from the web app, as an owner would, but can't
  publish to it. What they change is recorded.
