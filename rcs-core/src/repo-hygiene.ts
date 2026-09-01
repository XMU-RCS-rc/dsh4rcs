/**
 * 仓库卫生检查。
 *
 * R2 实测：21 个 `F407Practice.uvguix.<个人名>`、270 个 OBJ 产物入库，且三处仓库
 * 均无 `.gitignore`。这些文件每次提交都会制造冲突，也让 diff 无法阅读。
 */
import { join } from 'node:path'
import type { CheckResult, Finding, Severity } from './types.ts'
import { toResult } from './types.ts'
import { walkFiles, readText, relPath, fileExists, fileName } from './fsutil.ts'

export interface JunkPattern {
  id: string
  /** 匹配 basename 或相对路径的正则。 */
  pattern: string
  /** 对相对路径而非文件名匹配。 */
  matchPath?: boolean
  severity: Severity
  reason: string
}

export interface HygieneConfig {
  requireGitignore: boolean
  junk: JunkPattern[]
}

/** 默认规则，直接对着 R2 与 RCS_code 的实际问题设定。 */
export const DEFAULT_HYGIENE: HygieneConfig = {
  requireGitignore: true,
  junk: [
    { id: 'keil-user-gui', pattern: '\\.uvguix', severity: 'error', reason: 'Keil 个人 GUI 配置，每人一份，必然冲突' },
    { id: 'keil-user-opt', pattern: '\\.uvoptx$', severity: 'warn', reason: 'Keil 个人选项文件' },
    // matchPath 的模式用 (^|/) 而不是 ^：垃圾目录往往嵌在子工程下
    // （如 r2_proj/OBJ/），只锚定开头会全部漏掉。
    { id: 'build-output', pattern: '(^|/)(OBJ|Objects|Listings|build|DebugConfig)/', matchPath: true, severity: 'error', reason: '编译产物，应由构建生成' },
    { id: 'ctags-index', pattern: '^\\.tags', severity: 'warn', reason: '本地索引文件' },
    { id: 'editor-backup', pattern: '\\.(orig|acl-old|pre-final)$', severity: 'warn', reason: '编辑残留备份' },
    { id: 'agent-backup', pattern: '(^|/)\\.codex-backup/', matchPath: true, severity: 'warn', reason: '工具备份目录' },
    { id: 'pycache', pattern: '(^|/)__pycache__/', matchPath: true, severity: 'info', reason: 'Python 缓存' },
  ],
}

export function checkRepoHygiene(repoRoot: string, config: HygieneConfig = DEFAULT_HYGIENE): CheckResult {
  const findings: Finding[] = []

  if (config.requireGitignore && !fileExists(join(repoRoot, '.gitignore'))) {
    findings.push({
      rule: 'missing-gitignore',
      severity: 'error',
      message: '仓库根目录缺少 .gitignore',
      file: '.gitignore',
      detail: '没有 .gitignore，个人配置与编译产物会持续入库。',
    })
  }

  const gitignore = readText(join(repoRoot, '.gitignore'))

  // 为避免逐条刷屏，同一规则聚合成一条 Finding 并给出计数与样例
  const buckets = new Map<string, { rule: JunkPattern; files: string[] }>()

  // 关掉默认跳过：OBJ/、Listings/、.codex-backup/ 正是要找的目标。
  // 只排除 .git 与 node_modules —— 前者是 git 内部结构，后者量大且本就该忽略。
  const files = walkFiles(repoRoot, {
    noDefaultSkip: true,
    skipDirs: ['.git', 'node_modules'],
  })

  for (const f of files) {
    const rel = relPath(repoRoot, f)
    const base = fileName(f)
    for (const rule of config.junk) {
      const target = rule.matchPath ? rel : base
      if (new RegExp(rule.pattern).test(target)) {
        let b = buckets.get(rule.id)
        if (!b) {
          b = { rule, files: [] }
          buckets.set(rule.id, b)
        }
        b.files.push(rel)
        break
      }
    }
  }

  for (const { rule, files: hits } of buckets.values()) {
    const covered = gitignore.length > 0 && gitignore.split(/\r?\n/).some((line) => {
      const t = line.trim()
      return t.length > 0 && !t.startsWith('#') && new RegExp(rule.pattern).test(t)
    })
    findings.push({
      rule: rule.id,
      severity: covered ? 'info' : rule.severity,
      message: `${rule.reason} —— 命中 ${hits.length} 个文件${covered ? '（.gitignore 已覆盖）' : ''}`,
      file: hits[0],
      detail: `样例：${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` … 共 ${hits.length} 个` : ''}`,
    })
  }

  const stats: Record<string, number> = { scanned: files.length }
  for (const [id, b] of buckets) stats[`junk:${id}`] = b.files.length

  return toResult('repo-hygiene', repoRoot, findings, stats)
}
