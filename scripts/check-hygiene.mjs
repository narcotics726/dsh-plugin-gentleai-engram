#!/usr/bin/env node
/**
 * Repository hygiene gate for dsh-plugin-gentleai-engram.
 *
 * Blocks the leak classes this repository has actually hit, or that the runtime
 * probe makes easy to hit:
 *
 *   1. secrets in file contents or commit messages — delegated to secretlint
 *      (rule preset "recommend": AWS/GCP/GitHub/Slack tokens, private keys,
 *      JWT, npm tokens, …)
 *   2. machine-specific paths and personal email addresses in file contents
 *      or commit messages
 *   3. paths that must never be committed (.credentials.yaml, probe run
 *      artifacts, local DSH homes, pnpm store, private keys)
 *   4. a commit identity that is not a GitHub noreply address, so a work
 *      address cannot reach history again
 *
 * Usage:
 *   node scripts/check-hygiene.mjs --staged     # pre-commit: staged content
 *   node scripts/check-hygiene.mjs --worktree   # tracked files as they are
 *   node scripts/check-hygiene.mjs --history    # every blob + every message (pre-push, CI)
 *
 * A line containing "hygiene-allow" is skipped on purpose (escape hatch for
 * documentation that must quote a forbidden literal). Path and email patterns
 * are assembled from fragments so this file never matches itself.
 *
 * Runtime dependencies: Node built-ins + the repo's secretlint devDependency.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
process.chdir(repo)

const mode = process.argv.includes('--history')
  ? 'history'
  : process.argv.includes('--worktree')
    ? 'worktree'
    : 'staged'

const MODE_LABEL = { staged: '暂存区', worktree: '工作树', history: '全部历史' }[mode]

/** @type {{where: string, what: string, detail: string}[]} */
const findings = []
const add = (where, what, detail) => findings.push({ where, what, detail: String(detail) })

// ---------------------------------------------------------------- patterns
const SLASH = '/'

// Generic machine prefixes that are fine to document.
const ALLOWED_PATH_PREFIXES = [
  SLASH + 'tmp' + SLASH,
  SLASH + 'opt' + SLASH,
  SLASH + 'usr' + SLASH,
  SLASH + 'var' + SLASH,
  SLASH + 'private' + SLASH,
  SLASH + 'bin' + SLASH,
  SLASH + 'etc' + SLASH,
]

const PATH_RULES = [
  { label: '本机用户目录', re: new RegExp(SLASH + 'Users' + SLASH + '[A-Za-z0-9._-]+', 'g') },
  { label: '本机用户目录', re: new RegExp(SLASH + 'home' + SLASH + '[A-Za-z0-9._-]+', 'g') },
  { label: '本机卷路径', re: new RegExp(SLASH + 'Volumes' + SLASH + '[A-Za-z0-9._-]+', 'g') },
]

const EMAIL_RE = new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', 'g')
const ALLOWED_EMAIL_SUFFIXES = [
  '@users.noreply.github.com',
  '@example.com',
  '@example.org',
  '@localhost',
]
const ALLOWED_EMAIL_EXACT = new Set(['noreply@github.com'])
const EXTRA_ALLOWED_EMAILS = (process.env.HYGIENE_ALLOW_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const emailAllowed = (email) =>
  email.startsWith('git@') ||
  ALLOWED_EMAIL_EXACT.has(email) ||
  ALLOWED_EMAIL_SUFFIXES.some((suffix) => email.endsWith(suffix)) ||
  EXTRA_ALLOWED_EMAILS.includes(email)

// High-confidence token shapes. secretlint's preset is entropy/format based
// and misses bare AWS key ids and PEM headers, so these shapes are checked here
// too. Fragments keep this file from matching itself.
const SECRET_RULES = [
  { label: 'AWS Access Key ID', re: new RegExp('(AKIA|ASIA)[0-9A-Z]{16}', 'g') },
  { label: 'GitHub token', re: new RegExp('gh[pousr]_[A-Za-z0-9]{36,}', 'g') },
  { label: 'GitHub PAT', re: new RegExp('github_pat_[A-Za-z0-9_]{20,}', 'g') },
  { label: 'Slack token', re: new RegExp('xox[baprs]-[A-Za-z0-9-]{10,}', 'g') },
  { label: 'Anthropic key', re: new RegExp('sk-ant-[A-Za-z0-9_-]{20,}', 'g') },
  { label: 'OpenAI-style key', re: new RegExp('sk-[A-Za-z0-9]{32,}', 'g') },
  { label: 'Google API key', re: new RegExp('AIza[0-9A-Za-z_-]{35}', 'g') },
  { label: 'GitLab token', re: new RegExp('glpat-[A-Za-z0-9_-]{20,}', 'g') },
  { label: 'npm token', re: new RegExp('npm_[A-Za-z0-9]{36}', 'g') },
  { label: 'Hugging Face token', re: new RegExp('hf_[A-Za-z0-9]{30,}', 'g') },
  { label: '私钥头', re: new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----', 'g') },
  { label: 'JWT', re: new RegExp('eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.', 'g') },
  { label: 'AWS secret', re: new RegExp('aws_secret_access' + 'key\\s*[:=]', 'gi') },
  { label: '带密码的连接串', re: new RegExp('(postgres|postgresql|mysql|mongodb|redis|amqp|mssql)' + '://[^\\s:]+:[^\\s@]+@', 'g') },
]

const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.credentials(\.ya?ml)?$/, label: '凭据文件' },
  { re: /(^|\/)\.env(\..+)?$/, label: '.env 文件' },
  { re: /\.(pem|p12|pfx|jks|keystore)$/, label: '证书/私钥文件' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, label: 'SSH 私钥' },
  { re: /(^|\/)\.pnpm-store\//, label: 'pnpm store' },
  { re: /(^|\/)\.accept\//, label: '本地验收 DSH home' },
  { re: /(^|\/)scripts\/probe\/tmp\//, label: 'probe 本地 DSH home' },
  { re: /(^|\/)scripts\/probe\/out\//, label: 'probe 运行产物' },
]

// High-entropy package metadata, never a credential source; skipping it keeps
// secretlint fast and quiet.
const SECRETLINT_SKIP = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
]

// ---------------------------------------------------------------- scanners
function scanText(where, text) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('hygiene-allow')) continue
    for (const rule of PATH_RULES) {
      rule.re.lastIndex = 0
      let match
      while ((match = rule.re.exec(line)) !== null) {
        // A match glued to a preceding path character is part of a longer path
        // such as '/tmp/home/storages', not a user home directory.
        const before = match.index > 0 ? line[match.index - 1] : ''
        if (/[A-Za-z0-9._-]/.test(before)) continue
        if (!ALLOWED_PATH_PREFIXES.some((prefix) => match[0].startsWith(prefix))) {
          add(`${where}:${i + 1}`, rule.label, match[0])
        }
      }
    }
    EMAIL_RE.lastIndex = 0
    let email
    while ((email = EMAIL_RE.exec(line)) !== null) {
      if (!emailAllowed(email[0])) add(`${where}:${i + 1}`, '个人邮箱', email[0])
    }
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0
      let secret
      while ((secret = rule.re.exec(line)) !== null) {
        add(`${where}:${i + 1}`, rule.label, `${secret[0].slice(0, 12)}…`)
      }
    }
  }
}

function runSecretlint(targets) {
  if (targets.length === 0) return
  const bin = join(repo, 'node_modules', '.bin', 'secretlint')
  const args = [
    '--format',
    'compact',
    '--no-color',
    '--no-gitignore',
    '--secretlintrc',
    join(repo, '.secretlintrc.json'),
    ...targets,
  ]
  const result = spawnSync(bin, args, { encoding: 'utf8', cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) {
    add('secretlint', '无法执行 secretlint（pnpm install 是否完成？）', result.error.message)
    return
  }
  if (result.status === 0) return
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const line of lines.slice(0, 20)) add('secretlint', '疑似密钥', line)
  if (lines.length > 20) add('secretlint', '疑似密钥', `… 另有 ${lines.length - 20} 条`)
}

function secretlintTargets(paths) {
  return paths.filter((p) => !SECRETLINT_SKIP.some((re) => re.test(p)))
}

const isProbablyText = (buf) => !buf.includes(0)

// ---------------------------------------------------------------- collect
/** @type {Map<string, Buffer>} */
const files = new Map()

if (mode === 'staged') {
  const names = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  for (const name of names) {
    files.set(name, execFileSync('git', ['show', `:${name}`], { maxBuffer: 64 * 1024 * 1024 }))
  }
  const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim()
  if (!emailAllowed(email)) add('git config user.email', '提交身份不是 noreply 邮箱', email)
} else if (mode === 'worktree') {
  const names = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const name of names) files.set(name, readFileSync(name))
} else {
  const objects = execFileSync('git', ['rev-list', '--all', '--objects'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
  const firstPathByOid = new Map()
  for (const line of objects) {
    const space = line.indexOf(' ')
    if (space < 0) continue
    const oid = line.slice(0, space)
    const path = line.slice(space + 1)
    if (path && !firstPathByOid.has(oid)) firstPathByOid.set(oid, path)
  }
  const oids = [...firstPathByOid.keys()]
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: `${oids.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const blobOids = types
    .split('\n')
    .filter((line) => line.endsWith(' blob'))
    .map((line) => line.split(' ')[0])
  for (const oid of blobOids) {
    files.set(`${firstPathByOid.get(oid)} [${oid.slice(0, 8)}]`, execFileSync('git', ['cat-file', 'blob', oid], {
      maxBuffer: 64 * 1024 * 1024,
    }))
  }
  const messages = execFileSync('git', ['log', '--all', '--format=%H %ae %ce%n%B'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  scanText('commit messages', messages)
  for (const email of new Set(
    execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  )) {
    if (!emailAllowed(email)) add('历史提交身份', '非 noreply 邮箱', email)
  }
}

// ---------------------------------------------------------------- checks
for (const [path, buf] of files) {
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.re.test(path)) add(path, rule.label, '禁止提交的路径')
  }
  if (isProbablyText(buf)) scanText(path, buf.toString('utf8'))
}

const scratch = mkdtempSync(join(tmpdir(), 'hygiene-'))
try {
  const targets = []
  for (const [path, buf] of files) {
    const relative = path.replace(/ \[[0-9a-f]{8}\]$/, '')
    if (!secretlintTargets([relative]).length) continue
    const full = join(scratch, relative)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, buf)
    targets.push(full)
  }
  runSecretlint(targets.length ? [scratch] : [])
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------- report
if (findings.length === 0) {
  console.log(`hygiene: ok — ${MODE_LABEL} ${files.size} 个文件，无密钥/本机路径/个人邮箱/禁止路径`)
  process.exit(0)
}

console.error(`hygiene: 发现 ${findings.length} 处问题（${MODE_LABEL}）`)
for (const f of findings) console.error(`  - [${f.what}] ${f.where}: ${f.detail}`)
console.error('\n修掉后重试；确属文档需要引用的字面量可在该行加 "hygiene-allow" 注释跳过。')
process.exit(1)
