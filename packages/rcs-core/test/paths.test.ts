import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  looksLikeRcsRepo,
  repoRootNotFoundMessage,
  resolveRepoRoot,
} from '../src/paths.ts'
import { fixturePath } from './fixture-path.ts'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

describe('dsh4rcs 数据根解析', () => {
  it('识别真实仓库，并接受显式路径或 DSH4RCS_HOME', () => {
    expect(looksLikeRcsRepo(REPO)).toBe(true)
    expect(resolveRepoRoot({ explicit: REPO, env: {}, moduleUrl: import.meta.url })).toMatchObject({
      ok: true,
      root: REPO,
      from: '显式配置',
    })
    expect(resolveRepoRoot({ env: { DSH4RCS_HOME: REPO }, moduleUrl: import.meta.url })).toMatchObject({
      ok: true,
      root: REPO,
      from: '环境变量 DSH4RCS_HOME',
    })
  })

  it('tgz/profile 布局不得把 profile 根静默认成仓库', () => {
    // 假路径必须两个平台都绝对：写死 'D:/fake-profile' 在 POSIX 上是相对路径，
    // pathToFileURL 会按 cwd 补全，算出来的是 <仓库>/D:/fake-profile。
    const fakeProfile = fixturePath('fake-profile')
    const fakeModule = pathToFileURL(
      join(fakeProfile, 'node_modules', 'dsh-rcs-kb', 'lib', 'index.js'),
    ).href
    const result = resolveRepoRoot({ env: {}, moduleUrl: fakeModule })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 断言仍比对整条渲染结果，只是期望值由同一个固件推出来，不再写死分隔符。
    expect(result.tried).toContain(`模块位置上三级（源码/link 布局）: ${fakeProfile}`)
    expect(repoRootNotFoundMessage(result.tried)).toContain('tgz')
    expect(repoRootNotFoundMessage(result.tried)).toContain('teamConfig')
  })

  it('指向非仓库的显式值必须失败，不能假绿', () => {
    // 解析链是「显式 → 环境变量 → 模块位置」，显式值校验不过会继续往下走。
    // 所以这条用例要成立，兜底那一级也必须不是仓库。早先写死 'D:/x/y/z.js'，
    // 在 POSIX 上被补全成 <仓库>/D:/x/y/z.js，往上三级正好是真实仓库根，
    // 于是解析成功、用例失败 —— 用例本身没错，是固件选错了。
    const result = resolveRepoRoot({
      explicit: fixturePath('not-dsh4rcs'),
      env: {},
      moduleUrl: pathToFileURL(fixturePath('x', 'y', 'z.js')).href,
    })
    expect(result.ok).toBe(false)
  })
})
