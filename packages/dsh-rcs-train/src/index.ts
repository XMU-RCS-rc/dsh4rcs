/**
 * dsh-rcs-train —— 新生培训的任务发放与验收。
 *
 * ## 三条设计约束
 *
 * 1. **不判定"学会了"。** 工具只把机械部分自动化（测试过没过、规范干不干净、
 *    用没用过生成），把老队员的时间省下来留给提问。知识体系原文写的是
 *    「老队员验收**+提问**」—— 提问那一半机器做不了，也不该假装能做。
 *
 * 2. **给能跑的基线，让学员改出更复杂的功能。** 不是挖空填空 ——
 *    对没写过嵌入式的新生，满屏 TODO 连从哪下手都不知道。基线一烧就有现象，
 *    改坏了立刻知道，goals 明确列出还差什么。
 *
 * 3. **裁剪失败绝不交付。** 挖不干净就等于把答案直接发给学员，而且没人会发现
 *    （学员不会举报自己拿到了答案）。所以 scaffold 宁可报错，也不发半成品。
 *
 * 适配层照例做薄：判断逻辑全在 `@rcs/core` 的 training / scaffold /
 * training-store 里，这里只负责包成 Tool、读写文件和渲染。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

import { checkCurriculum, findTask, nextTask } from '../../rcs-core/src/training.ts'
import type { Curriculum, TrainingTask } from '../../rcs-core/src/training.ts'
import { scaffoldBanner, trimBaseline, workspaceCMake } from '../../rcs-core/src/scaffold.ts'
import {
  completedTaskIds,
  emptyProgress,
  parseProgress,
  renderReview,
  resolveWorkspaceRoot,
  taskProgressOf,
  taskWorkspace,
  withTaskProgress,
} from '../../rcs-core/src/training-store.ts'
import type { Progress, ReviewReport } from '../../rcs-core/src/training-store.ts'
import {
  firmwareNotFoundMessage,
  repoPaths,
  resolveFirmwareRoot,
  resolveRepoRoot,
} from '../../rcs-core/src/paths.ts'

export const name = 'rcs-train'
export const inject = ['tools']

export interface Config {
  /** 课程表路径。留空用 `config/training/curriculum.json`。 */
  curriculum: string
  /** 学员工作目录根。留空则按解析链找，默认与 dsh4rcs 仓库同级。 */
  workspaceRoot: string
  /** 学员标识，进验收单。不是账号系统，本机自填即可。 */
  student: string
}

export const Config: Schema<Config> = Schema.object({
  curriculum: Schema.string().default(''),
  workspaceRoot: Schema.string().default(''),
  student: Schema.string().default(''),
})

function callView(title: string, input: unknown): ToolCallView {
  return { card: 'generic', title, kind: 'search', rawInput: input }
}

/** Windows 路径 → WSL 路径。gtest 库只能在 WSL 里链接，CMakeLists 里必须写 WSL 视角的路径。 */
function toWsl(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (m === null) return p.split('\\').join('/')
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.split('\\').join('/')}`
}

function textView(text: string): ToolResultView {
  return { card: 'generic', body: text } as unknown as ToolResultView
}

export function apply(ctx: Context, config: Config): void {
  const curriculumPath = (): string =>
    config.curriculum !== ''
      ? config.curriculum
      : join(repoPaths.config(), 'training', 'curriculum.json')

  /**
   * 工作目录根。仓库位置在**这里**解析后传进去 —— training-store 是纯逻辑，
   * 而且它会被打进插件产物，在那边推 import.meta.url 会得到错的答案。
   */
  const workspace = (): { root: string; from: string } => {
    const repo = resolveRepoRoot()
    return resolveWorkspaceRoot({
      explicit: config.workspaceRoot,
      env: process.env,
      ...(repo.ok ? { repoRoot: repo.root } : {}),
      home: homedir(),
    })
  }

  const workspaceRoot = (): string => workspace().root

  /**
   * 进度文件放在**学员工作目录**里，不放共享仓库。
   *
   * 两个理由：
   *   1. 它是学员本机的个人数据，不该进版本控制，也不该被队友看到；
   *   2. 放仓库里会让测试和多人共用同一份进度 —— 实测踩过：
   *      跑一遍插件测试就把真实仓库的 data/ 写脏了。
   */
  const progressPath = (): string => join(workspaceRoot(), 'progress.json')

  /** 载入并校验课程表。校验失败直接抛 —— 拿一份坏课程表发任务比不发更糟。 */
  function loadCurriculum(): Curriculum {
    const p = curriculumPath()
    if (!existsSync(p)) {
      throw new Error(
        `找不到课程表：${p}\n` +
          `老队员需要先建好 config/training/curriculum.json（可参考仓库里的示例）。`,
      )
    }
    const r = checkCurriculum(JSON.parse(readFileSync(p, 'utf8')) as unknown)
    if (!r.ok) {
      throw new Error(`课程表有问题，已拒绝加载：\n  ${r.problems.join('\n  ')}`)
    }
    return r.curriculum
  }

  function loadProgress(): Progress {
    const p = progressPath()
    if (!existsSync(p)) return emptyProgress(config.student)
    try {
      return parseProgress(JSON.parse(readFileSync(p, 'utf8')) as unknown)
    } catch {
      // 文件坏了就当空进度重来。进度丢了只是重跑一次验收，
      // 拿半坏的记录去判断"这人做到哪了"会误导老队员。
      return emptyProgress(config.student)
    }
  }

  function saveProgress(p: Progress): void {
    const path = progressPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(p, null, 2), 'utf8')
  }

  /** 解析任务：给了 id 就取那个，没给就按前置关系推荐下一个。 */
  function pickTask(c: Curriculum, id: string | undefined, p: Progress): TrainingTask {
    if (id !== undefined && id !== '') {
      const t = findTask(c, id)
      if (t === undefined) {
        throw new Error(
          `没有这个任务：${id}\n可选：${c.tasks.map((x) => x.id).join(', ')}`,
        )
      }
      return t
    }
    const t = nextTask(c, completedTaskIds(p))
    if (t === undefined) {
      throw new Error('所有任务都已完成 —— 或者前置关系把剩下的都卡住了，请检查课程表。')
    }
    return t
  }

  // ---------- rcs_train_task ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_task',
      description:
        '取一个培训任务：要做什么、要加出哪些功能、前置知识在队内哪份资料里。' +
        '不传 taskId 就按前置关系推荐下一个。' +
        '这是**只读**工具，不会往任何地方写文件。',
      parameters: {
        taskId: { type: 'string', description: '任务 id，省略则推荐下一个' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task: { type: 'json', description: '任务定义' },
            text: { type: 'string', description: '给人看的任务说明' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('取培训任务', args.taskId ?? '（下一个）'),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args) {
        const c = loadCurriculum()
        const p = loadProgress()
        const t = pickTask(c, args.taskId, p)
        const tp = taskProgressOf(p, t.id)

        const L: string[] = []
        L.push(`任务 ${t.id}：${t.title}`)
        L.push(`阶段：${t.stage}    验收方式：${t.kind === 'pc-test' ? 'PC 单元测试（不用板子）' : '上板看现象'}`)
        if (t.requires.length > 0) L.push(`前置任务：${t.requires.join(', ')}`)
        L.push('')
        L.push('你要加出来的功能：')
        for (const g of t.goals) L.push(`  - ${g}`)
        L.push('')
        L.push('队内资料（用 rcs_kb_search 查这几个关键词）：')
        for (const r of t.refs) L.push(`  · ${r}`)
        L.push('')
        if (t.kind === 'pc-test') {
          L.push(`验收判据：这些 gtest 用例必须全绿 —— ${t.accept.tests.join(', ')}`)
        } else {
          L.push('验收判据（需当面确认）：')
          for (const o of t.accept.observe) L.push(`  □ ${o}`)
        }
        L.push('')
        L.push(
          tp.scaffoldedAt === null
            ? '还没领基线。用 rcs_train_scaffold 领取。'
            : `基线已于 ${tp.scaffoldedAt} 发到 ${taskWorkspace(t.id, workspaceRoot())}`,
        )

        return { task: t, text: L.join('\n') } as unknown as never
      },
    }),
  )

  // ---------- rcs_train_scaffold ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_scaffold',
      description:
        '把任务的**基线模板**发到学员工作目录。基线是一份能跑但功能不全的代码，' +
        '学员的任务是把它扩展完整。' +
        '注意：仓库里存的是完整实现，发放时按课程表动态挖空 —— ' +
        '**挖空失败会拒绝交付**，绝不发半成品（那等于直接给答案）。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id' },
        force: { type: 'boolean', description: '目标目录已存在时是否覆盖，默认否' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string', description: '发放目录' },
            files: { type: 'json', description: '写出的文件' },
            text: { type: 'string', description: '给人看的结果' },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('发放培训基线', args.taskId),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args) {
        const c = loadCurriculum()
        const t = findTask(c, args.taskId)
        if (t === undefined) {
          throw new Error(`没有这个任务：${args.taskId}`)
        }

        const fw = resolveFirmwareRoot({})
        if (!fw.ok) {
          throw new Error(firmwareNotFoundMessage(fw.tried))
        }

        const src = join(fw.root, t.baseline)
        if (!existsSync(src)) {
          throw new Error(`基线文件不存在：${src}\n请检查课程表里 ${t.id} 的 baseline 路径。`)
        }

        // ---- 裁剪。失败就整体拒绝，绝不发半成品 ----
        const trimmed = trimBaseline(
          readFileSync(src, 'utf8'),
          t.strip,
          '让对应的测试变绿（跑一次测试，红的那条就是这里）',
        )
        if (!trimmed.ok) {
          throw new Error(
            `基线裁剪失败，**已拒绝发放**：\n  ${trimmed.problems.join('\n  ')}\n\n` +
              `挖不干净就等于把完整答案发给学员，所以这里宁可报错。` +
              `请老队员核对课程表里 ${t.id} 的 strip 列表与基线源码是否对得上。`,
          )
        }

        const ws = taskWorkspace(t.id, workspaceRoot())
        if (existsSync(ws) && args.force !== true) {
          throw new Error(
            `工作目录已存在：${ws}\n` +
              `直接覆盖会抹掉学员已经写的代码。确认要重发请传 force: true。`,
          )
        }
        mkdirSync(ws, { recursive: true })

        const files: string[] = []

        const banner = scaffoldBanner(t.id, new Date(), t.goals)
        const outSrc = join(ws, basename(t.baseline))
        writeFileSync(outSrc, banner + trimmed.source, 'utf8')
        files.push(outSrc)

        // 测试文件原样发（它就是"还差什么"的清单，不该挖空）
        const testNames: string[] = []
        if (t.testFile !== '') {
          const tsrc = join(fw.root, t.testFile)
          if (!existsSync(tsrc)) {
            throw new Error(
              `测试文件不存在：${tsrc}
` +
                `pc-test 任务缺了测试，学员就不知道"还差什么" —— 已拒绝发放。`,
            )
          }
          const outTest = join(ws, basename(t.testFile))
          writeFileSync(outTest, readFileSync(tsrc, 'utf8'), 'utf8')
          files.push(outTest)
          testNames.push(basename(t.testFile))
        }

        // 头文件等原样带上。少了它学员根本编不过，
        // 而报错会指向一个跟任务无关的方向，非常劝退。
        for (const inc of t.include) {
          const isrc = join(fw.root, inc)
          if (!existsSync(isrc)) {
            throw new Error(`include 里的文件不存在：${isrc}
请检查课程表里 ${t.id} 的 include。`)
          }
          const out = join(ws, basename(inc))
          writeFileSync(out, readFileSync(isrc, 'utf8'), 'utf8')
          files.push(out)
        }

        // 生成工作目录专用的 CMakeLists —— 仓库里那份的相对路径在扁平目录下不成立
        if (testNames.length > 0) {
          const gtestDir = toWsl(
            join(fw.root, 'template', 'RCS_Template_F407', 'RCS', 'RCS_Support', 'test', 'lib'),
          )
          const cmake = join(ws, 'CMakeLists.txt')
          writeFileSync(
            cmake,
            workspaceCMake(t.id, gtestDir, [basename(t.baseline)], testNames),
            'utf8',
          )
          files.push(cmake)
        }

        const p = withTaskProgress(loadProgress(), t.id, {
          scaffoldedAt: new Date().toISOString(),
        })
        saveProgress(p)

        const L: string[] = []
        L.push(`已发放：${t.id}  ${t.title}`)
        L.push(`目录：${ws}`)
        L.push('')
        L.push('文件：')
        for (const f of files) L.push(`  ${f}`)
        L.push('')
        if (trimmed.stripped.length > 0) {
          L.push(`挖空了 ${trimmed.stripped.length} 个函数，它们标着 TODO：`)
          for (const s of trimmed.stripped) L.push(`  · ${s}`)
          L.push('')
        }
        L.push('下一步：跑一次测试，红的那几条就是还差的功能。')

        return { workspace: ws, files, text: L.join('\n') } as unknown as never
      },
    }),
  )

  // ---------- rcs_train_review ----------

  ctx.tools.register(
    defineTool({
      name: 'rcs_train_review',
      description:
        '生成**给老队员看的验收单**：测试几比几、规范干不干净、用没用过 G2 生成、' +
        '需要当面确认哪些现象、建议追问什么。' +
        '刻意**不给通过/不通过的总判定** —— 是否掌握由验收人提问后决定。' +
        '测试与规范结果需由调用方先跑 rcs_support_test / rcs_lint_embedded 后传入。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id' },
        testsPassed: { type: 'number', description: 'gtest 通过数' },
        testsFailed: { type: 'number', description: 'gtest 失败数' },
        testFailures: { type: 'json', description: '失败用例名数组' },
        testBlocked: { type: 'string', description: '测试无法运行的原因（如工具链缺失）' },
        lintErrors: { type: 'number', description: 'lint 错误数' },
        lintWarnings: { type: 'number', description: 'lint 警告数' },
        lintFindings: { type: 'json', description: 'lint 发现条目数组' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', description: '验收单' } },
        },
        render: (_args, value) => {
          const v = value as unknown as { text: string }
          return [{ type: 'text', text: v.text ?? '' }]
        },
      },
      presentCall: (args) => callView('生成验收单', args.taskId),
      presentResult: (_a, r) =>
        textView(String((r as { text?: string })?.text ?? '')),
      async execute(args) {
        const c = loadCurriculum()
        const t = findTask(c, args.taskId)
        if (t === undefined) throw new Error(`没有这个任务：${args.taskId}`)

        const p0 = loadProgress()
        const tp = taskProgressOf(p0, t.id)

        const report: ReviewReport = {
          task: t,
          student: p0.student || config.student,
          generated: tp.generated,
          reviews: tp.reviews + 1,
        }

        if (
          args.testsPassed !== undefined ||
          args.testsFailed !== undefined ||
          args.testBlocked !== undefined
        ) {
          report.tests = {
            passed: args.testsPassed ?? 0,
            failed: args.testsFailed ?? 0,
            failures: Array.isArray(args.testFailures) ? (args.testFailures as string[]) : [],
            ...(args.testBlocked !== undefined ? { blocked: args.testBlocked } : {}),
          }
        }

        if (args.lintErrors !== undefined || args.lintWarnings !== undefined) {
          report.lint = {
            errors: args.lintErrors ?? 0,
            warnings: args.lintWarnings ?? 0,
            findings: Array.isArray(args.lintFindings) ? (args.lintFindings as string[]) : [],
          }
        }

        saveProgress(withTaskProgress(p0, t.id, { reviews: tp.reviews + 1 }))

        return { text: renderReview(report) } as unknown as never
      },
    }),
  )

  // 横幅带上「这个路径是怎么来的」：默认值变过一次，
  // 而学员看到的第一手信息就是这一行。说不清来源，出问题时没人查得动。
  const ws = workspace()
  console.info(
    `[rcs-train] 培训插件已加载：课程表 ${curriculumPath()}，` +
      `工作目录 ${ws.root}（来源：${ws.from}）`,
  )
}
