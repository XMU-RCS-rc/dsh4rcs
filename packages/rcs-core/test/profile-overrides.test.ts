import { describe, expect, it } from 'vitest'

import {
  OVERRIDES_BEGIN,
  OVERRIDES_END,
  hasForeignOverrides,
  withOverridesBlock,
} from '../src/profile-overrides.ts'

// 实测的全新 profile 模板（dsh 0.1.0-rc.6 首次 plugin install 生成）。
// 注意它**没有** allowBuilds —— 维护者机器上那一行是早先手工加的。
const TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

const PINS = {
  overrides: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6', '@deepseek-ai/cordis': '4.0.1' },
  allowBuilds: ['koffi'],
}

describe('profile overrides 写入', () => {
  it('追加到模板末尾，模板原文逐字保留', () => {
    const out = withOverridesBlock(TEMPLATE, PINS)
    expect(out.startsWith(TEMPLATE.trimEnd())).toBe(true)
    expect(out).toContain("'@deepseek-ai/dsh-tools': 0.1.0-rc.6")
    expect(out).toContain('nodeLinker: hoisted')
  })

  it('包名按字典序排，两次生成结果一致', () => {
    const a = withOverridesBlock(TEMPLATE, PINS)
    const b = withOverridesBlock(TEMPLATE, {
      overrides: { '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
      allowBuilds: ['koffi'],
    })
    expect(a).toBe(b)
  })

  it('重复写入是幂等的 —— 整段替换而不是越堆越多', () => {
    const once = withOverridesBlock(TEMPLATE, PINS)
    const twice = withOverridesBlock(once, PINS)
    expect(twice).toBe(once)
    expect(twice.split(OVERRIDES_BEGIN).length - 1).toBe(1)
  })

  it('升级版本时替换旧段，不留下旧版本号', () => {
    const old = withOverridesBlock(TEMPLATE, {
      overrides: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
      allowBuilds: ['koffi'],
    })
    const next = withOverridesBlock(old, {
      overrides: { '@deepseek-ai/dsh-tools': '0.1.2-rc.1' },
      allowBuilds: ['koffi'],
    })
    expect(next).not.toContain('0.1.0-rc.6')
    expect(next).toContain('0.1.2-rc.1')
  })

  it('生成段后面的手写内容保住', () => {
    const withTail = `${withOverridesBlock(TEMPLATE, PINS)}\n# 本机备注：koffi 要手动允许构建\n`
    const next = withOverridesBlock(withTail, PINS)
    expect(next).toContain('# 本机备注：koffi 要手动允许构建')
  })

  it('认得出手写的 overrides，避免写出重复顶层键', () => {
    // YAML 里重复的顶层键只有一个生效，而哪个生效取决于解析器 ——
    // 「写进去了却没生效」比直接报错难查得多，所以这里必须能识别出来。
    expect(hasForeignOverrides(`${TEMPLATE}\noverrides:\n  foo: 1\n`)).toBe(true)
    expect(hasForeignOverrides(TEMPLATE)).toBe(false)
    expect(hasForeignOverrides(withOverridesBlock(TEMPLATE, PINS))).toBe(false)
  })

  it('空文件也能写', () => {
    const out = withOverridesBlock('', PINS)
    expect(out.startsWith(OVERRIDES_BEGIN)).toBe(true)
    expect(out.trimEnd().endsWith(OVERRIDES_END)).toBe(true)
  })
})

describe('allowBuilds', () => {
  it('写进生成段 —— pnpm 默认忽略构建脚本并直接失败退出', () => {
    // ERR_PNPM_IGNORED_BUILDS 不是警告而是失败：koffi 是原生 FFI 库，
    // 不放行整个 profile 装不完。这一行过去只在维护者手改的 profile 里存在，
    // 于是新人照文档装到最后一步必然失败。
    const out = withOverridesBlock(TEMPLATE, PINS)
    expect(out).toContain('allowBuilds:')
    expect(out).toContain('  koffi: true')
  })

  it('模板里已有手写的 allowBuilds 时停下来，不写出重复顶层键', () => {
    expect(hasForeignOverrides(`${TEMPLATE}
allowBuilds:
  koffi: true
`)).toBe(true)
  })

  it('空清单就不写这一段', () => {
    const out = withOverridesBlock(TEMPLATE, { overrides: PINS.overrides, allowBuilds: [] })
    expect(out).not.toContain('allowBuilds:')
  })
})
