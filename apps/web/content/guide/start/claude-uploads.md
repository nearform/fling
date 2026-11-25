---
title: Let Claude upload its files
part: start
order: 25
summary: Allow your Fling in Claude's settings once, so Claude publishes the files it makes without typing them out again.
requires: [sandboxUpload]
sources: [packages/shared/src/sandbox-upload.ts, packages/shared/src/mcp-tools.ts, apps/api/src/mcp/publish.ts, apps/cli/src/mcp.ts]
verified: 0ead0eb
---

When Claude builds you a page, a report or a small site with code execution, the files are in
Claude's sandbox, in the cloud. Claude uploads them from there straight to {{instance:name}}, so it
never has to type every file out again in the chat. Typing them out is slow and costly, and it can
break a big site or an image.

Claude's sandbox can only reach the websites Claude's settings allow. Until `{{instance:host}}` is
one of them, Claude can't upload, so it stops and asks you to allow it. You do this once.

## In your assistant

When Claude can't reach {{instance:name}}, it says something like:

> Claude's code-execution sandbox can't reach {{instance:host}}, so Claude can't upload files to
> Fling directly.

It publishes nothing and leaves your files as they are. Allow the host, then tell Claude:

- "Done, I've allowed it. Try again"

Claude runs the upload again in the same chat and gives you the link. If more than
{{fact:upload-window}} have passed, it starts a fresh upload first. If you'd rather not change
the setting, say "Type the files out instead" and Claude publishes them inline.

## Allow {{instance:host}}

The setting is on claude.ai in a web browser, even if you use the Claude Desktop app.

**On a Pro or Max plan**, you change it yourself:

1. Open claude.ai in your browser and go to **Settings → Capabilities**.
2. Under **Code execution and file creation**, turn on **Allow network egress**.
3. Add `{{instance:host}}` to **Additional allowed domains**.

**On a Team or Enterprise plan**, only an Owner can change it, for everyone at once, in
**Organization settings → Capabilities**. Send them this:

> Please allow `{{instance:host}}` for Claude's code execution: on claude.ai, Organization settings
> → Capabilities → Code execution and file creation → Additional allowed domains. It lets Claude
> publish the files it makes to {{instance:name}} directly, instead of typing them out in the chat.

**On the Free plan**, only package managers can be allowed, so Claude can't upload. Ask it to type
the files out instead.

The change applies at once, in chats you already have open.

## When it goes wrong

- **Claude still says it can't reach {{instance:host}}.** Check the address you added: it is
  `{{instance:host}}`, with nothing before or after it. Check too that **Allow network egress** is
  on.
- **Claude doesn't upload at all, and types the files out.** Code execution is off. Turn it on in
  **Settings → Capabilities** on claude.ai, then ask again. For a big site, Claude suggests this
  itself.
- **The upload fails with another error.** Claude shows what it printed. An upload is open for
  {{fact:upload-window}}; after that, Claude starts a new one.

## Good to know

- Only `{{instance:host}}` needs allowing: nothing else, and no storage service.
- The address Claude uploads to works for that one upload only, and only stores the files.
  Publishing them is a separate step, signed in as you, with the same checks as any publish.
  Dotfiles in the upload are left out, and Claude tells you which.
- With the [Claude Desktop extension](/guide/start/claude-desktop), files already on your computer,
  Cowork's among them, are published from there, with nothing to allow.
