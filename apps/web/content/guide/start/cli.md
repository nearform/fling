---
title: The CLI
part: start
order: 50
summary: Install the fling command, sign in, and keep it up to date.
sources: [apps/cli/src/cli.ts, apps/cli/src/commands/setup.ts, apps/cli/src/commands/auth.ts, apps/cli/src/commands/doctor.ts, apps/cli/src/doctor.ts, apps/cli/src/update-check.ts, apps/cli/src/config.ts, apps/cli/package.json, apps/web/src/pages/GetStarted.tsx]
verified: 60d6113
---

The `fling` command publishes from a terminal: a build folder, a page, a zip. It suits scripts,
CI and coding agents, and it is what the [Claude Code plugin](/guide/start/claude-code) and the
[Claude Desktop extension](/guide/start/claude-desktop) run underneath.

## Install and set up

You need Node.js {{fact:node-version}} or later. Install the CLI once:

```sh
{{instance:install}}
```

Then set it up with your Fling's address:

```sh
fling setup {{instance:origin}}
```

Setup does what a new computer needs:

1. **Signs you in.** Your browser opens to sign in with {{instance:account}}, and the CLI keeps a
   key for this computer. It skips this if you are already signed in.
2. **Adds Fling to Claude Code**, if it is installed: it asks first, then installs the plugin.
3. **Adds Fling to Claude Desktop**, if it is installed on macOS or Windows: it asks first, then
   opens the extension for Claude Desktop to confirm.

Add `--yes` to do every step without being asked. Later runs can leave out the address.

Can't install it globally? Every command also works through `npx`:

```sh
npx {{fact:cli-package}} setup {{instance:origin}}
```

To sign in without the rest, use `fling login {{instance:origin}}`. `fling whoami` shows who you
are signed in as, and where.

## Several Flings

The CLI remembers every Fling you sign in to, each with its own sign-in, and uses the current one.
Setting up or signing in to another Fling adds it and makes it current; the others stay signed in.

```sh
fling use                               # list them: * marks the current one
fling use other.example.com             # switch: its address, its host, or the start of it
fling --server other.example.com ls     # one command on another Fling
```

`fling logout` signs you out of the current Fling. `fling logout <address>` signs you out of
another and forgets it.

In CI, set `FLING_URL` to your Fling's address and `FLING_API_KEY` to a key instead of signing in.

## Staying up to date

When your Fling runs a newer release than your CLI, the CLI says so after a command, at most once a
day:

```
▲ Fling 1.2.0 is out (this CLI is 1.1.0). Update: npm i -g {{fact:cli-package}}@latest && fling setup
```

Run that line. `fling setup` then updates the Claude Code plugin and the Claude Desktop extension
too. Restart Claude afterwards. Set `FLING_NO_UPDATE_CHECK` to anything to stop the reminder.

## When it goes wrong

Run `fling doctor` first:

```sh
fling doctor
```

It checks the CLI and Node.js, your saved sign-ins, each Fling you use, the Claude Code plugin and
the Claude Desktop extension, and prints one line per check: `✔` fine, `▲` a warning, `✖` a
problem, each warning and problem with its fix. It only looks; it changes nothing.

- **"No Fling server set".** Run `fling setup {{instance:origin}}` or `fling login
  {{instance:origin}}`. The CLI has no Fling built in.
- **"Not logged in", or exit code 2.** Your key was revoked or the sign-in expired. Run `fling
  login` to sign in again.
- **`fling` is not found after installing.** Your npm's global folder is not on your `PATH`. Use
  the `npx` form above, or ask whoever looks after your computer.
- **A command needs a feature your Fling lacks.** The CLI says the Fling can't do it yet. Ask
  whoever runs {{instance:name}}, or leave that option out.

## Good to know

- Each `fling login` makes a key for this computer. See and revoke them under **CLI logins** on the
  **Connections** page of the web app.
- `fling help <command>` explains any command. Add `--json` to any command for output a script can
  read.
