import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bootedProfile,
  checkPnpm,
  ensureAppendOnlyReporter,
  findCachedDsh,
  parsePnpmVersion,
  patchFiles,
  patchSetsConfig,
  heartbeatLine,
  isInteractive,
  npxCacheRoots,
  normalizeChildExit,
  pluginInstallStage,
  selectHostScope,
  hostScopeNotFoundMessage,
  resolveDshHome,
} from '../src/dsh-runtime.ts'
import { fixturePath } from './fixture-path.ts'

describe('dsh home 定位（与 dsh-home-paths 同一条规则）', () => {
  const HOME = fixturePath('users', 'a')

  it('没设 DSH_HOME 时是主目录下的 .dsh', () => {
    expect(resolveDshHome({ USERPROFILE: HOME })).toBe(resolve(HOME, '.dsh'))
    expect(resolveDshHome({ HOME })).toBe(resolve(HOME, '.dsh'))
  })

  it('设了 DSH_HOME 就用它 —— 早先脚本写死 ~/.dsh，与 dsh 各干各的', () => {
    const custom = fixturePath('dsh-0.1.5-rc.1', 'home')
    expect(resolveDshHome({ USERPROFILE: HOME, DSH_HOME: custom })).toBe(resolve(custom))
  })

  it('全空白的 DSH_HOME 视同未设，不会解析成当前目录', () => {
    expect(resolveDshHome({ USERPROFILE: HOME, DSH_HOME: '   ' })).toBe(resolve(HOME, '.dsh'))
  })

  it('~ 开头按主目录展开', () => {
    expect(resolveDshHome({ USERPROFILE: HOME, DSH_HOME: '~/dsh-home' })).toBe(resolve(HOME, 'dsh-home'))
    expect(resolveDshHome({ USERPROFILE: HOME, DSH_HOME: '~' })).toBe(resolve(HOME))
  })
})

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
    expect(line).toBe('[dsh:install 4/4] 安装 2 个插件到 profile rcs-dev')
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
    ).toBe('[dsh:install 4/4] 安装 2 个插件到 profile add')
  })

  it('Windows shell 的 9009 归一化为命令不存在 127，信号终止归一化为 1', () => {
    expect(normalizeChildExit(9009, null, 'win32')).toEqual({ code: 127, missingCommand: true })
    expect(normalizeChildExit(null, 'SIGTERM', 'linux')).toEqual({ code: 1, missingCommand: false })
    expect(normalizeChildExit(23, null, 'linux')).toEqual({ code: 23, missingCommand: false })
  })
})

describe('启动前检查的触发条件', () => {
  it('直接启动 profile 才检查', () => {
    expect(bootedProfile(['--profile', 'rcs-dev'])).toBe('rcs-dev')
    expect(bootedProfile(['--profile', 'rcs-dev', '--port', '3090', '--no-open'])).toBe('rcs-dev')
    expect(bootedProfile(['--profile=rcs-dev', '--patch', './dsh4rcs-competition.cordis.yml'])).toBe('rcs-dev')
  })

  it('子命令、只打印配置、按模板初始化、帮助与版本号都不检查', () => {
    expect(bootedProfile(['plugin', '--profile', 'rcs-dev', 'add', './packages/dsh-rcs-core'])).toBeUndefined()
    expect(bootedProfile(['web'])).toBeUndefined()
    expect(bootedProfile(['--profile', 'rcs-dev', '--dump-config'])).toBeUndefined()
    // install-plugins 第 2 步正是这么调的：profile 此时还不存在，拦了就永远建不出来。
    expect(bootedProfile(['--profile', 'rcs-dev', '--from-default-profile', 'web', '--dump-config'])).toBeUndefined()
    expect(bootedProfile(['--profile', 'rcs-dev', '--help'])).toBeUndefined()
    expect(bootedProfile(['--version'])).toBeUndefined()
    expect(bootedProfile([])).toBeUndefined()
  })
})

describe('启动 overlay 与 profile 里的 guard 配置', () => {
  const readRepoFile = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8')

  it('取出 --patch 的两种写法，按出现顺序', () => {
    expect(patchFiles(['--profile', 'rcs-dev', '--patch', './a.yml', '--patch=./b.yml', '--port', '3090'])).toEqual([
      './a.yml',
      './b.yml',
    ])
    expect(patchFiles(['--profile', 'rcs-dev'])).toEqual([])
  })

  it('认出带 config 的条目；注释、只 disabled、config 属于下一条的都不算', () => {
    const withConfig = '# - id: rcs-guard（注释不算）\n- id: rcs-guard\n  config:\n    mode: training\n'
    expect(patchSetsConfig(withConfig, 'rcs-guard')).toBe(true)
    const disabledOnly = "- id: rcs-guard\n  disabled: true\n- id: rcs-core\n  config:\n    teamConfig: ''\n"
    expect(patchSetsConfig(disabledOnly, 'rcs-guard')).toBe(false)
    expect(patchSetsConfig("- id: 'rcs-guard'\r\n  config:\r\n    mode: dev\r\n", 'rcs-guard')).toBe(true)
    expect(patchSetsConfig('- id: rcs-guard-extra\n  config: {}\n', 'rcs-guard')).toBe(false)
  })

  it('bundle 层 insert 里的缩进写法也认得', () => {
    const bundle = '- insert:\n    - id: rcs-guard\n      name: dsh-rcs-guard\n      config:\n        mode: dev\n'
    expect(patchSetsConfig(bundle, 'rcs-guard')).toBe(true)
  })

  // 两条启动命令的意义就在于「模式写死、不继承 profile」。overlay 的 config 又是整段替换，
  // 所以两份文件都必须把 guard 的配置写全 —— 少写 extraL2 就等于悄悄清空它。
  it('培训 overlay 写死 training，且 guard 配置写全', () => {
    const text = readRepoFile('dsh4rcs-training.cordis.yml')
    expect(patchSetsConfig(text, 'rcs-guard')).toBe(true)
    expect(text).toMatch(/^\s+mode:\s*training\s*$/m)
    expect(text).toMatch(/^\s+extraL2:/m)
    expect(text).not.toMatch(/^-\s+id:\s*rcs-train\s*$/m)
  })

  it('比赛 overlay 写死 dev、关掉培训工具，且 guard 配置写全', () => {
    const text = readRepoFile('dsh4rcs-competition.cordis.yml')
    expect(patchSetsConfig(text, 'rcs-guard')).toBe(true)
    expect(text).toMatch(/^\s+mode:\s*dev\s*$/m)
    expect(text).toMatch(/^\s+extraL2:/m)
    expect(text).toMatch(/^-\s+id:\s*rcs-train\s*\n\s+disabled:\s*true/m)
  })
})

describe('pnpm 预检', () => {
  it('在本仓库根跑时 pnpm 先打一行 WARN，版本号仍取得出来', () => {
    const output =
      '[WARN] The "workspaces" field in package.json is not supported by pnpm. Create a "pnpm-workspace.yaml" file instead.\n11.23.0\n'
    expect(parsePnpmVersion(output)).toBe('11.23.0')
    expect(parsePnpmVersion('12.4.1\r\n')).toBe('12.4.1')
    expect(parsePnpmVersion('11.0.0-rc.3\n')).toBe('11.0.0-rc.3')
    expect(parsePnpmVersion('ERR_PNPM_BAD_PM_VERSION\n')).toBeUndefined()
  })

  it('没装 pnpm：拦下，并给出带主版本的安装命令', () => {
    const got = checkPnpm({})
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('npm i -g pnpm@11')
  })

  it('11.x 放行，不带警告', () => {
    expect(checkPnpm({ path: 'C:/npm/pnpm.cmd', versionOutput: '11.23.0\n' })).toEqual({ ok: true, version: '11.23.0' })
  })

  it('12 放行但警告 —— 实测能装通当前布局，拦下来只会逼人降级', () => {
    const got = checkPnpm({ path: '/usr/local/bin/pnpm', versionOutput: '12.4.1\n' })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.warning).toContain('npm i -g pnpm@11')
  })

  it('10 及以下拦下', () => {
    expect(checkPnpm({ path: '/usr/local/bin/pnpm', versionOutput: '10.33.0\n' }).ok).toBe(false)
  })

  it('找得到却问不出版本号：拦下，并带上输出末尾', () => {
    const got = checkPnpm({ path: 'C:/npm/pnpm.cmd', versionOutput: "Error: Cannot find module 'pnpm.cjs'\n" })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('Cannot find module')
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
  const scope = join(root, dir, 'node_modules', '@deepseek-ai')
  return {
    [join(scope, 'dsh-tools', 'package.json')]: pkg(tools),
    [join(scope, 'cordis', 'package.json')]: pkg(cordis),
    [join(scope, 'schemastery', 'package.json')]: pkg(schema),
  }
}

describe('宿主作用域选择', () => {
  // 固件路径必须两个平台都绝对。写死 'C:/cache/_npx' 在 POSIX 上是相对路径：
  // selectHostScope 内部用 join 拼，断言里却用 resolve 比，后者会按 cwd 补全，
  // 于是 Windows 全绿、ubuntu 挂在一句路径对不上的断言里。
  const ROOT = fixturePath('cache', '_npx')

  it('缓存里有漂移版本时，仍然选中版本一致的那个目录', () => {
    // aaa 排在前面 —— 老实现"找到第一个就用"会挑中它，联接过去就是双实例。
    const deps = fakeFs({
      ...cacheEntry(ROOT, 'aaa', '0.1.0-rc.8', '4.0.2', '3.18.2'),
      ...cacheEntry(ROOT, 'zzz', '0.1.0-rc.6', '4.0.1', '3.18.1'),
    })
    const got = selectHostScope(WANT, { roots: [ROOT], deps })
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(got.scope).toBe(join(ROOT, 'zzz', 'node_modules', '@deepseek-ai'))
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
    const repo = fixturePath('repo', 'node_modules', '@deepseek-ai')
    const deps = fakeFs({
      [join(repo, 'dsh', 'package.json')]: pkg('0.1.0-rc.6'),
      [join(repo, 'dsh-tools', 'package.json')]: pkg('0.1.0-rc.6'),
      [join(repo, 'cordis', 'package.json')]: pkg('4.0.1'),
      [join(repo, 'schemastery', 'package.json')]: pkg('3.18.1'),
      ...cacheEntry(ROOT, 'aaa', '0.1.0-rc.8', '4.0.2', '3.18.2'),
    })
    const got = selectHostScope(WANT, { repoScope: repo, roots: [ROOT], deps })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.source).toBe('本仓库 node_modules')
  })

  it('仓库没装 dsh 时不把仓库当宿主候选', () => {
    // 仓库里只有 npm 装的三个包，没有 dsh 本体 —— 那不是运行时，
    // 认成宿主会变成"自己联接自己"，什么也没修好却报成功。
    const repo = fixturePath('repo', 'node_modules', '@deepseek-ai')
    const deps = fakeFs({
      [join(repo, 'dsh-tools', 'package.json')]: pkg('0.1.0-rc.6'),
      [join(repo, 'cordis', 'package.json')]: pkg('4.0.1'),
      [join(repo, 'schemastery', 'package.json')]: pkg('3.18.1'),
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
