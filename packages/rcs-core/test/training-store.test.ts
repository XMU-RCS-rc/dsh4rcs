/**
 * 培训进度存储与验收单渲染测试。
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import {
  completedTaskIds,
  defaultWorkspaceRoot,
  emptyProgress,
  parseProgress,
  renderReview,
  taskProgressOf,
  taskWorkspace,
  withTaskProgress,
} from '../src/training-store.ts'
import type { ReviewReport } from '../src/training-store.ts'
import type { TrainingTask } from '../src/training.ts'

const task: TrainingTask = {
  id: 'ring-buffer',
  title: '环形缓冲区：从单字节收发扩展到批量读写',
  stage: 'algorithm',
  kind: 'pc-test',
  requires: [],
  refs: ['RCSLIB代码规范#编码细节'],
  baseline: 'a/b.c',
  strip: ['f'],
  testFile: 'a/b_test.cpp',
  include: [],
  goals: ['补出批量读写'],
  accept: { tests: ['RB.*'], lint: ['embedded'], observe: [] },
}

const onTarget: TrainingTask = {
  ...task,
  id: 'gpio-key',
  title: 'GPIO 与中断',
  kind: 'on-target',
  strip: [],
  testFile: '',
  accept: {
    tests: [],
    lint: ['embedded'],
    observe: ['板载 LED 每秒闪一次', '能说出轮询与中断的区别'],
  },
}

describe('工作目录', () => {
  it('默认在用户主目录下，不依赖盘符', () => {
    expect(defaultWorkspaceRoot('/home/xy')).toBe(join('/home/xy', 'rcs-training'))
  })

  it('每个任务一个子目录', () => {
    expect(taskWorkspace('ring-buffer', '/w')).toBe(join('/w', 'ring-buffer'))
  })
})

describe('进度记录', () => {
  it('空进度里取任务返回空记录而不是 undefined', () => {
    const p = emptyProgress('小王')
    const t = taskProgressOf(p, 'ring-buffer')
    expect(t.taskId).toBe('ring-buffer')
    expect(t.scaffoldedAt).toBeNull()
    expect(t.generated).toBe(0)
  })

  it('withTaskProgress 是不可变更新', () => {
    const p1 = emptyProgress()
    const p2 = withTaskProgress(p1, 'a', { reviews: 1 })
    expect(taskProgressOf(p1, 'a').reviews).toBe(0)
    expect(taskProgressOf(p2, 'a').reviews).toBe(1)
  })

  it('completedTaskIds 只收已完成的', () => {
    let p = emptyProgress()
    p = withTaskProgress(p, 'a', { completedAt: '2026-10-04T00:00:00Z' })
    p = withTaskProgress(p, 'b', { reviews: 3 })
    expect(completedTaskIds(p)).toEqual(['a'])
  })
})

describe('parseProgress —— 坏数据不能误导老队员', () => {
  it('非对象回落成空进度', () => {
    expect(parseProgress(null).tasks).toEqual({})
    expect(parseProgress('x').tasks).toEqual({})
  })

  it('版本不对时丢弃任务但保留学员名', () => {
    const p = parseProgress({ version: 99, student: '小李', tasks: { a: {} } })
    expect(p.student).toBe('小李')
    expect(p.tasks).toEqual({})
  })

  it('字段类型不对时回落到安全默认值', () => {
    const p = parseProgress({
      version: 1,
      student: '小李',
      tasks: { a: { reviews: '三次', generated: -5, scaffoldedAt: 123 } },
    })
    expect(p.tasks.a?.reviews).toBe(0)
    expect(p.tasks.a?.generated).toBe(0)
    expect(p.tasks.a?.scaffoldedAt).toBeNull()
  })

  it('正常数据原样读回', () => {
    const p = parseProgress({
      version: 1,
      student: '小李',
      tasks: { a: { taskId: 'a', reviews: 2, generated: 1, scaffoldedAt: 'X', completedAt: null } },
    })
    expect(p.tasks.a?.reviews).toBe(2)
    expect(p.tasks.a?.generated).toBe(1)
  })
})

describe('renderReview —— pc-test 任务', () => {
  const base: ReviewReport = { task, student: '小王', generated: 0, reviews: 1 }

  it('列出测试通过比例', () => {
    const s = renderReview({ ...base, tests: { passed: 8, failed: 0, failures: [] } })
    expect(s).toContain('8/8 通过')
  })

  it('逐条列出失败用例', () => {
    const s = renderReview({
      ...base,
      tests: { passed: 4, failed: 2, failures: ['RB.WriteTruncates', 'RB.PeekDoesNotConsume'] },
    })
    expect(s).toContain('4/6 通过')
    expect(s).toContain('RB.WriteTruncates')
  })

  it('测试无法运行时明确说无法运行，而不是报成 0 通过', () => {
    const s = renderReview({
      ...base,
      tests: { passed: 0, failed: 0, failures: [], blocked: 'libgtest.a 是 Linux 产物，需在 WSL 内构建' },
    })
    expect(s).toContain('无法运行')
    expect(s).toContain('WSL')
  })

  it('G2 用过时高亮提示核对', () => {
    const s = renderReview({ ...base, generated: 2 })
    expect(s).toContain('G2 使用过 2 次')
    expect(s).toContain('核对')
  })

  // 计数为 0 时**不能**说成「学员自己写的」：generated 还没有任何写入方
  // （rcs_train_generate 未实现），0 只代表没人记过。把它渲染成一个结论，
  // 会让老队员据此少问几句 —— 那是本仓库「假绿比红更危险」要防的。
  it('计数为 0 时如实说无法判定，不冒充「自己写的」', () => {
    const s = renderReview(base)
    expect(s).toContain('无法判定')
    expect(s).not.toContain('自己补的')
  })

  it('不给通过/不通过的总判定 —— 那是验收人的事', () => {
    const s = renderReview({ ...base, tests: { passed: 8, failed: 0, failures: [] } })
    expect(s).not.toContain('通过验收')
    expect(s).toContain('由验收人提问后决定')
  })
})

describe('renderReview —— on-target 任务', () => {
  const base: ReviewReport = { task: onTarget, student: '小张', generated: 0, reviews: 1 }

  it('说明没有 PC 测试，必须上板看现象', () => {
    const s = renderReview(base)
    expect(s).toContain('无 PC 测试')
    expect(s).toContain('上板')
  })

  it('列出需当面确认的现象清单', () => {
    const s = renderReview(base)
    expect(s).toContain('需当面确认')
    expect(s).toContain('板载 LED 每秒闪一次')
  })

  it('把 observe 里的"能说出..."转成追问题目', () => {
    const s = renderReview(base)
    expect(s).toContain('建议追问')
    expect(s).toContain('请说出轮询与中断的区别')
  })

  it('追问题目标注来自课程表，不是现编的', () => {
    expect(renderReview(base)).toContain('非现编')
  })
})

describe('renderReview —— 规范检查', () => {
  const base: ReviewReport = { task, student: '小王', generated: 0, reviews: 1 }

  it('干净时说干净', () => {
    expect(renderReview({ ...base, lint: { errors: 0, warnings: 0, findings: [] } })).toContain(
      '规范：干净',
    )
  })

  it('有问题时列出条目', () => {
    const s = renderReview({
      ...base,
      lint: { errors: 1, warnings: 2, findings: ['中断里调用了 printf'] },
    })
    expect(s).toContain('1 个错误 / 2 个警告')
    expect(s).toContain('中断里调用了 printf')
  })

  it('没检查时说未检查，不说干净', () => {
    const s = renderReview(base)
    expect(s).toContain('规范：未检查')
    expect(s).not.toContain('规范：干净')
  })
})
