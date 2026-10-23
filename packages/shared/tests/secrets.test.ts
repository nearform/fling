import { describe, expect, it } from 'vitest'
import { isValidSitePath, ManifestSchema } from '../src/manifest.ts'
import {
  describeSecretFindings,
  forbiddenPathReason,
  isScannablePath,
  isSecretPath,
  SECRET_SCAN_MAX_FILE_BYTES,
  scanBytesForSecrets,
  scanForSecrets,
} from '../src/secrets.ts'

// Every fake secret below is assembled at runtime so this file never contains a real-looking
// key (GitHub push protection, secret scanners).
const j = (...parts: string[]) => parts.join('')
const alnum = (n: number, seed = 'aB3xK9mQ2pL7') =>
  Array.from({ length: n }, (_, i) => seed[i % seed.length]).join('')

const FAKE = {
  privateKey: j(
    '-----BEGIN RSA ',
    'PRIVATE KEY-----\n',
    'MIIEow',
    alnum(58),
    '\n',
    alnum(64),
    '\n-----END RSA ',
    'PRIVATE KEY-----'
  ),
  openSshKey: j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\n', 'b3BlbnNzaC1rZXktdjEAAAAA', alnum(40)),
  encryptedPem: j(
    '-----BEGIN RSA ',
    'PRIVATE KEY-----\n',
    'Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF\n\n',
    alnum(64)
  ),
  pgp: j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\n', 'Version: x\n\n', alnum(64)),
  awsKeyId: j('AKIA', 'Q'.repeat(16)),
  awsStsKeyId: j('ASIA', 'Z7'.repeat(8)),
  awsSecret: j('aws_secret_access_key = ', alnum(40, 'Ab/9+Zq')),
  github: j('ghp', '_', alnum(36)),
  githubPat: j('github', '_pat_', alnum(82)),
  npm: j('npm', '_', alnum(36)),
  slack: j('xox', 'b-', '123456789012-', '1234567890123-', alnum(24)),
  slackWebhook: j('https://hooks.slack', '.com/services/', 'T0ABCDEFG/', 'B0ABCDEFG/', alnum(24)),
  stripe: j('sk', '_live_', alnum(24)),
  stripeRestricted: j('rk', '_live_', alnum(30)),
  googleOAuth: j('GOC', 'SPX-', alnum(28)),
  openaiProject: j('sk-', 'proj-', alnum(60)),
  openaiLegacy: j('sk-', alnum(20), 'T3Blbk', 'FJ', alnum(20)),
  anthropic: j('sk-', 'ant-', 'api03-', alnum(90)),
  sendgrid: j('SG', '.', alnum(22), '.', alnum(43)),
  azure: j('DefaultEndpointsProtocol=https;AccountName=x;Account', 'Key=', alnum(86), '=='),
  databaseUrl: j('postgres://app:', 'Hunter2', 'Zz9@db.prod.internal:5432/app'),
}

describe('isValidSitePath', () => {
  it('rejects every dot segment', () => {
    for (const p of [
      '.env',
      '.dev.vars',
      '.git/config',
      '.npmrc',
      '.well-known/security.txt',
      'a/.secret',
      'a/.hidden/b.html',
      '.',
      '..',
      'a/../b',
    ])
      expect(isValidSitePath(p), p).toBe(false)
  })

  it('accepts normal paths, including dots inside names', () => {
    for (const p of ['index.html', 'a/b.c.html', 'img/logo.png', 'v1.2/app.js', 'a/b./c'])
      expect(isValidSitePath(p), p).toBe(true)
  })

  it('makes ManifestSchema refuse dotfiles and secret files', () => {
    const file = (path: string) => ({ path, sha256: 'a'.repeat(64), size: 1, contentType: 'x' })
    expect(ManifestSchema.safeParse({ files: [file('index.html')] }).success).toBe(true)
    expect(ManifestSchema.safeParse({ files: [file('.env')] }).success).toBe(false)
    expect(ManifestSchema.safeParse({ files: [file('certs/server.pem')] }).success).toBe(false)
  })
})

describe('isSecretPath', () => {
  it.each([
    'server.pem',
    'certs/server.KEY',
    'a.p12',
    'a.pfx',
    'release.jks',
    'debug.keystore',
    'id_rsa',
    'home/id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'id_rsa_old',
    'id_ed25519.bak',
    'credentials',
    'aws/Credentials',
    'credentials.json',
    'my-service-account.json',
    'gcp-service-account-prod.json',
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'prod.tfvars',
    'prod.tfvars.json',
    'secrets.json',
    'config/secrets.yml',
    'secrets.yaml',
    'vault.kdbx',
    'wp-config.php',
    '.htpasswd',
  ])('%s is a secret file', path => expect(isSecretPath(path)).toBe(true))

  it.each([
    'index.html',
    'id_rsa.pub',
    'id_ed25519.pub',
    'keys.html',
    'key.js',
    'monkey.png',
    'credentials/index.html',
    'credentials.html',
    'secrets.md',
    'service-account.md',
    'tfstate.txt',
    'wp-config-sample.php',
    'pem',
    'docs/keystore-guide.html',
  ])('%s is not a secret file', path => expect(isSecretPath(path)).toBe(false))

  it('forbiddenPathReason', () => {
    expect(forbiddenPathReason('.env')).toBe('dotfile')
    expect(forbiddenPathReason('a/.dev.vars')).toBe('dotfile')
    expect(forbiddenPathReason('server.key')).toBe('secret_file')
    expect(forbiddenPathReason('index.html')).toBeNull()
  })
})

describe('scanForSecrets', () => {
  it.each(Object.entries(FAKE))('detects %s', (_, secret) => {
    const text = `line one\nconst x = "${secret}"\nline three`
    const findings = scanForSecrets(text, 'app.js')
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]).toMatchObject({ path: 'app.js', line: 2 })
  })

  it('names the rule', () => {
    const rules = (s: string) => scanForSecrets(s, 'f').map(f => f.rule)
    expect(rules(FAKE.awsKeyId)).toEqual(['aws-access-key-id'])
    expect(rules(FAKE.privateKey)).toEqual(['private-key'])
    expect(rules(FAKE.github)).toEqual(['github-token'])
    expect(rules(FAKE.anthropic)).toEqual(['anthropic-api-key'])
    expect(rules(FAKE.databaseUrl)).toEqual(['database-url-password'])
  })

  it('reports the right line numbers, once per rule and line, sorted', () => {
    const text = ['ok', FAKE.github, 'ok', `${FAKE.awsKeyId} ${FAKE.awsKeyId}`, FAKE.npm].join('\n')
    expect(scanForSecrets(text, 'x.txt')).toEqual([
      { path: 'x.txt', line: 2, rule: 'github-token' },
      { path: 'x.txt', line: 4, rule: 'aws-access-key-id' },
      { path: 'x.txt', line: 5, rule: 'npm-token' },
    ])
  })

  it('allows documented examples and placeholders', () => {
    const ok = [
      j('AKIA', 'IOSFODNN7', 'EXAMPLE'),
      j('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'EXAMPLEKEY'),
      j('ghp', '_', 'x'.repeat(36)),
      j('sk', '_live_', 'xxxx', alnum(24)),
      'postgres://user:password@db.prod.internal/app',
      'postgres://app:s3cretValue@localhost:5432/app',
      'mysql://root:${DB_PASSWORD}@db.prod.internal/app',
      'mongodb+srv://<user>:<password>@cluster0.mongodb.net',
      'redis://:changeme@cache.example.com',
      '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
      'const header = "-----BEGIN PRIVATE KEY-----";',
      'xoxb-your-token-here',
      'sk-ant-...',
      'sk-1234',
      j('AI', 'za', alnum(35)), // browser API keys are public by design: not flagged
      'just some text with key=value and password=hunter2',
    ]
    for (const text of ok) expect(scanForSecrets(text, 'f'), text).toEqual([])
  })

  it('never puts the secret in findings or messages', () => {
    const text = Object.values(FAKE).join('\n')
    const findings = scanForSecrets(text, 'all.txt')
    expect(findings.length).toBeGreaterThanOrEqual(Object.keys(FAKE).length)
    const rendered = JSON.stringify(findings) + describeSecretFindings(findings).join('\n')
    for (const secret of Object.values(FAKE)) {
      expect(rendered).not.toContain(secret)
      expect(rendered).not.toContain(secret.slice(-16))
    }
    expect(describeSecretFindings(findings)[0]).toMatch(/^all\.txt line 1: private key$/)
  })
})

describe('scanBytesForSecrets', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  it('scans text files', () => {
    expect(scanBytesForSecrets(bytes(`k=${FAKE.awsKeyId}`), 'config.js')).toHaveLength(1)
    expect(scanBytesForSecrets(bytes(`k=${FAKE.awsKeyId}`), 'Makefile')).toHaveLength(1)
  })

  it('skips binary content (NUL in the first 8 KB) and binary formats', () => {
    const binary = new Uint8Array([0, 1, 2, ...bytes(FAKE.awsKeyId)])
    expect(scanBytesForSecrets(binary, 'data.txt')).toEqual([])
    expect(scanBytesForSecrets(bytes(FAKE.awsKeyId), 'photo.png')).toEqual([])
    expect(isScannablePath('photo.PNG')).toBe(false)
    expect(isScannablePath('app.js')).toBe(true)
    expect(isScannablePath('README')).toBe(true)
  })

  it('skips files over the scan limit', () => {
    const big = new Uint8Array(SECRET_SCAN_MAX_FILE_BYTES + 1).fill(0x61)
    big.set(bytes(FAKE.awsKeyId), 10)
    expect(scanBytesForSecrets(big, 'big.txt')).toEqual([])
  })
})
