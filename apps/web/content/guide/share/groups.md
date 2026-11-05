---
title: Groups
part: share
order: 30
summary: Named lists of people, such as a team, to open sites to or make owners and publishers.
requires: [groups]
sources: [packages/shared/src/groups.ts, apps/api/src/groups.ts, apps/api/src/policy.ts, apps/cli/src/commands/groups.ts, apps/web/src/pages/Groups.tsx, apps/web/src/components/GroupEditor.tsx, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

A group is a named list of people, such as a team. Name the group once instead of listing
everyone: in who can open a site, and in its owners and publishers. When someone joins or leaves the
group, every site it is named on follows.

Anyone signed in can see every group, see who is in it and use it on their own sites. Only the
person who made a group can change it.

## In your assistant

- "Which groups are there?"
- "Make a group called `design` with ana@example.com and bob@example.com."
- "Add cat@example.com to the design group."
- "Let the design group open `q3-report`."

Before making a new group, the assistant checks whether one already holds the same people.

## On the command line

```sh
fling groups                                    # every group (--mine: only yours)
fling groups --members ana@example.com,bob@example.com   # groups of exactly these people
fling groups show design                        # who is in it
fling groups create design --name "Design team" --add ana@example.com,bob@example.com
fling groups add design cat@example.com
fling groups remove design bob@example.com
fling groups rename design "Designers"
fling groups delete design                      # asks first unless --yes
```

Then use the group by its slug:

```sh
fling access q3-report --group design
fling publishers q3-report --group design
```

## In the web app

Open **Groups** from the side menu. The **All** and **Mine** tabs list every group, or only yours.

- **New group** asks for a **Name**, a **Slug** and the members, then **Create group**.
- Click a group to see its members. In your own group you can **Rename** it, add and remove
  members, or **Delete…** it.

You can also make a group from a site's **Access** section, with **Save these people as a group**.

## When it goes wrong

- **You can't change a group**: only its owner can. Ask them, or make your own group.
- **The slug is refused**: a slug is lowercase letters, digits and single hyphens, and must be
  unused on {{instance:name}}.
- **Someone you took out can still open a site**: access is checked again within
  {{fact:access-revoke-delay}}.

## Good to know

- Deleting a group never opens a site up. Sites that named it keep their restriction, and anyone
  it let in loses access. A site limited to that group alone is open only to its owners until they
  add people or groups.
- Naming a group as owners or publishers trusts whoever manages the group: anyone they add owns or
  publishes the site too.
- A group holds up to {{fact:group-members-max}} people.
<!-- requires: email -->
- People you add to a group are told by email.
<!-- /requires -->
<!-- requires: invites -->
- Where {{instance:name}} invites people from outside, an outside address added to a group is
  invited as a guest. Guests can be in groups but can't list or make them.
<!-- /requires -->
