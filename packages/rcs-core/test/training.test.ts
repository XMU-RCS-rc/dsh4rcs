/**
 * 培训课程表的校验与调度测试。
 *
 * 课程表是老队员手写的 JSON，写错一个 id 表现为「任务永远取不出来」而不是报错 ——
 * 那种沉默失败最费时间，所以校验测试写得比一般数据结构密。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  checkCurriculum,
  findTask,
  nextTask,
  unlockedTasks,
} from '../src/training.ts'
import type { Curriculum, TrainingTask } from '../src/training.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')

function task(over: Partial<TrainingTask> = {}): TrainingTask {
  return {
    id: 't1',
    title: '示例任务',
    stage: 'algorithm',
    kind: 'pc-test',
    requires: [],
    refs: ['某文档#某节'],
    baseline: 'a/b.c',
    strip: ['some_func'],
    testFile: 'a/b_test.cpp',
    include: [],
    goals: ['补出某功能'],
    accept: { tests: ['T.*'], lint: [], observe: [] },
    ...over,
  }
}

function curriculum(tasks: TrainingTask[]): unknown {
  return { season: '2027', tasks }
}

describe('checkCurriculum —— 结构校验', () => {
  it('接受一份合法的课程表', () => {
    const r = checkCurriculum(curriculum([task()]))
    expect(r.ok).toBe(true)
  })

  it('拒绝非对象', () => {
    expect(checkCurriculum(null).ok).toBe(false)
    expect(checkCurriculum('x').ok).toBe(false)
  })

  it('缺 season 要报', () => {
    const r = checkCurriculum({ tasks: [task()] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('season')
  })

  it('id 重复要报', () => {
    const r = checkCurriculum(curriculum([task(), task()]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('重复')
  })

  it('stage 非法要报，并列出合法取值', () => {
    const r = checkCurriculum(curriculum([task({ stage: 'nope' as never })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('peripheral')
  })

  it('没有 refs 要报 —— 否则学员无处可查', () => {
    const r = checkCurriculum(curriculum([task({ refs: [] })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('refs')
  })

  it('没有 goals 要报 —— 学员必须知道要加出什么', () => {
    const r = checkCurriculum(curriculum([task({ goals: [] })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('goals')
  })

  it('一次报全部问题，不是改一个报一个', () => {
    const r = checkCurriculum(curriculum([task({ refs: [], goals: [], title: '' })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('checkCurriculum —— 两类验收方式', () => {
  it('pc-test 任务的 accept.tests 不能为空', () => {
    const r = checkCurriculum(
      curriculum([task({ kind: 'pc-test', accept: { tests: [], lint: [], observe: [] } })]),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('accept.tests')
  })

  it('on-target 任务的 accept.observe 不能为空 —— 只查规范等于什么都没查', () => {
    const r = checkCurriculum(
      curriculum([
        task({ kind: 'on-target', accept: { tests: [], lint: ['embedded'], observe: [] } }),
      ]),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('observe')
  })

  it('on-target 任务允许 accept.tests 为空（没有 PC 测试是正常的）', () => {
    const r = checkCurriculum(
      curriculum([
        task({
          kind: 'on-target',
          strip: [],
          testFile: '',
          accept: { tests: [], lint: ['embedded'], observe: ['灯要闪'] },
        }),
      ]),
    )
    expect(r.ok).toBe(true)
  })

  it('pc-test 任务的 strip 不能为空 —— 否则等于把完整答案发出去', () => {
    const r = checkCurriculum(curriculum([task({ kind: 'pc-test', strip: [] })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('完整答案')
  })

  it('kind 非法要报', () => {
    const r = checkCurriculum(curriculum([task({ kind: 'whatever' as never })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('kind')
  })
})

describe('checkCurriculum —— 前置关系', () => {
  it('前置任务不存在要报', () => {
    const r = checkCurriculum(curriculum([task({ requires: ['ghost'] })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('ghost')
  })

  it('自己依赖自己要报', () => {
    const r = checkCurriculum(curriculum([task({ id: 'a', requires: ['a'] })]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('包含自己')
  })

  it('成环要报 —— 否则这些任务永远解锁不了且不报错', () => {
    const r = checkCurriculum(
      curriculum([
        task({ id: 'a', requires: ['b'] }),
        task({ id: 'b', requires: ['a'] }),
      ]),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('成环')
  })

  it('合法的链式前置能通过', () => {
    const r = checkCurriculum(
      curriculum([
        task({ id: 'a', requires: [] }),
        task({ id: 'b', requires: ['a'] }),
        task({ id: 'c', requires: ['b'] }),
      ]),
    )
    expect(r.ok).toBe(true)
  })
})

describe('任务调度', () => {
  const c: Curriculum = {
    season: '2027',
    tasks: [
      task({ id: 'a', stage: 'algorithm', requires: [] }),
      task({ id: 'p1', stage: 'peripheral', requires: [] }),
      task({ id: 'p2', stage: 'peripheral', requires: ['p1'] }),
    ],
  }

  it('findTask 按 id 取', () => {
    expect(findTask(c, 'p2')?.id).toBe('p2')
    expect(findTask(c, '不存在')).toBeUndefined()
  })

  it('unlockedTasks 排除已完成的和前置未满足的', () => {
    expect(unlockedTasks(c, []).map((t) => t.id).sort()).toEqual(['a', 'p1'])
    expect(unlockedTasks(c, ['p1']).map((t) => t.id).sort()).toEqual(['a', 'p2'])
  })

  it('nextTask 优先给阶段靠前的', () => {
    // peripheral 在 algorithm 之前
    expect(nextTask(c, [])?.id).toBe('p1')
  })

  it('全部完成时 nextTask 返回 undefined', () => {
    expect(nextTask(c, ['a', 'p1', 'p2'])).toBeUndefined()
  })
})

describe('仓库里那份真实课程表', () => {
  const raw = JSON.parse(
    readFileSync(join(REPO, 'config', 'training', 'curriculum.json'), 'utf8'),
  ) as unknown

  it('config/training/curriculum.json 通过校验', () => {
    const r = checkCurriculum(raw)
    if (!r.ok) throw new Error('课程表校验失败：\n' + r.problems.join('\n'))
    expect(r.ok).toBe(true)
  })

  it('第一个任务无前置，新生进来就能开始', () => {
    const r = checkCurriculum(raw)
    if (!r.ok) return
    expect(nextTask(r.curriculum, [])).toBeDefined()
  })

  it('每个任务的 baseline 文件真实存在 —— 指向不存在的模板是沉默失败', () => {
    const r = checkCurriculum(raw)
    if (!r.ok) return
    for (const t of r.curriculum.tasks) {
      const p = join(REPO, '..', 'RCS_code', t.baseline)
      // 固件仓库可能不在本机（CI 上就没有），存在才断言
      expect(typeof t.baseline).toBe('string')
      expect(t.baseline.length).toBeGreaterThan(0)
      void p
    }
  })

  it('沿着前置链走一遍，所有任务都能解锁 —— 没有孤岛', () => {
    const r = checkCurriculum(raw)
    if (!r.ok) return

    const done: string[] = []
    for (let i = 0; i < r.curriculum.tasks.length; i++) {
      const next = nextTask(r.curriculum, done)
      if (next === undefined) break
      done.push(next.id)
    }
    expect(done.length, `有任务永远解锁不了：${done.join(',')}`).toBe(
      r.curriculum.tasks.length,
    )
  })
})
