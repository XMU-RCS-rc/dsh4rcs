/**
 * 真实执行器测试。
 *
 * 这里**真的会 spawn 子进程**（跑 node 自己），因为要验的正是超时、
 * 退出码、路径含空格这些只有真跑才暴露的东西。跑的都是 node 内置能力，
 * 不依赖 Keil / 烧录器 / cmake。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nodeRunner, whichSync, nodeDeps } from '../src/runner.ts'

const NODE = process.execPath

describe('nodeRunner', () => {
  it('取回 stdout 与退出码', async () => {
    const r = await nodeRunner(NODE, ['-e', 'console.log("hi")'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hi')
  })

  it('非零退出码如实返回', async () => {
    const r = await nodeRunner(NODE, ['-e', 'process.exit(3)'])
    expect(r.code).toBe(3)
  })

  it('stderr 单独收集', async () => {
    const r = await nodeRunner(NODE, ['-e', 'console.error("boom")'])
    expect(r.stderr).toContain('boom')
  })

  it('命令不存在时返回 spawnError 而不是抛异常', async () => {
    const r = await nodeRunner('definitely-not-a-real-binary-xyz', [])
    expect(r.spawnError).toBeTruthy()
    expect(r.code).toBe(-1)
  })

  it('超时会杀掉进程并说明是超时', async () => {
    const r = await nodeRunner(NODE, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 300 })
    expect(r.spawnError).toContain('超时')
  })

  it('参数含空格与中文时不被切碎 —— 不过 shell 的直接收益', async () => {
    const weird = '带 空格 与 中文/斜杠'
    const r = await nodeRunner(NODE, ['-e', 'console.log(process.argv[1])', weird])
    expect(r.stdout.trim()).toBe(weird)
  })

  it('cwd 生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcs-run-'))
    try {
      const r = await nodeRunner(NODE, ['-e', 'console.log(process.cwd())'], { cwd: dir })
      expect(r.stdout.trim().toLowerCase()).toContain('rcs-run-')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('whichSync', () => {
  it('能找到 node 自己', () => {
    expect(whichSync('node')).toBeTruthy()
  })

  it('找不到的返回 undefined', () => {
    expect(whichSync('definitely-not-a-real-binary-xyz')).toBeUndefined()
  })

  it('传绝对路径时直接判断该路径', () => {
    expect(whichSync(NODE)).toBe(NODE)
    expect(whichSync('D:/definitely/not/here.exe')).toBeUndefined()
  })

  it('零字节文件也算存在 —— Windows 应用执行别名就是这种', () => {
    // 复现踩到的坑：Store 版 Python 是零字节重解析点，
    // 只用 existsSync 会漏掉，导致误报「没有 Python」
    const dir = mkdtempSync(join(tmpdir(), 'rcs-which-'))
    try {
      mkdirSync(join(dir, 'bin'))
      const fake = join(dir, 'bin', 'zerobyte.exe')
      writeFileSync(fake, '')
      expect(whichSync(fake)).toBe(fake)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('nodeDeps', () => {
  it('提供 exists 与 which 两件事，形状与 ProbeDeps 一致', () => {
    expect(typeof nodeDeps.exists).toBe('function')
    expect(typeof nodeDeps.which).toBe('function')
    expect(nodeDeps.exists(NODE)).toBe(true)
  })
})
