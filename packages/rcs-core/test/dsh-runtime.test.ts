import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'

import {
  ensureAppendOnlyReporter,
  findCachedDsh,
  heartbeatLine,
  isInteractive,
  npxCacheRoots,
  normalizeChildExit,
  pluginInstallStage,
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
