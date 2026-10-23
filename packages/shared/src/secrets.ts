/**
 * Secrets guard (browser-safe, dependency-free) — used by the CLI, the local MCP server and the
 * API, so every way of flinging applies the same rules:
 *
 * - `isSecretPath(path)`: file names that are secrets by nature (private keys, keystores,
 *   credentials files, Terraform state…). Always refused; there is no override.
 * - `scanForSecrets(text, path)`: well-known, high-precision token / key patterns in file
 *   contents. Any finding refuses the deploy; there is no override.
 *
 * Findings carry only the path, the line and the rule — never the matched value — so error
 * messages and logs can't leak the secret they are reporting.
 *
 * Deliberately not detected (too noisy for a hard error with no override): browser API keys that
 * are public by design (e.g. Google Maps / Firebase `AIza…` keys), JWTs, generic "password ="
 * assignments and high-entropy strings.
 */

/** Files bigger than this are not scanned (the deploy still goes ahead). */
export const SECRET_SCAN_MAX_FILE_BYTES = 5 * 1024 * 1024
/** A NUL byte in the first this-many bytes marks a file as binary (not scanned). */
export const BINARY_SNIFF_BYTES = 8192

// ---- secret file names --------------------------------------------------------------------

const SECRET_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.tfstate',
  '.tfstate.backup',
  '.tfvars',
  '.tfvars.json',
  '.kdbx',
]
const SECRET_NAMES = new Set([
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'wp-config.php',
  '.htpasswd',
])
const SSH_KEY_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)/

/**
 * Is this a file that holds secrets by its very name (case-insensitive, on the file name)?
 * SSH public keys (`id_rsa.pub`) are allowed. Directory names are not matched, so a docs page at
 * `credentials/index.html` is fine.
 */
export function isSecretPath(path: string): boolean {
  const name = (path.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  if (!name) return false
  if (SECRET_NAMES.has(name)) return true
  if (SECRET_EXTENSIONS.some(ext => name.endsWith(ext) && name.length > ext.length)) return true
  if (/service[-_]account.*\.json$/.test(name)) return true
  if (SSH_KEY_RE.test(name) && !name.endsWith('.pub')) return true
  return false
}

// ---- secret contents ----------------------------------------------------------------------

export interface SecretFinding {
  path: string
  /** 1-based */
  line: number
  /** rule id (see SECRET_RULE_LABELS) */
  rule: string
}

interface Rule {
  id: string
  label: string
  re: RegExp
  /** The match is a placeholder / documentation example (not a secret). */
  allow?: (match: RegExpExecArray) => boolean
}

const PLACEHOLDER_RE = /example|xxxx/i
const isPlaceholder = (m: RegExpExecArray) => PLACEHOLDER_RE.test(m[0])

const DB_PASSWORD_PLACEHOLDER =
  /^(?:password|passw(?:or)?d|pass|pwd|secret|changeme|example|test|admin|root|postgres|mysql|redis|guest|user|\*+|x+|\.+)$/i
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|db|host|hostname)(?::\d+)?$/i

const RULES: Rule[] = [
  {
    id: 'private-key',
    label: 'private key',
    // The header, optional RFC 1421 headers (Proc-Type, DEK-Info, Version), then key material.
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[ \t]*\r?\n(?:[A-Za-z-]+:[^\n]*\r?\n)*(?:[ \t]*\r?\n)?[ \t]*[A-Za-z0-9+/=]{40,}/g,
  },
  {
    id: 'aws-access-key-id',
    label: 'AWS access key ID',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    allow: isPlaceholder,
  },
  {
    id: 'aws-secret-access-key',
    label: 'AWS secret access key',
    re: /\b(?:aws_?)?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    allow: isPlaceholder,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{80,})/g,
    allow: isPlaceholder,
  },
  { id: 'npm-token', label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, allow: isPlaceholder },
  {
    id: 'slack-token',
    label: 'Slack token',
    re: /\bxox[abposr]-[0-9]{6,}-[A-Za-z0-9-]{10,}/g,
    allow: isPlaceholder,
  },
  {
    id: 'slack-webhook',
    label: 'Slack webhook URL',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/g,
    allow: isPlaceholder,
  },
  {
    id: 'stripe-live-key',
    label: 'Stripe live key',
    re: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/g,
    allow: isPlaceholder,
  },
  {
    id: 'google-oauth-client-secret',
    label: 'Google OAuth client secret',
    re: /\bGOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])/g,
    allow: isPlaceholder,
  },
  {
    id: 'openai-api-key',
    label: 'OpenAI API key',
    re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
    allow: isPlaceholder,
  },
  {
    id: 'anthropic-api-key',
    label: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{80,}/g,
    allow: isPlaceholder,
  },
  {
    id: 'sendgrid-api-key',
    label: 'SendGrid API key',
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    allow: isPlaceholder,
  },
  {
    id: 'azure-storage-key',
    label: 'Azure storage account key',
    re: /\bAccountKey=[A-Za-z0-9+/]{80,}={0,2}/g,
    allow: isPlaceholder,
  },
  {
    id: 'database-url-password',
    label: 'database URL with a password',
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@"'`<>]+:([^@\s/"'`<>]{3,})@([^\s/?#"'`<>]+)/g,
    allow: m => {
      const password = m[1] ?? ''
      const host = m[2] ?? ''
      return (
        DB_PASSWORD_PLACEHOLDER.test(password) ||
        /[${}%]/.test(password) ||
        PLACEHOLDER_RE.test(password) ||
        LOCAL_HOST.test(host) ||
        /(?:^|\.)example(?:\.[a-z]+)?(?::\d+)?$/i.test(host)
      )
    },
  },
]

/** rule id → what it is, for messages. */
export const SECRET_RULE_LABELS: Record<string, string> = Object.fromEntries(
  RULES.map(r => [r.id, r.label])
)

/** 1-based line of `index` in a text whose line starts are `starts`. */
function lineAt(starts: number[], index: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Secrets in a text file: one finding per rule and line, sorted by line. Never the value. */
export function scanForSecrets(text: string, path: string): SecretFinding[] {
  let starts: number[] | undefined
  const findings: SecretFinding[] = []
  const seen = new Set<string>()
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    for (let m = rule.re.exec(text); m !== null; m = rule.re.exec(text)) {
      if (m[0].length === 0) rule.re.lastIndex++
      if (rule.allow?.(m)) continue
      if (!starts) {
        starts = [0]
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
      }
      const line = lineAt(starts, m.index)
      const key = `${rule.id}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push({ path, line, rule: rule.id })
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif webp avif ico bmp tif tiff heic psd ' +
    'woff woff2 ttf otf eot ' +
    'mp3 mp4 m4a m4v mov webm ogg oga ogv wav flac aac avi mkv ' +
    'zip gz tgz br zst bz2 xz 7z rar ' +
    'wasm pdf glb gltf-binary bin dat'
  )
    .split(/\s+/)
    .filter(Boolean)
)

/** Worth reading to scan? (Everything except well-known binary formats.) */
export function isScannablePath(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 || !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** A NUL byte near the start → binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

/**
 * Scan a file's bytes: skipped (no findings) when the path is a binary format, it is bigger than
 * SECRET_SCAN_MAX_FILE_BYTES, or it looks binary; otherwise decoded as UTF-8 and scanned.
 */
export function scanBytesForSecrets(bytes: Uint8Array, path: string): SecretFinding[] {
  if (!isScannablePath(path) || bytes.length > SECRET_SCAN_MAX_FILE_BYTES || looksBinary(bytes))
    return []
  return scanForSecrets(new TextDecoder('utf-8').decode(bytes), path)
}

/** `config.js line 12: AWS access key ID` — one per finding, at most `max` (then "… and N more"). */
export function describeSecretFindings(findings: readonly SecretFinding[], max = 20): string[] {
  const lines = findings
    .slice(0, max)
    .map(f => `${f.path} line ${f.line}: ${SECRET_RULE_LABELS[f.rule] ?? f.rule}`)
  if (findings.length > max) lines.push(`… and ${findings.length - max} more`)
  return lines
}

/** Why a path can never be published (dotfile or secret file name), or null if it can. */
export function forbiddenPathReason(path: string): 'dotfile' | 'secret_file' | null {
  if (path.split('/').some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..'))
    return 'dotfile'
  if (isSecretPath(path)) return 'secret_file'
  return null
}

export const NEVER_PUBLISHED_NOTE =
  'Fling never publishes dotfiles, gitignored files, secret files (keys, certificates, credentials) or files that contain secrets.'
