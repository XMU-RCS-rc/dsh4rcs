import { describe, expect, it } from 'vitest'
import { dirname, join, resolve, sep } from 'node:path'

import {
  ensureAppendOnlyReporter,
  findCachedDsh,
  heartbeatLine,
  isInteractive,
  npxCacheRoots,
  normalizeChildExit,
  pluginInstallStage,
  selectHostScope,
  hostScopeNotFoundMessage,
} from '../src/dsh-runtime.ts'

describe('npx 缓存定位', () => {
  it('Windows 同时检查 LOCALAPPDATA 与用户目录', () => {
    expect(npxCacheRoots({ LOCALAPPDATA: 'C:/Local', USERPROFILE: 'C:/Users/a' })).toEqual([
      resolve('C:/Local/npm-cache/_npx'),
      resolve('C:/Users/a/.npm/_npx'),
    ])
  })

  it('用户配置的 npm cache 优先，并兼容大写环境变量', () => {
    expect(npxCacheRoots({ NPM_CONFIG_CACHE: 'D:/ci-cache', HOME: '/home/a' })[0]).toBe(
      resolve('D:/ci-cache/_npx'),
    )
  })

  it('POSIX 使用 ~/.npm/_npx，而不是伪造 AppData 路径', () => {
    expect(npxCacheRoots({ HOME: '/home/a' })).toEqual([resolve('/home/a/.npm/_npx')])
  })

  it('坏缓存项被跳过，继续命中精确版本', () => {
    const root = resolve('D:/fake-npx')
    const good = join(root, 'good', 'node_modules', '@deepseek-ai', 'dsh')
    const bad = join(root, 'bad', 'node_modules', '@deepseek-ai', 'dsh')
    const files = new Map<string, string>([
      [join(bad, 'package.json'), '{bad json'],
      [join(good, 'package.json'), '{"version":"0.1.0-rc.6"}'],
    ])
    const result = findCachedDsh('0.1.0-rc.6', {
      roots: [root],
      deps: {
        exists: (path) => path === root || path.endsWith(join('lib', 'bin.js')),
        readDir: () => ['bad', 'good'],
        readFile: (path) => files.get(path) ?? '',
      },
    })
    expect(result?.bin).toBe(join(good, 'lib', 'bin.js'))
  })
})

describe('安装日志策略', () => {
  it('TTY 且非 CI 才使用交互输出', () => {
    expect(isInteractive(true, {})).toBe(true)
    expect(isInteractive(false, {})).toBe(false)
    expect(isInteractive(true, { CI: '1' })).toBe(false)
  })

  it('非交互环境固定 append-only，但不覆盖用户设置', () => {
    const automatic: Record<string, string | undefined> = {}
    ensureAppendOnlyReporter(automatic, false)
    expect(automatic['npm_config_reporter']).toBe('append-only')

    const explicit = { npm_config_reporter: 'default' }
    ensureAppendOnlyReporter(explicit, false)
    expect(explicit.npm_config_reporter).toBe('default')
  })

  it('心跳是可重定向的纯文本，不伪造百分比', () => {
    const line = heartbeatLine('拉取 dsh 运行时', 31_900)
    expect(line).toContain('已用 31s')
    expect(line).not.toMatch(/%|\x1b|\r/)
  })

  it('安装阶段只报告 profile 与插件数，不回显可能含凭据的参数', () => {
    const line = pluginInstallStage([
      'plugin',
      '--profile',
      'rcs-dev',
      'add',
      './packages/a',
      './packages/b',
      '--registry=https://user:secret@example.invalid',
    ])
    expect(line).toBe('[dsh:install 2/2] 安装 2 个插件到 profile rcs-dev')
    expect(line).not.toContain('secret')
  })

  it('分离式 reporter 参数和值不计入插件数，profile 名为 add 也不混淆命令', () => {
    expect(
      pluginInstallStage([
        'plugin',
        '--profile',
        'add',
        'add',
        '--reporter',
        'append-only',
        './packages/a',
        './packages/b',
      ]),
    ).toBe('[dsh:install 2/2] 安装 2 个插件到 profile add')
  })

  it('Windows shell 的 9009 归一化为命令不存在 127，信号终止归一化为 1', () => {
    expect(normalizeChildExit(9009, null, 'win32')).toEqual({ code: 127, missingCommand: true })
    expect(normalizeChildExit(null, 'SIGTERM', 'linux')).toEqual({ code: 1, missingCommand: false })
    expect(normalizeChildExit(23, null, 'linux')).toEqual({ code: 23, missingCommand: false })
  })
})

/* ---------------------------------------------------------------- 宿主作用域选择 */

const pkg = (version: string) => JSON.stringify({ version })

/** 极简内存文件系统：只需要 exists / readFile / readDir 三件事。 */
function fakeFs(tree: Record<string, string>) {
  const files = new Map(Object.entries(tree).map(([k, v]) => [resolve(k), v]))
  const dirs = new Set<string>()
  for (const file of files.keys()) {
    let dir = dirname(file)
    for (;;) {
      if (dirs.has(dir)) break
      dirs.add(dir)
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return {
    exists: (p: string) => files.has(resolve(p)) || dirs.has(resolve(p)),
    readFile: (p: string) => {
      const v = files.get(resolve(p))
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    readDir: (p: string) => {
      const base = resolve(p) + sep
      const out = new Set<string>()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(base)) continue
        const head = key.slice(base.length).split(sep)[0]
        if (head) out.add(head)
      }
      return [...out].sort()
    },
  }
}

const WANT = { 'dsh-tools': '0.1.0-rc.6', cordis: '4.0.1', schemastery: '3.18.1' }

/** 一个缓存目录里的一整套宿主包。 */
function cacheEntry(root: string, dir: string, tools: string, cordis: string, schema: string) {
  const scope = `${root}/${dir}/node_modules/@deepseek-ai`
  return {
    [`${scope}/dsh-tools/package.json`]: pkg(tools),
    [`${scope}/cordis/package.json`]: pkg(cordis),
    [`${scope}/schemastery/package.json`]: pkg(schema),
  }
}

describe('宿主作用域选择', () => {
  const ROOT = 'C:/cache/_npx'

  it('缓存里有漂移版本时，仍然选中版本一致的那个目录', () => {
    // aaa 排在前面 —— 老实现"找到第一个就用"会挑中它，联接过去就是双实例。
    const deps = fakeFs({
      ...cacheEntry(ROOT, 'aaa', '0.1.0-rc.8', '4.0.2', '3.18.2'),
      ...cacheEntry(ROOT, 'zzz', '0.1.0-rc.6', '4.0.1', '3.18.1'),
    })
    const got = selectHostScope(WANT, { roots: [ROOT], deps })
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(got.scope).toBe(resolve(`${ROOT}/zzz/node_modules/@deepseek-ai`))
      expect(got.source).toBe('npx 缓存')
    }
  })

  it('只有 dsh-tools 对上、cordis 漂了也不算数', () => {
    const deps = fakeFs(cacheEntry(ROOT, 'aaa', '0.1.0-rc.6', '4.0.2', '3.18.1'))
    const got = selectHostScope(WANT, { roots: [ROOT], deps })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.candidates[0]?.versions['cordis']).toBe('4.0.2')
  })

  it('仓库自己装了锁定版时优先用仓库，npx 缓存不参与', () => {
    const repo = 'D:/repo/node_modules/@deepseek-ai'
    const deps = fakeFs({
      [`${repo}/dsh/package.json`]: pkg('0.1.0-rc.6'),
      [`${repo}/dsh-tools/package.json`]: pkg('0.1.0-rc.6'),
      [`${repo}/cordis/package.json`]: pkg('4.0.1'),
      [`${repo}/schemastery/package.json`]: pkg('3.18.1'),
      ...cacheEntry(ROOT, 'aaa', '0.1.0-rc.8', '4.0.2', '3.18.2'),
    })
    const got = selectHostScope(WANT, { repoScope: repo, roots: [ROOT], deps })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.source).toBe('本仓库 node_modules')
  })

  it('仓库没装 dsh 时不把仓库当宿主候选', () => {
    // 仓库里只有 npm 装的三个包，没有 dsh 本体 —— 那不是运行时，
    // 认成宿主会变成"自己联接自己"，什么也没修好却报成功。
    const repo = 'D:/repo/node_modules/@deepseek-ai'
    const deps = fakeFs({
      [`${repo}/dsh-tools/package.json`]: pkg('0.1.0-rc.6'),
      [`${repo}/cordis/package.json`]: pkg('4.0.1'),
      [`${repo}/schemastery/package.json`]: pkg('3.18.1'),
      ...cacheEntry(ROOT, 'aaa', '0.1.0-rc.6', '4.0.1', '3.18.1'),
    })
    const got = selectHostScope(WANT, { repoScope: repo, roots: [ROOT], deps })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.source).toBe('npx 缓存')
  })

  it('一个候选都没有时返回空清单，而不是报错', () => {
    const got = selectHostScope(WANT, { roots: [ROOT], deps: fakeFs({}) })
    expect(got).toEqual({ ok: false, candidates: [] })
  })

  it('提示不再建议改 package.json，并列出实际发现的版本', () => {
    const deps = fakeFs(cacheEntry(ROOT, 'aaa', '0.1.0-rc.8', '4.0.2', '3.18.2'))
    const got = selectHostScope(WANT, { roots: [ROOT], deps })
    expect(got.ok).toBe(false)
    if (got.ok) return
    const msg = hostScopeNotFoundMessage(WANT, got.candidates)
    // 旧提示是「先把 package.json 里的版本对齐再跑本脚本」—— 方向是反的。
    expect(msg).not.toContain('对齐')
    expect(msg).toContain('不要改 package.json')
    expect(msg).toContain('0.1.0-rc.8')
    expect(msg).toContain('npm install')
  })
})
