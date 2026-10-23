import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { CommandLine } from '../components/CopyButton'
import { PageHeader } from '../components/PageHeader'

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="surface-panel space-y-3">
      <h2 className="flex items-center gap-2.5 text-base">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full tone-primary border text-xs font-semibold">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

/** The CLI quick start — also rendered by the Sites page when there are no sites yet. */
export function QuickStart() {
  return (
    <div className="space-y-4">
      <Step n={1} title="Install the CLI">
        <p className="text-sm text-secondary">
          Install it once and you get a <code>fling</code> command everywhere (Node 22 or later).
        </p>
        <CommandLine command="npm install -g @nearform/fling" />
        <p className="text-xs text-muted">
          Can’t install globally? Every command also works as <code>npx @nearform/fling …</code>,
          e.g. <code>npx @nearform/fling login</code>.
        </p>
      </Step>
      <Step n={2} title="Log in">
        <p className="text-sm text-secondary">
          Opens a browser to sign in with your Nearform Google account, then stores a key in{' '}
          <code>~/.fling/config.json</code>.
        </p>
        <CommandLine command="fling login" />
      </Step>
      <Step n={3} title="Fling a folder">
        <p className="text-sm text-secondary">
          Point it at your build output. You get back a stable URL,{' '}
          <code>https://my-app.fling.labs.nearform.com</code>, that only signed-in Nearformers can
          open. Fling it again to update; identical content is a no-op.
        </p>
        <CommandLine command="fling ./dist --name my-app" />
      </Step>
    </div>
  )
}

export default function GetStarted() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Get started"
        description="Put a folder of static files online in one command, from your terminal, Claude Code or Claude."
      />
      <div className="space-y-4">
        <QuickStart />
        <Step n={4} title="Or let Claude Code do it">
          <p className="text-sm text-secondary">
            Add the Fling plugin. It brings a <code>fling</code> skill and an MCP server that reuse
            your CLI login, so you can just ask Claude to “fling this”.
          </p>
          <CommandLine command="/plugin marketplace add nearform/fling" />
          <CommandLine command="/plugin install fling@fling" />
        </Step>
        <Step n={5} title="Add to Claude (Desktop, web, mobile)">
          <p className="text-sm text-secondary">
            Let Claude publish what it makes for you. In Claude, open{' '}
            <strong className="font-medium text-base-content">
              Settings → Connectors → Add custom connector
            </strong>
            , paste this URL, then click Connect and sign in with your Nearform Google account.
          </p>
          <CommandLine command={`${window.location.origin}/mcp`} />
          <p className="text-sm text-secondary">
            On a Team or Enterprise plan, an Owner can add it once for the whole organisation;
            everyone then just clicks Connect. Then try:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-secondary">
            <li>“Fling this page as q3-report”</li>
            <li>“Make a one-page summary of this doc and fling it, private”</li>
            <li>“Give me a share link for q3-report”</li>
            <li>“Which of my Fling sites can I archive?”</li>
          </ul>
          <p className="text-xs text-muted">
            Claude sends the files it made straight to Fling, up to 4 MB in one go (bigger sites in
            parts). See or disconnect it under Connections.
          </p>
        </Step>
        <Step n={6} title="Fling files from your computer (Claude Desktop)">
          <p className="text-sm text-secondary">
            Install the Fling extension so Claude Desktop can fling files you’ve downloaded: just
            say “fling Pitch-Deck.html” and it finds it in Downloads, Desktop or Claude’s outputs.
            Single HTML files and zips work too. Double-click the file (or drag it into Claude) and
            sign in when asked.
          </p>
          <a className="btn btn-primary btn-sm gap-2" href="/downloads/fling.mcpb" download>
            <ArrowDownTrayIcon className="h-4 w-4" />
            Download Fling for Claude Desktop
          </a>
          <p className="text-xs text-muted">
            Or install it from Settings → Extensions → Advanced settings → Install Extension…
          </p>
        </Step>

        <section className="surface-panel space-y-3 text-sm">
          <h2 className="text-base">Good to know</h2>
          <ul className="list-disc space-y-2 pl-5 text-secondary">
            <li>
              <strong className="font-medium text-base-content">Names:</strong> each site lives at{' '}
              <code>&lt;name&gt;.fling.labs.nearform.com</code>. Names are shared across everyone
              and first come, first served. If yours is taken, Fling suggests a free one with your
              initials, like <code>my-app-cc</code>. Deleting a site frees its name; archiving keeps
              it.
            </li>
            <li>
              <strong className="font-medium text-base-content">Single-page apps:</strong> add{' '}
              <code>--spa</code> so unknown paths fall back to <code>/index.html</code> and
              client-side routes survive a refresh.
            </li>
            <li>
              <strong className="font-medium text-base-content">Private by default:</strong> sites
              are visible to signed-in Nearformers only. Make one public with <code>--public</code>{' '}
              or from the Sites page.
            </li>
            <li>
              <strong className="font-medium text-base-content">Share links:</strong> to show a
              private site to someone outside Nearform, create a share link. Anyone with it can open
              the site. Refresh it to rotate (the old link stops working) or revoke it.
            </li>
            <li>
              <strong className="font-medium text-base-content">Rollback:</strong> every fling is
              kept as a version. Restore an older one from the Sites page, or re-fling the old
              content.
            </li>
            <li>
              <strong className="font-medium text-base-content">Limits:</strong> 100 MB per fling,
              25 MB per file. Dotfiles are skipped; add a <code>.flingignore</code> to skip more.
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
