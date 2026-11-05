---
title: Who can open a site
part: share
order: 10
summary: Each site has one access level, from only you to anyone with the address.
requires: [accessLevels]
sources: [packages/shared/src/access.ts, packages/shared/src/audience.ts, apps/api/src/policy.ts, apps/api/src/invitations.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteAccess.tsx, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

Every site has an access level: who can open it. A site is private unless you make it public, and
you can change its level at any time without publishing again.

| Level | Who can open it |
|---|---|
| Only you | You, and the site's other owners and publishers. |
| Specific people and teams | You, the people you name and the members of the groups you choose. |
| Everyone signed in | {{instance:audience}}. |
| Public | Anyone with the address, without signing in. |

A new site starts as **only you**, unless {{instance:name}} is set up to open new sites to everyone
signed in. When you publish a new site, the result says who can open it. Publishing again keeps the
level, unless you deploy with `--public`.

## In Claude or ChatGPT

Say who should see the site when you publish it, or ask for a change later:

- "Fling this folder as `q3-report`, just for me."
- "Let ana@example.com and the design group open `q3-report`."
- "Open `my-app` to everyone signed in."
- "Make `my-app` public."
- "Who can open `q3-report`?"

The assistant only changes who can open a site when you ask it to.

## On the command line

Choose the level of a new site when you first deploy it:

```sh
fling deploy ./dist --name q3-report --access only_me
fling deploy ./dist --name q3-report --access people --add ana@example.com
fling deploy ./dist --name q3-report --access groups --group design
```

Change it later with `fling access`. On its own, the command shows who can open the site now:

```sh
fling access q3-report                          # who can open it now
fling access q3-report --only-me                # nobody else
fling access q3-report --add ana@example.com    # add a person
fling access q3-report --remove ana@example.com
fling access q3-report --group design           # add everyone in a group
fling access q3-report --remove-group design
fling access q3-report --members                # everyone signed in
fling access q3-report --public                 # anyone, no sign-in
```

`fling ls` shows each site's level in its ACCESS column. `fling ls --shared` lists the sites other
people have opened to you, by your address or through a group.

## In the web app

Open the site from **Sites** and go to its **Access** section. Under **Who can open this site**,
choose an option:

- **Only you**, **Everyone signed in to {{instance:name}}** and **Public** save as soon as you
  choose them. If that clears a list of people and teams, you confirm first.
- **Specific people and teams** opens a list. Add addresses and pick groups, then press **Save**.
  After that, each change to the list saves at once.

When you list two or more people, the web app offers to **Save these people as a group**, or to use
an existing group that holds exactly the same people.

Sites other people have opened to you are on the **Shared with me** tab of the Sites page.

## When it goes wrong

- **"Not an address that can sign in"**: the address can't sign in to {{instance:name}}, so it
  can't be added. Check the spelling, or use a share link.
  <!-- requires: invites -->Where {{instance:name}} invites people from outside, an outside address
  is invited as a guest instead. A guest signs in with a link sent to them by email and sees only
  what is shared with them. You can invite only a few new outside addresses a day. Past that
  limit, nothing changes and you are told to try again tomorrow.<!-- /requires -->
- **"needs at least one address or group"**: a list of specific people and teams can't be empty.
  To let nobody else in, choose only you.
- **Someone you removed can still open the site**: access is checked again within
  {{fact:access-revoke-delay}}. A share link also lets anyone in who has it, whatever the level.
- **A site limited to a deleted group**: it shows "a deleted group" and only you can open it until
  you add people or groups.

## Good to know

- You can always open your own site, whatever its level.
- A public site keeps its list of people and teams. Make it private again and the list applies
  again.
- On a public site, the review page and comments still need sign-in.
- A list can name up to {{fact:audience-emails-max}} people and {{fact:audience-groups-max}}
  groups. See [Groups](/guide/share/groups).
- To show a private site to someone who can't sign in, use a
  [share link](/guide/share/share-links).
