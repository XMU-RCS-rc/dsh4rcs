/**
 * 版本新鲜度检查的测试。
 *
 * 全部用注入的假执行器与假 fetch —— **一次网络都不打**。测试要能在没网的
 * 机器上、在 CI 上、在飞机上跑出同样的结果；一个「检查更新」的功能如果它自己
 * 的测试依赖更新源，那就没法作为回归基准用了。
 *
 * 重点覆盖三类容易写错的地方：
 *   1. 预发布版本的语义化比较（我们真正要比的就是 rc.6 与 rc.8）；
 *   2. 「落后」与「领先」的区分（分不清会把每次本地未推送提交都误报成过时）；
 *   3. 失败路径 —— 离线、非 git 目录、缓存损坏，全都必须降级成「查不到」而不是抛。
 */
import { describe, it, expect } from 'vitest'

import {
  compareSemver,
  checkRulesFreshness,
  checkPluginFreshness,
  checkHostFreshness,
  checkFreshness,
  summarizeFreshness,
} from '../src/freshness.ts'
import type { FreshnessStore, JsonFetcher } from '../src/freshness.ts'
import type { CommandResult, CommandRunner } from '../src/toolchain.ts'

const okResult = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' })
const failResult = (stderr = 'boom'): CommandResult => ({ code: 1, stdout: '', stderr })

/** 造一个假的 git：按子命令返回预设结果。 */
function fakeGit(map: Partial<Record<string, CommandResult>>): CommandRunner {
  return async (command, args) => {
    expect(command).toBe('git')
    return map[args[0] as string] ?? failResult(`未预设的子命令：${args[0]}`)
  }
}

const NOW = new Date('2026-09-02T12:00:00Z')

// ---------------------------------------------------------------- semver

describe('compareSemver', () => {
  it('主次修订号按数值比较', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0)
  })

  it('数值比较不退化成字典序', () => {
    // 字典序会说 '10' < '9'，这是最经典的版本比较 bug
    expect(compareSemver('0.1.10', '0.1.9')).toBe(1)
  })

  /** 这是本模块存在的直接理由：判断锁定的 rc.6 与上游 rc.8 谁新。 */
  it('预发布标识按段比较 —— rc.6 < rc.8', () => {
    expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.8')).toBe(-1)
    expect(compareSemver('0.1.0-rc.8', '0.1.0-rc.6')).toBe(1)
    expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.6')).toBe(0)
  })

  it('rc 段也不退化成字典序', () => {
    expect(compareSemver('0.1.0-rc.2', '0.1.0-rc.10')).toBe(-1)
  })

  it('预发布小于同号正式版', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
  })

  it('跨版本号时预发布不影响大小关系', () => {
    expect(compareSemver('0.1.0-rc.9', '0.2.0-rc.1')).toBe(-1)
  })

  it('纯数字标识符低于含字母的标识符', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
  })

  it('前缀相同时段数少的更小', () => {
    expect(compareSemver('1.0.0-rc', '1.0.0-rc.1')).toBe(-1)
  })

  it('构建元数据不参与比较', () => {
    expect(compareSemver('1.0.0+build1', '1.0.0+build2')).toBe(0)
  })

  /**
   * 解析不了要返回 undefined，而不是猜。
   * 上游哪天发个 `next` 这样的 dist-tag，我们不该因此报出「过时」。
   */
  it('解析不了返回 undefined，而不是猜一个结果', () => {
    expect(compareSemver('1.0', '1.0.0')).toBeUndefined()
    expect(compareSemver('latest', '1.0.0')).toBeUndefined()
    expect(compareSemver('', '1.0.0')).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 规则书

describe('规则书过期提醒', () => {
  it('阈值内算新鲜', () => {
    const r = checkRulesFreshness({ currentVersion: 'V0', lastCheckedAt: '2026-08-25' }, NOW)
    expect(r.status).toBe('ok')
    expect(r.current).toBe('V0')
    expect(r.action).toBeUndefined() // 没事可做就不要凑一条「无需操作」
  })

  it('超过阈值提醒，并说清过了多少天', () => {
    const r = checkRulesFreshness({ currentVersion: 'V0', lastCheckedAt: '2026-07-01' }, NOW)
    expect(r.status).toBe('stale')
    expect(r.detail).toContain('63 天')
    expect(r.action).toContain('robocon.org.cn')
  })

  it('阈值可配', () => {
    const input = { currentVersion: 'V0', lastCheckedAt: '2026-08-25', checkIntervalDays: 3 }
    expect(checkRulesFreshness(input, NOW).status).toBe('stale')
  })

  it('恰好等于阈值当天就提醒（边界含端点）', () => {
    const input = { currentVersion: 'V0', lastCheckedAt: '2026-08-03', checkIntervalDays: 30 }
    expect(checkRulesFreshness(input, NOW).status).toBe('stale')
  })

  it('从没确认过 → 查不到，而不是假装没事', () => {
    const r = checkRulesFreshness({ currentVersion: 'V0' }, NOW)
    expect(r.status).toBe('unknown')
    expect(r.action).toBeDefined()
  })

  it('日期填错 → 查不到，并把填错的值回显出来', () => {
    const r = checkRulesFreshness({ currentVersion: 'V0', lastCheckedAt: '2026/07/01' }, NOW)
    expect(r.status).toBe('unknown')
    expect(r.detail).toContain('2026/07/01')
  })

  it('日期在未来 → 查不到（多半是填错了，不该因此判成新鲜）', () => {
    const r = checkRulesFreshness({ currentVersion: 'V0', lastCheckedAt: '2027-01-01' }, NOW)
    expect(r.status).toBe('unknown')
  })

  it('自定义官网地址会出现在建议里', () => {
    const r = checkRulesFreshness(
      { currentVersion: 'V0', lastCheckedAt: '2026-01-01', officialSite: 'https://example.org' },
      NOW,
    )
    expect(r.action).toContain('https://example.org')
  })
})

// ---------------------------------------------------------------- 插件自身

describe('插件代码新鲜度', () => {
  const LOCAL = 'a'.repeat(40)
  const REMOTE = 'b'.repeat(40)

  it('本地与远端一致 → ok', async () => {
    const run = fakeGit({
      'rev-parse': okResult(`${LOCAL}\n`),
      'ls-remote': okResult(`${LOCAL}\trefs/heads/main\n`),
    })
    const r = await checkPluginFreshness(run, '/repo')
    expect(r.status).toBe('ok')
    expect(r.current).toBe(LOCAL.slice(0, 7))
  })

  /** 远端提交本地没有 → 确实落后了。 */
  it('远端有本地没有的提交 → stale，并给出拉取步骤', async () => {
    const run = fakeGit({
      'rev-parse': okResult(`${LOCAL}\n`),
      'ls-remote': okResult(`${REMOTE}\trefs/heads/main\n`),
      'cat-file': failResult(), // 本地不认识这个提交
    })
    const r = await checkPluginFreshness(run, '/repo')
    expect(r.status).toBe('stale')
    expect(r.latest).toBe(REMOTE.slice(0, 7))
    expect(r.action).toContain('git pull')
    // 依赖可能一起变了，光 pull 不够
    expect(r.action).toContain('npm install')
  })

  /**
   * 这条是本模块最容易写错的地方：SHA 不同**不等于**落后。
   * 少了 cat-file 这一步，任何本地未推送的提交都会被误报成「过时」，
   * 提示喊狼来了几次之后就没人信了。
   */
  it('本地领先或分叉 → ok，不误报成过时', async () => {
    const run = fakeGit({
      'rev-parse': okResult(`${LOCAL}\n`),
      'ls-remote': okResult(`${REMOTE}\trefs/heads/main\n`),
      'cat-file': okResult(''), // 远端那个提交本地已经有了
    })
    const r = await checkPluginFreshness(run, '/repo')
    expect(r.status).toBe('ok')
    expect(r.detail).toContain('领先')
  })

  it('不是 git 工作区 → 查不到，并指出多半是下载了 zip', async () => {
    const run = fakeGit({ 'rev-parse': failResult('not a git repository') })
    const r = await checkPluginFreshness(run, '/repo')
    expect(r.status).toBe('unknown')
    expect(r.action).toContain('git clone')
  })

  it('连不上远端 → 查不到，且明说不影响本地功能', async () => {
    const run = fakeGit({
      'rev-parse': okResult(`${LOCAL}\n`),
      'ls-remote': failResult('could not resolve host'),
    })
    const r = await checkPluginFreshness(run, '/repo')
    expect(r.status).toBe('unknown')
    expect(r.detail).toContain('不影响')
  })

  it('远端返回空输出（分支不存在）→ 查不到', async () => {
    const run = fakeGit({
      'rev-parse': okResult(`${LOCAL}\n`),
      'ls-remote': okResult('\n'),
    })
    expect((await checkPluginFreshness(run, '/repo')).status).toBe('unknown')
  })

  it('分支名可指定', async () => {
    let asked = ''
    const run: CommandRunner = async (_c, args) => {
      if (args[0] === 'rev-parse') return okResult(`${LOCAL}\n`)
      asked = args[2] ?? ''
      return okResult(`${LOCAL}\trefs/heads/dev\n`)
    }
    await checkPluginFreshness(run, '/repo', 'dev')
    expect(asked).toBe('refs/heads/dev')
  })
})

// ---------------------------------------------------------------- 宿主

describe('dsh 宿主新鲜度', () => {
  const fetcherOf = (version: unknown): JsonFetcher => async () => ({ version })

  it('上游更新 → stale，且措辞是「先改再验证」而不是「建议升级」', async () => {
    const r = await checkHostFreshness(fetcherOf('0.1.0-rc.8'), '0.1.0-rc.6')
    expect(r.status).toBe('stale')
    expect(r.latest).toBe('0.1.0-rc.8')
    expect(r.action).toContain('不要直接升')
    expect(r.action).toContain('npm run verify')
  })

  it('一致 → ok', async () => {
    expect((await checkHostFreshness(fetcherOf('0.1.0-rc.6'), '0.1.0-rc.6')).status).toBe('ok')
  })

  it('本地比上游还新 → ok，不报过时', async () => {
    const r = await checkHostFreshness(fetcherOf('0.1.0-rc.2'), '0.1.0-rc.6')
    expect(r.status).toBe('ok')
  })

  it('版本号解析不了 → 查不到，不猜新旧', async () => {
    const r = await checkHostFreshness(fetcherOf('nightly'), '0.1.0-rc.6')
    expect(r.status).toBe('unknown')
    expect(r.latest).toBe('nightly')
  })

  it('registry 返回里没有 version → 查不到', async () => {
    expect((await checkHostFreshness(fetcherOf(undefined))).status).toBe('unknown')
  })

  it('网络失败 → 查不到，且不抛', async () => {
    const boom: JsonFetcher = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const r = await checkHostFreshness(boom)
    expect(r.status).toBe('unknown')
    expect(r.detail).toContain('ENOTFOUND')
  })

  it('查的是 npm registry 上转义过的作用域包名', async () => {
    let seen = ''
    const spy: JsonFetcher = async (url) => {
      seen = url
      return { version: '0.1.0-rc.6' }
    }
    await checkHostFreshness(spy)
    expect(seen).toBe('https://registry.npmjs.org/@deepseek-ai%2fdsh/latest')
  })
})

// ---------------------------------------------------------------- 编排

describe('三项合一与缓存', () => {
  const LOCAL = 'c'.repeat(40)
  const deps = {
    run: fakeGit({
      'rev-parse': okResult(`${LOCAL}\n`),
      'ls-remote': okResult(`${LOCAL}\trefs/heads/main\n`),
    }),
    fetchJson: (async () => ({ version: '0.1.0-rc.6' })) as JsonFetcher,
  }
  const rules = { currentVersion: 'V0', lastCheckedAt: '2026-08-30' }

  function memStore(initial?: string): FreshnessStore & { value?: string } {
    const s = {
      value: initial,
      read: () => s.value,
      write: (t: string) => {
        s.value = t
      },
    }
    return s
  }

  it('三项都返回，顺序固定为 规则 / 插件 / 宿主', async () => {
    const r = await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW })
    expect(r.items.map((i) => i.id)).toEqual(['rules', 'plugin', 'host'])
    expect(r.fromCache).toBe(false)
  })

  it('没有 store 时既不读也不写 —— setup 靠这个守住「只读不写」的承诺', async () => {
    const store = memStore()
    await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW })
    expect(store.value).toBeUndefined()
  })

  it('有 store 时写入缓存，只存联网那两项', async () => {
    const store = memStore()
    await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    const cached = JSON.parse(store.value as string)
    expect(cached.items.map((i: { id: string }) => i.id)).toEqual(['plugin', 'host'])
  })

  it('缓存未过期时不再打网', async () => {
    const store = memStore()
    await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })

    let called = false
    const spyDeps = {
      run: (async () => {
        called = true
        return okResult('')
      }) as CommandRunner,
      fetchJson: (async () => {
        called = true
        return { version: 'x' }
      }) as JsonFetcher,
    }
    const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000)
    const r = await checkFreshness({ deps: spyDeps, repoRoot: '/repo', rules, now: later, store })
    expect(called).toBe(false)
    expect(r.fromCache).toBe(true)
  })

  /** 规则那项是纯函数、零成本，所以**永远现算** —— 它是三项里后果最重的。 */
  it('走缓存时规则那项仍然是现算的', async () => {
    const store = memStore()
    await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    const muchLater = new Date('2026-09-02T15:00:00Z')
    const r = await checkFreshness({
      deps,
      repoRoot: '/repo',
      rules: { currentVersion: 'V0', lastCheckedAt: '2026-01-01' },
      now: muchLater,
      store,
    })
    expect(r.fromCache).toBe(true)
    expect(r.items[0]?.status).toBe('stale') // 用的是新传入的日期，不是缓存里的
  })

  it('缓存过期后重查', async () => {
    const store = memStore()
    await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    const later = new Date(NOW.getTime() + 30 * 60 * 60 * 1000)
    const r = await checkFreshness({ deps, repoRoot: '/repo', rules, now: later, store })
    expect(r.fromCache).toBe(false)
  })

  it('refresh 强制忽略缓存', async () => {
    const store = memStore()
    await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    const r = await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store, refresh: true })
    expect(r.fromCache).toBe(false)
  })

  it('缓存内容损坏就当没有 —— 缓存永远不该是失败的理由', async () => {
    const store = memStore('{ 这不是 JSON')
    const r = await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    expect(r.fromCache).toBe(false)
    expect(r.items).toHaveLength(3)
  })

  it('缓存时间在未来（系统时钟被改过）也当作失效', async () => {
    const store = memStore(JSON.stringify({ checkedAt: '2030-01-01T00:00:00Z', items: [] }))
    const r = await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    expect(r.fromCache).toBe(false)
  })

  it('store.read 抛异常也不影响主流程', async () => {
    const store: FreshnessStore = {
      read: () => {
        throw new Error('EACCES')
      },
      write: () => {},
    }
    const r = await checkFreshness({ deps, repoRoot: '/repo', rules, now: NOW, store })
    expect(r.items).toHaveLength(3)
  })

  it('检查函数自己抛异常也降级成「查不到」，不冒泡', async () => {
    const bad = {
      run: (async () => {
        throw new Error('spawn 炸了')
      }) as CommandRunner,
      fetchJson: (async () => {
        throw new Error('fetch 炸了')
      }) as JsonFetcher,
    }
    const r = await checkFreshness({ deps: bad, repoRoot: '/repo', rules, now: NOW })
    expect(r.items.every((i) => i.status !== 'stale')).toBe(true)
    expect(r.items.filter((i) => i.status === 'unknown').length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------- 渲染

describe('摘要渲染', () => {
  const base = { deps: { run: fakeGit({}), fetchJson: (async () => ({})) as JsonFetcher }, repoRoot: '/r' }

  it('全部正常时明确说没有过时项', async () => {
    const report = await checkFreshness({
      ...base,
      deps: {
        run: fakeGit({
          'rev-parse': okResult(`${'d'.repeat(40)}\n`),
          'ls-remote': okResult(`${'d'.repeat(40)}\trefs/heads/main\n`),
        }),
        fetchJson: (async () => ({ version: '0.1.0-rc.6' })) as JsonFetcher,
      },
      rules: { currentVersion: 'V0', lastCheckedAt: '2026-08-30' },
      now: NOW,
    })
    expect(summarizeFreshness(report)).toContain('没有发现过时项')
  })

  it('有过时项时给出数量，并强调不会自动做任何事', async () => {
    const report = await checkFreshness({
      ...base,
      rules: { currentVersion: 'V0', lastCheckedAt: '2026-01-01' },
      now: NOW,
    })
    const text = summarizeFreshness(report)
    expect(text).toContain('1 项需要处理')
    expect(text).toContain('不会自动升级或拉取')
  })
})
