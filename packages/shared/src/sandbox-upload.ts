/**
 * Sandbox uploads: how files Claude made in its code-execution sandbox reach Fling without passing
 * through the conversation. fling_upload_begin returns a signed archive URL on the instance's own
 * host and `sandboxUploadScript` around it; Claude runs the script in its sandbox, which zips the
 * folder (or the one file) and PUTs the zip in parts; fling_upload_finish, the user's own call,
 * unpacks and publishes it. The URL can only store parts of that upload's zip: nothing goes live
 * without fling_upload_finish.
 *
 * The script is Python with only the standard library (zipfile, urllib), which every sandbox has,
 * and it prints one line Claude acts on:
 *
 *   FLING_UPLOADED <parts> part(s), <bytes> bytes   → call fling_upload_finish
 *   FLING_UPLOAD_BLOCKED <host>: <reason>           → the sandbox can't reach the host: stop and
 *                                                     tell the user which host to allow, and where
 *   FLING_UPLOAD_FAILED <status> <message>          → Fling refused a part (expired, too large…)
 *
 * A sandbox's network goes through a proxy that refuses hosts it isn't told to allow, either at
 * CONNECT ("Tunnel connection failed: 403") or with a 403 carrying `X-Proxy-Error`; both are
 * BLOCKED.
 *
 * It names itself in User-Agent: edges that screen bots (Cloudflare's browser integrity check)
 * refuse urllib's default one with a 403 (error 1010).
 */

import { GUIDE_ROUTE } from './guide.ts'

/** One PUT's body: under the API's 4 MB request limit and AWS Lambda's 6 MB once base64-encoded. */
export const ARCHIVE_PART_BYTES = 3 * 1024 * 1024

/** The path of an upload's archive route, below the API (`/api`). */
export const archiveUploadPath = (uploadId: string) => `/uploads/${uploadId}/archive`

/** The lines the script prints, for the tool descriptions. */
export const SANDBOX_UPLOAD_OUTCOMES = {
  uploaded: 'FLING_UPLOADED',
  blocked: 'FLING_UPLOAD_BLOCKED',
  failed: 'FLING_UPLOAD_FAILED',
} as const

/** The host a sandbox must be allowed to reach for `url`, e.g. `fling.example.com`. */
export const sandboxUploadHost = (url: string) => new URL(url).host

/**
 * The shell command Claude runs in its sandbox: `<path>` is the only thing it replaces (a folder,
 * or one file). `url` is the signed archive URL, already carrying `exp` and `sig`.
 */
export function sandboxUploadScript(url: string): string {
  const host = sandboxUploadHost(url)
  return `python3 - '<path>' <<'FLING'
import io, os, sys, time, zipfile, urllib.request, urllib.error
URL = ${JSON.stringify(url)}
HOST = ${JSON.stringify(host)}
PART = ${ARCHIVE_PART_BYTES}
UA = "fling-sandbox-upload/1"
src = os.path.abspath(sys.argv[1])
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    if os.path.isdir(src):
        for root, dirs, files in os.walk(src):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "node_modules")
            for f in sorted(files):
                if not f.startswith("."):
                    p = os.path.join(root, f)
                    z.write(p, os.path.relpath(p, src))
    elif os.path.isfile(src):
        name = os.path.basename(src)
        z.write(src, "index.html" if name.lower().endswith((".html", ".htm")) else name)
    else:
        sys.exit("FLING_UPLOAD_FAILED 0 nothing at " + src)
data = buf.getvalue()
parts = [data[i:i + PART] for i in range(0, len(data), PART)]
for n, chunk in enumerate(parts):
    for attempt in range(3):
        req = urllib.request.Request("%s&part=%d&of=%d" % (URL, n, len(parts)), data=chunk,
                                     method="PUT", headers={"content-type": "application/zip", "user-agent": UA})
        try:
            urllib.request.urlopen(req, timeout=120).read()
            break
        except urllib.error.HTTPError as e:
            proxy = e.headers.get("x-proxy-error")
            if proxy:
                sys.exit("FLING_UPLOAD_BLOCKED %s: %s" % (HOST, proxy))
            if e.code < 500 or attempt == 2:
                sys.exit("FLING_UPLOAD_FAILED %d %s" % (e.code, e.read().decode("utf-8", "replace")[:400]))
        except urllib.error.URLError as e:
            if "tunnel" in str(e.reason).lower() or attempt == 2:
                sys.exit("FLING_UPLOAD_BLOCKED %s: %s" % (HOST, e.reason))
        time.sleep(2 ** attempt)
print("FLING_UPLOADED %d part(s), %d bytes" % (len(parts), len(data)))
FLING`
}

/** The Guide page that walks the user through allowing the host, on the instance at `appOrigin`. */
export const sandboxUploadGuideUrl = (appOrigin: string) =>
  `${appOrigin}${GUIDE_ROUTE}/start/claude-uploads`

/**
 * Where the host is allowed, said to the user when the script prints BLOCKED (and in the deploy
 * guides). Claude's code-execution sandbox reaches only the hosts its settings allow; the setting
 * is on claude.ai in a web browser, whichever Claude app the user is in.
 */
export const sandboxAllowAdvice = (host: string, guideUrl: string) =>
  `Claude's code-execution sandbox can't reach ${host}, so Claude can't upload files to Fling directly. ` +
  'To allow it, open claude.ai in a web browser (even if you use the Claude Desktop app): Settings → ' +
  `Capabilities, under Code execution and file creation turn on Allow network egress, and add ${host} ` +
  'to Additional allowed domains. On a Team or Enterprise plan only an Owner can, in Organization settings ' +
  '→ Capabilities, so ask them; on the Free plan only package managers can be allowed. Then tell Claude ' +
  `it's done and it uploads the files. Step by step: ${guideUrl}`

/**
 * What Claude does when the sandbox can't reach the host: stop and have the host allowed. It never
 * falls back to sending the files inline on its own, nor reworks the content to make that cheaper.
 */
export const SANDBOX_BLOCKED_NOTE =
  'Stop there: do not publish, and never change, shrink or redraw the content. Tell the user to allow the ' +
  'host, with what `allowAdvice` says (which host, and where), and to tell you once it is allowed; then run ' +
  'the same script again (if it says the upload expired, call fling_upload_begin again and run the new ' +
  'script). Publish inline with fling_publish only if the user asks you to.'

/** When inline content is big enough to be worth turning code execution on for. */
export const INLINE_LARGE = 'more than a few files, or more than about 50 KB in total'

/** What fling_upload_begin says, on the remote server and the local one (`fileTool: false`). */
export function describeUploadBegun(
  upload: { id: string; name: string; path?: string; expiresAt: string },
  sandbox: { script: string; allowAdvice: string },
  opts: { fileTool?: boolean } = {}
): string {
  const into = upload.path ? `, into /${upload.path}/` : ''
  return [
    `Upload ${upload.id} started for "${upload.name}"${into}. It expires at ${upload.expiresAt}.`,
    'From your code-execution sandbox: run this, with <path> replaced by the folder (or the one file) to ' +
      `publish, then call fling_upload_finish with uploadId "${upload.id}".`,
    sandbox.script,
    `If it prints ${SANDBOX_UPLOAD_OUTCOMES.blocked}, the sandbox can't reach Fling. ${SANDBOX_BLOCKED_NOTE} ` +
      `allowAdvice: "${sandbox.allowAdvice}"`,
    ...(opts.fileTool === false
      ? []
      : [
          `Without a sandbox, send each file with fling_upload_file (uploadId "${upload.id}"), then call fling_upload_finish.`,
        ]),
  ].join('\n\n')
}
