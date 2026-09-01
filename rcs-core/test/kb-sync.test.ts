/**
 * 同步器测试 —— 全部用假 client，不碰网络。
 *
 * 这正是把 `FeishuClient` 定义成接口的理由：遍历、白名单、增量判定这些
 * 最容易出错的地方，不需要飞书权限、不需要联网就能逐条验证。
 *
 * 重点覆盖**白名单越界**：飞书侧对该共享文件夹没有做到目录级隔离
 * （应用能读到根目录下全队资料），本地白名单是唯一屏障，它必须硬。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AllowlistGuard, walkAllowlist, syncKnowledgeBase, loadManifest, docPath,
  DEFAULT_SYNC_POLICY,
} from '../src/kb-sync.ts'
import type { KbSource, SyncPolicy } from '../src/kb-sync.ts'
import {
  FeishuPermissionError, FeishuApiError, extractLegacyText, recommendScope, describeScopes,
} from '../src/feishu.ts'
import type { FeishuClient, FolderPage } from '../src/feishu.ts'

type Node = { token: string; name: string; type: string; modifiedTime?: string; children?: Node[] }

/** 内存树版 client。`bodies` 决定正文，缺省则按 token 造一段。 */
class FakeClient implements FeishuClient {
  calls: string[] = []
  fetched: string[] = []
  bodies = new Map<string, string>()
  failures = new Map<string, Error>()

  readonly roots: Map<string, Node[]>

  constructor(roots: Map<string, Node[]>) {
    this.roots = roots
  }

  async listFolder(token: string): Promise<FolderPage> {
    this.calls.push(token)
    const kids = this.roots.get(token) ?? []
    return {
      files: kids.map((k) => ({
        token: k.token,
        name: k.name,
        type: k.type,
        parentToken: token,
        url: `https://x.feishu.cn/${k.type}/${k.token}`,
        modifiedTime: k.modifiedTime ?? '1000',
      })),
      hasMore: false,
    }
  }

  async docxRawContent(token: string): Promise<string> {
    this.fetched.push(token)
    const f = this.failures.get(token)
    if (f) throw f
    return this.bodies.get(token) ?? `正文-${token}`
  }

  async legacyDocContent(token: string): Promise<string> {
    this.fetched.push(token)
    const f = this.failures.get(token)
    if (f) throw f
    return this.bodies.get(token) ?? `旧文-${token}`
  }
}

/**
 * 固定 fixture：两个授权根，内含目录、docx、旧版 doc、安装包、快捷方式。
 * 目录名故意带斜杠 —— 队内真有个「硬件/软件培训知识体系」，
 * 它会打死任何按路径建目录的落盘方案。
 */
function fixture(): { client: FakeClient; sources: KbSource[] } {
  const roots = new Map<string, Node[]>([
    ['fA', [
      { token: 'fB', name: '模板代码', type: 'folder' },
      { token: 'd2', name: '培训大纲', type: 'docx', modifiedTime: '2000' },
      { token: 's1', name: '外部链接', type: 'shortcut' },
      { token: 'z1', name: 'keil5.zip', type: 'file' },
    ]],
    ['fB', [
      { token: 'fD', name: '硬件/软件培训知识体系', type: 'folder' },
      { token: 'd1', name: 'RCSLIB代码规范', type: 'docx', modifiedTime: '1500' },
    ]],
    ['fD', [{ token: 'd4', name: '深层文档', type: 'docx', modifiedTime: '1200' }]],
    ['fC', [{ token: 'd3', name: '老归档', type: 'doc', modifiedTime: '900' }]],
  ])
  return {
    client: new FakeClient(roots),
    sources: [
      { kind: 'drive-folder', label: '电控组(通用)', token: 'fA' },
      { kind: 'drive-folder', label: '电控组(硬件)', token: 'fC' },
    ],
  }
}

const POLICY: SyncPolicy = { ...DEFAULT_SYNC_POLICY, includeTypes: ['docx', 'doc'] }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rcs-kb-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AllowlistGuard', () => {
  it('根 token 一开始就在白名单里', () => {
    const g = new AllowlistGuard(['fA', 'fC'])
    expect(g.has('fA')).toBe(true)
    expect(g.has('fC')).toBe(true)
  })

  it('未经遍历发现的 token 一律拒绝', () => {
    const g = new AllowlistGuard(['fA'])
    expect(() => g.assert('fX', 'docx 「机械组方案」')).toThrow(/白名单越界/)
  })

  it('拒绝信息里要写清授权根，好让人知道范围是什么', () => {
    const g = new AllowlistGuard(['fA', 'fC'])
    expect(() => g.assert('fX', 'x')).toThrow(/fA, fC/)
  })

  it('admit 之后放行', () => {
    const g = new AllowlistGuard(['fA'])
    g.admit('d1')
    expect(() => g.assert('d1', 'x')).not.toThrow()
  })
})

describe('walkAllowlist', () => {
  it('只收 includeTypes 里的类型', async () => {
    const { client, sources } = fixture()
    const g = new AllowlistGuard(sources.map((s) => s.token))
    const r = await walkAllowlist(client, sources, POLICY, g)
    expect(r.docs.map((d) => d.token).sort()).toEqual(['d1', 'd2', 'd3', 'd4'])
  })

  it('安装包与快捷方式被跳过并计数', async () => {
    const { client, sources } = fixture()
    const g = new AllowlistGuard(sources.map((s) => s.token))
    const r = await walkAllowlist(client, sources, POLICY, g)
    expect(r.skippedByType['file']).toBe(1)
    expect(r.skippedByType['shortcut']).toBe(1)
  })

  it('路径用 label 起头，带斜杠的目录名原样保留在路径里', async () => {
    const { client, sources } = fixture()
    const g = new AllowlistGuard(sources.map((s) => s.token))
    const r = await walkAllowlist(client, sources, POLICY, g)
    const deep = r.docs.find((d) => d.token === 'd4')
    expect(deep?.path).toBe('电控组(通用)/模板代码/硬件/软件培训知识体系/深层文档')
  })

  it('遍历过的节点全部进白名单', async () => {
    const { client, sources } = fixture()
    const g = new AllowlistGuard(sources.map((s) => s.token))
    await walkAllowlist(client, sources, POLICY, g)
    for (const t of ['fB', 'fD', 'd1', 'd2', 'd3', 'd4']) expect(g.has(t)).toBe(true)
    expect(g.has('fX')).toBe(false)
  })

  it('maxDepth 挡住过深的目录', async () => {
    const { client, sources } = fixture()
    const g = new AllowlistGuard(sources.map((s) => s.token))
    const r = await walkAllowlist(client, sources, { ...POLICY, maxDepth: 1 }, g)
    // 深度 2 的 fD 展不开，d4 收不到
    expect(r.docs.map((d) => d.token)).not.toContain('d4')
    expect(r.depthCapped).toBeGreaterThan(0)
  })

  it('目录成环也不会死循环', async () => {
    const roots = new Map<string, Node[]>([
      ['fA', [{ token: 'fB', name: 'B', type: 'folder' }]],
      ['fB', [{ token: 'fA', name: 'A(环)', type: 'folder' }]],
    ])
    const client = new FakeClient(roots)
    const sources: KbSource[] = [{ kind: 'drive-folder', label: 'A', token: 'fA' }]
    const g = new AllowlistGuard(['fA'])
    const r = await walkAllowlist(client, sources, POLICY, g)
    expect(r.folders).toBeLessThan(5)
  })

  it('即使 shortcut 被放进 includeTypes 也绝不跟随 —— 它指向白名单之外', async () => {
    const { client, sources } = fixture()
    const g = new AllowlistGuard(sources.map((s) => s.token))
    const loose: SyncPolicy = { ...POLICY, includeTypes: ['docx', 'doc', 'shortcut'], excludeTypes: [] }
    const r = await walkAllowlist(client, sources, loose, g)
    expect(r.docs.map((d) => d.token)).not.toContain('s1')
    expect(r.skippedByType['shortcut']).toBe(1)
  })
})

describe('syncKnowledgeBase', () => {
  it('落盘正文与清单', async () => {
    const { client, sources } = fixture()
    const r = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(r.stats.added).toBe(4)
    expect(existsSync(docPath(dir, 'd1'))).toBe(true)
    expect(readFileSync(docPath(dir, 'd1'), 'utf8')).toBe('正文-d1')
    const m = loadManifest(dir)
    expect(Object.keys(m?.docs ?? {}).sort()).toEqual(['d1', 'd2', 'd3', 'd4'])
  })

  it('正文按 token 扁平落盘，不镜像目录树', () => {
    // 「硬件/软件培训知识体系」这种名字会让路径镜像方案当场炸掉
    expect(docPath(dir, 'd4')).toBe(join(dir, 'docs', 'd4.txt'))
  })

  it('清单里存人类可读路径，供展示用', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(loadManifest(dir)?.docs['d4']?.path).toContain('硬件/软件培训知识体系')
  })

  it('增量：modifiedTime 没变就不重抓', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    client.fetched = []
    const r2 = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(client.fetched).toEqual([])
    expect(r2.stats.unchanged).toBe(4)
    expect(r2.stats.added).toBe(0)
  })

  it('增量：modifiedTime 变了就重抓', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    const kids = await client.listFolder('fA')
    void kids
    // 改掉 d2 的 modifiedTime
    const fa = client.roots.get('fA')
    const d2 = fa?.find((n) => n.token === 'd2')
    if (d2) d2.modifiedTime = '9999'
    client.fetched = []
    const r2 = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(client.fetched).toEqual(['d2'])
    expect(r2.stats.updated).toBe(1)
  })

  it('force 忽略增量，全量重抓', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    client.fetched = []
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir, force: true })
    expect(client.fetched.length).toBe(4)
  })

  it('正文文件被删掉时，即使 modifiedTime 没变也要重抓', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    rmSync(docPath(dir, 'd1'))
    client.fetched = []
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(client.fetched).toEqual(['d1'])
  })

  it('线上删掉的文档，本地镜像也删 —— 否则检索会返回不存在的内容', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    client.roots.set('fC', [])
    const r2 = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(r2.stats.removed).toBe(1)
    expect(existsSync(docPath(dir, 'd3'))).toBe(false)
    expect(loadManifest(dir)?.docs['d3']).toBeUndefined()
  })

  it('抓取失败的条目留在清单里并记原因 —— 静默消失比报错危险', async () => {
    const { client, sources } = fixture()
    client.failures.set('d1', new FeishuApiError('接口炸了', 1254004))
    const r = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(r.stats.failed).toBe(1)
    expect(r.failures[0]?.name).toBe('RCSLIB代码规范')
    expect(loadManifest(dir)?.docs['d1']?.error).toContain('接口炸了')
  })

  it('失败条目下次会重试，不会被当成「未变」跳过', async () => {
    const { client, sources } = fixture()
    client.failures.set('d1', new FeishuApiError('临时故障', 1254004))
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    client.failures.clear()
    client.fetched = []
    const r2 = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(client.fetched).toContain('d1')
    expect(loadManifest(dir)?.docs['d1']?.error).toBeUndefined()
    expect(r2.stats.failed).toBe(0)
  })

  it('权限错误单独给出提示与申请链接 —— 它要去开权限，不是重试', async () => {
    const { client, sources } = fixture()
    client.failures.set('d1', new FeishuPermissionError('denied', ['docx:document', 'docx:document:readonly'], 'cli_x'))
    const r = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(r.permissionHint?.scopes).toContain('docx:document:readonly')
    expect(r.permissionHint?.authLink).toContain('docx:document:readonly')
  })

  it('sources 为空直接拒绝 —— 空清单意味着什么都不该同步', async () => {
    const { client } = fixture()
    await expect(
      syncKnowledgeBase({ client, sources: [], policy: POLICY, cacheDir: dir }),
    ).rejects.toThrow(/没有配置任何同步来源/)
  })

  it('allowlistOnly 关掉直接拒绝 —— 它是唯一的范围屏障', async () => {
    const { client, sources } = fixture()
    await expect(
      syncKnowledgeBase({
        client, sources, policy: { ...POLICY, allowlistOnly: false }, cacheDir: dir,
      }),
    ).rejects.toThrow(/allowlistOnly 必须为 true/)
  })

  it('清单损坏时当作没有，下次同步重建而不是卡死检索', async () => {
    const { client, sources } = fixture()
    await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    writeFileSync(join(dir, 'manifest.json'), '{ 坏掉的 json', 'utf8')
    expect(loadManifest(dir)).toBeUndefined()
    const r = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(r.stats.added).toBe(4)
  })

  it('清单记录授权范围与按类型跳过的统计', async () => {
    const { client, sources } = fixture()
    const r = await syncKnowledgeBase({ client, sources, policy: POLICY, cacheDir: dir })
    expect(r.manifest.sources.map((s) => s.label)).toEqual(['电控组(通用)', '电控组(硬件)'])
    expect(r.manifest.skippedByType['file']).toBe(1)
  })
})

describe('recommendScope / describeScopes', () => {
  // 飞书返回的是「任选其一即可」的候选集，同时含读写版与只读版。
  // 原样列出会让人以为两个都要开 —— 而读写版是本工具不需要的写权限。
  const DOCX = ['docx:document', 'docx:document:readonly']
  const DRIVE = ['drive:drive', 'drive:drive:readonly', 'space:document:retrieve']

  it('永远挑只读那一个，哪怕它不在列表首位', () => {
    expect(recommendScope(DOCX).scope).toBe('docx:document:readonly')
    expect(recommendScope(DRIVE).scope).toBe('drive:drive:readonly')
  })

  it('说明里只出现只读 scope，读写版只被计数不被点名推荐', () => {
    const s = describeScopes(DOCX)
    expect(s).toContain('docx:document:readonly')
    expect(s).toContain('只开这个只读的')
    // 「docx:document」不得作为独立的推荐项出现
    expect(s.replace(/docx:document:readonly/g, '')).not.toContain('docx:document')
  })

  it('只有一个候选时不啰嗦', () => {
    expect(describeScopes(['docx:document:readonly'])).toBe('docx:document:readonly')
  })

  it('候选里没有只读版时如实警告，不静默推荐写权限', () => {
    const s = describeScopes(['im:message:send_as_bot'])
    expect(s).toContain('没有只读版本')
    expect(recommendScope(['im:message:send_as_bot']).readonly).toBe(false)
  })

  it('空候选集不崩', () => {
    expect(recommendScope([]).scope).toBe('')
    expect(describeScopes([])).toContain('没有返回')
  })

  it('FeishuPermissionError 的建议与链接都指向只读版', () => {
    const e = new FeishuPermissionError('denied', DOCX, 'cli_x')
    expect(e.suggestedScope).toBe('docx:document:readonly')
    expect(e.authLink).toContain('q=docx:document:readonly&')
    expect(e.scopeAdvice).toContain('只开这个只读的')
  })
})

describe('extractLegacyText', () => {
  it('递归抽出所有 text 字段', () => {
    const json = JSON.stringify({ body: { blocks: [{ paragraph: { text: '气动上限' } }, { text: '600kPa' }] } })
    expect(extractLegacyText(json)).toBe('气动上限600kPa')
  })

  it('解析失败返回空串而不是抛 —— 一篇老文档不该让整次同步失败', () => {
    expect(extractLegacyText('不是 json')).toBe('')
  })
})
