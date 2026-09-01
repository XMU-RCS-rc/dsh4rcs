/**
 * 文件系统与 C/C++ 源码的轻量解析工具。
 * 只用 node 内置模块，不引第三方依赖 —— 这个包要保持零依赖。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep, basename, extname } from 'node:path'

/** 遍历时默认跳过的目录。 */
const DEFAULT_SKIP = new Set([
  'node_modules', '.git', '.vscode', '.eide', 'build', 'OBJ', 'Objects',
  'Listings', 'DebugConfig', 'RTE', '__pycache__', '.codex-backup',
])

export interface WalkOptions {
  /** 额外跳过的目录名。 */
  skipDirs?: readonly string[]
  /** 只保留这些扩展名（含点，如 `.c`）。省略则不过滤。 */
  extensions?: readonly string[]
  /**
   * 不套用 DEFAULT_SKIP。
   * 卫生检查必须开这个 —— 它要找的垃圾（OBJ/、Listings/、.codex-backup/）
   * 恰恰就藏在默认跳过的目录里，不关掉就永远扫不到。
   */
  noDefaultSkip?: boolean
}

/** 递归列出目录下的所有文件，返回绝对路径。目录不存在时返回空数组。 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  if (!existsSync(root)) return []
  const skip = new Set([
    ...(options.noDefaultSkip ? [] : DEFAULT_SKIP),
    ...(options.skipDirs ?? []),
  ])
  const exts = options.extensions ? new Set(options.extensions) : undefined
  const out: string[] = []

  const visit = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // 权限或竞态问题，跳过而不是崩掉整次检查
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!skip.has(name)) visit(full)
      } else if (st.isFile()) {
        if (!exts || exts.has(extname(name))) out.push(full)
      }
    }
  }

  visit(root)
  return out.sort()
}

/** 读文本，失败返回空串（检查器不应因单个坏文件而中断）。 */
export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 统一成正斜杠的相对路径，便于跨平台断言。 */
export function relPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

export function fileExists(p: string): boolean {
  return existsSync(p)
}

/** C/C++ 源码里的一条 #include。 */
export interface IncludeRef {
  /** 头文件名，已剥去尖括号或引号，保留可能的相对路径。 */
  header: string
  /** `<...>` 为 system，`"..."` 为 local。 */
  kind: 'system' | 'local'
  /** 1-based 行号。 */
  line: number
}

const INCLUDE_RE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/

/**
 * 解析源码中的 #include。
 * 会跳过 `//` 行注释与 `/* *\/` 块注释中的内容，避免把被注释掉的 include 算进依赖。
 */
export function parseIncludes(source: string): IncludeRef[] {
  const out: IncludeRef[] = []
  const lines = source.split(/\r?\n/)
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? ''

    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      line = line.slice(end + 2)
      inBlockComment = false
    }
    // 去掉本行内的块注释与行注释
    for (;;) {
      const start = line.indexOf('/*')
      if (start === -1) break
      const end = line.indexOf('*/', start + 2)
      if (end === -1) {
        line = line.slice(0, start)
        inBlockComment = true
        break
      }
      line = line.slice(0, start) + ' ' + line.slice(end + 2)
    }
    const lineComment = line.indexOf('//')
    if (lineComment !== -1) line = line.slice(0, lineComment)

    const m = INCLUDE_RE.exec(line)
    if (m) {
      out.push({
        header: (m[2] ?? '').trim(),
        kind: m[1] === '<' ? 'system' : 'local',
        line: i + 1,
      })
    }
  }
  return out
}

/** 判断是否为 C/C++ 源码或头文件。 */
export function isCppFile(file: string): boolean {
  return ['.c', '.cpp', '.cc', '.h', '.hpp'].includes(extname(file))
}

/** 取不含目录的文件名。 */
export function fileName(p: string): string {
  return basename(p)
}
