---
title: Site secrets
part: servers
order: 30
summary: Keys and webhook addresses a site's server reads, set beside the site and never shown again.
requires: [servers]
sources: [apps/api/src/servers/secrets.ts, apps/api/src/servers/api.ts, apps/api/src/policy.ts, apps/cli/src/commands/servers.ts, apps/cli/src/site-server.ts, apps/cli/src/dotenv.ts, apps/web/src/components/site/SiteSecrets.tsx, packages/shared/src/site-server.ts, packages/shared/src/mcp-tools.ts]
verified: 0ead0eb
---

{{instance:name}} refuses to publish any file with a secret in it, the server's bundle included,
so a server's keys live beside the site as **site secrets**. The server reads each one as
`process.env.NAME` (or `secret('NAME')`). Values are kept encrypted and are never shown again, by
the CLI, the assistant or the web app.

A site's owners and publishers set its secrets.

> **Warning** Anyone who can publish a site, and may publish servers, can read its secrets, by
> publishing a server that prints them. Choose its [publishers](/guide/share/owners-and-publishers) with that in mind.

## In your assistant

- "Publish my-app and tell me which secrets I need to set."

Your assistant never asks for a secret's value and has no way to set one, so values never pass
through the conversation. When a publish needs a secret, it tells you which, and you set it
yourself: on the command line or in the web app, below.

## On the command line

```sh
fling secrets set my-app SLACK_WEBHOOK_URL < webhook.txt        # the value from a file
fling secrets set my-app SLACK_WEBHOOK_URL                      # asks for it, not shown
fling secrets set my-app --from .env SLACK_WEBHOOK_URL API_KEY  # only these names from .env
fling secrets ls my-app
fling secrets rm my-app SLACK_WEBHOOK_URL
```

A value never goes on the command line, where it would land in your shell history. `--from` reads
only the names you list from the file, nothing else in it.

```
✓ SLACK_WEBHOOK_URL set on my-app (from .env; nothing else read)
The live server (version 5024258572153ca0) restarted with it.
```

`fling secrets ls` lists each secret's name, who set it and when; the names the live version needs
that aren't set; and, while a version waits for its secrets, which version and what it still needs.

## In the web app

Open the site from **Sites** and choose its **Server** tab. The **Secrets** section lists each
secret with when it was set and by whom. **Add a secret…** sets a new one, **Set…** or
**Replace…** sets one by name, and the bin button removes one. A secret the live version doesn't name in
`fling.json` is marked **Not used**, and one it names but isn't set, **Not set**.

When a version waits for secrets, the Server tab is marked, and the Secrets section says which
version and which secrets.

## Setting a secret puts it to use

There is nothing to publish again. Each set or removal says what it did:

- **The live server restarts** with the secrets as they now are, and is checked again as at a
  publish. If it then fails to start, you are told and given its log; the secret stays set, so the
  fix is another secret, the server, or a rollback.
- **A version waiting for its secrets goes live** as soon as the last one it needs is set:

  ```
  ✓ SLACK_WEBHOOK_URL set on my-app (from .env; nothing else read)
  Version f12ba1d8273dc664 is live now: {{instance:site:my-app}}
  ```

  If its server fails to start then, the version keeps waiting, and every later set or removal
  tries it again. Or fix the server and publish again: the new version replaces the waiting one,
  and goes live at once if its secrets are set.
<!-- requires: recoverableDeletes -->
- **A restored site's server starts** once the last secret it needs is set. An admin's
  [restore](/guide/publish/archive-and-delete) brings the site back without its secrets' values:
  the static site is live at once, and its server waits for them.
<!-- /requires -->

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `secrets_missing` after a publish | The version needs secrets that aren't set, and waits for them | Set them; it goes live when the last is set |
| `secrets_missing` after a rollback | The version you rolled back to needs a secret that isn't set | Set it, then roll back again |
| "A secret value never goes on the command line" | You wrote `NAME=value` | Pass the value on stdin, or use `--from` |
| `invalid_secret_name` | The name isn't `A-Z`, `0-9` and `_`, or is one the platform keeps (`PORT`, `PATH`, `FILES`, `AWS_*`…) | Choose another name, in `fling.json` and the server too |
| `invalid_secret_value` | The value is empty | Give it a value, or remove the secret and let the server fall back to its default |
| `too_many_secrets` | The site has {{fact:site-secrets-max}} secrets, the most it may have | Remove one first |
| `too_large` | The value is over {{fact:site-secret-max-size}} | Secrets are for keys and addresses, not data |
| "No site … with a server that you can manage" | You aren't an owner or publisher of the site, or it's a Path you publish | Ask one of the site's owners |

## Good to know

- Secrets belong to the site, not a version. A rollback runs the old code with today's secrets, so a
  rotated key never comes back.
- A server gets only the secrets its version names in `fling.json`.
- Publishers of a [Path](/guide/team-sites/paths) can't see or set the site's secrets.
- Admins can't read secrets either.
