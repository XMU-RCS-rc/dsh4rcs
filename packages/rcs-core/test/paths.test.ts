import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  looksLikeRcsRepo,
  repoRootNotFoundMessage,
  resolveRepoRoot,
} from '../src/paths.ts'

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
    const fakeModule = pathToFileURL(
      join('D:/fake-profile', 'node_modules', 'dsh-rcs-kb', 'lib', 'index.js'),
    ).href
    const result = resolveRepoRoot({ env: {}, moduleUrl: fakeModule })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.tried).toContain('模块位置上三级（源码/link 布局）: D:\\fake-profile')
    expect(repoRootNotFoundMessage(result.tried)).toContain('tgz')
    expect(repoRootNotFoundMessage(result.tried)).toContain('teamConfig')
  })

  it('指向非仓库的显式值必须失败，不能假绿', () => {
    const result = resolveRepoRoot({
      explicit: 'D:/not-dsh4rcs',
      env: {},
      moduleUrl: pathToFileURL('D:/x/y/z.js').href,
    })
    expect(result.ok).toBe(false)
  })
})
