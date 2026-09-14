import { describe, expect, it } from 'vitest'

import {
  LEGACY_HOST_DEPENDENCIES,
  WEB_APP_BUNDLE,
  migrateProfileManifest,
  profileBootProblem,
} from '../src/profile-manifest.ts'
import type { ProfileManifest } from '../src/profile-manifest.ts'

// 维护者机器上那份 rc.6 时代的 rcs-dev 清单（删掉了几个插件，其余照抄）。
const RC6_PROFILE: ProfileManifest = {
  name: 'dsh-profile-rcs-dev',
  private: true,
  dependencies: {
    '@deepseek-ai/dsh-client-ui-primitives': '0.1.0-rc.6',
    '@deepseek-ai/dsh-web-app': '0.1.0-rc.6',
    'dsh-rcs-core': 'link:D:/code/dsh4rcs/packages/dsh-rcs-core',
    'dsh-rcs-guard': 'link:D:/code/dsh4rcs/packages/dsh-rcs-guard',
  },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', 'dsh-rcs-core', '@deepseek-ai/dsh-web-app', 'dsh-rcs-guard'],
    },
  },
  pnpm: { overrides: { '@deepseek-ai/dsh-agent': '0.1.0-rc.6' } },
}

describe('profile 清单迁移', () => {
  it('摘掉旧版装进去的两个宿主包，插件依赖原样保留', () => {
    const { manifest, changes } = migrateProfileManifest(RC6_PROFILE)
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['dsh-rcs-core', 'dsh-rcs-guard'])
    expect(changes).toHaveLength(2)
  })

  it('bundles 里的 web-app 保留且位置不动 —— 它从安装目录解析，网页端靠它', () => {
    // 这是整个迁移最要紧的一条：依赖删了，bundles 那一项必须还在，否则起来没有网页界面。
    const { manifest } = migrateProfileManifest(RC6_PROFILE)
    expect(manifest.dsh?.profile?.bundles).toEqual(RC6_PROFILE.dsh?.profile?.bundles)
  })

  it('不认识的字段原样透传（手写的 pnpm 段不归本工具管）', () => {
    const { manifest } = migrateProfileManifest(RC6_PROFILE)
    expect(manifest['pnpm']).toEqual(RC6_PROFILE['pnpm'])
    expect(manifest['name']).toBe('dsh-profile-rcs-dev')
  })

  it('幂等：迁过一次再迁，什么都不改，返回同一个对象', () => {
    const once = migrateProfileManifest(RC6_PROFILE).manifest
    const twice = migrateProfileManifest(once)
    expect(twice.changes).toEqual([])
    expect(twice.manifest).toBe(once)
  })

  it('不改传入的对象', () => {
    const input = structuredClone(RC6_PROFILE)
    migrateProfileManifest(input)
    expect(input).toEqual(RC6_PROFILE)
  })

  it('按名字初始化、只有 dsh-base 的 profile 补上 web-app，紧跟 base', () => {
    const { manifest, changes } = migrateProfileManifest({
      dependencies: { 'dsh-rcs-core': 'link:x' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-rcs-core'], patchReload: 'live' } },
    })
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-rcs-core'])
    expect(manifest.dsh?.profile?.['patchReload']).toBe('live')
    expect(changes).toHaveLength(1)
  })

  it('dsh 自带 web 模板建的新 profile 无需迁移', () => {
    const fresh: ProfileManifest = {
      name: 'dsh-profile-rcs-dev',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE], patchReload: 'live' } },
    }
    const { manifest, changes } = migrateProfileManifest(fresh)
    expect(changes).toEqual([])
    expect(manifest).toBe(fresh)
  })

  it('人自己加的其它 @deepseek-ai 依赖不动', () => {
    const { manifest } = migrateProfileManifest({
      dependencies: { '@deepseek-ai/dsh-headless': '0.1.5-rc.1', ...RC6_PROFILE.dependencies },
      dsh: RC6_PROFILE.dsh,
    })
    expect(manifest.dependencies?.['@deepseek-ai/dsh-headless']).toBe('0.1.5-rc.1')
    for (const name of LEGACY_HOST_DEPENDENCIES) {
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(name)
    }
  })
})

describe('启动前检查', () => {
  const context = { profile: 'rcs-dev', manifestPath: 'C:/Users/a/.dsh/profiles/rcs-dev/package.json' }
  const withBundles = (bundles: string[]): ProfileManifest => ({ dsh: { profile: { bundles } } })

  it('装全了的 profile 不吭声', () => {
    const bundles = ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-rcs-control', 'dsh-rcs-core', 'dsh-rcs-guard']
    expect(profileBootProblem(withBundles(bundles), context)).toBeUndefined()
  })

  it('只卸了其中几个插件是人有意为之，不警告', () => {
    expect(profileBootProblem(withBundles(['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, 'dsh-rcs-core']), context)).toBeUndefined()
  })

  it('只有 dsh-base 的 profile 拦下 —— 照这样起来不打印网址、也不退出', () => {
    // 旧版 dsh:install 在 pnpm 那步失败后留下的就是这一份（问题报告里的现场）。
    const problem = profileBootProblem(withBundles(['@deepseek-ai/dsh-base']), context)
    expect(problem?.level).toBe('block')
    expect(problem?.message).toContain(WEB_APP_BUNDLE)
    expect(problem?.message).toContain('npm run dsh:install')
    expect(problem?.message).toContain('npm i -g pnpm@11')
  })

  it('有网页界面、一个插件都没有：警告但放行', () => {
    // 现在的 dsh:install 先按 web 模板建 profile，装插件那步失败留下的是这一份。
    const problem = profileBootProblem(withBundles(['@deepseek-ai/dsh-base', WEB_APP_BUNDLE]), context)
    expect(problem?.level).toBe('warn')
    expect(problem?.message).toContain('npm run dsh:install')
  })

  it('profile 不存在时拦下，指向 dsh:install 而不是 dsh plugin add', () => {
    // dsh 自己的报错建议 `dsh plugin add`，那恰好会按名字建出只有 dsh-base 的 profile。
    const problem = profileBootProblem(undefined, context)
    expect(problem?.level).toBe('block')
    expect(problem?.message).toContain('npm run dsh:install')
    expect(problem?.message).not.toContain('plugin add')
  })
})
