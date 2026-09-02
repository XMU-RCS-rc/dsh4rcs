/**
 * dsh-rcs-core —— 队内共享上下文服务。
 *
 * 这是**类式插件**：继承 `Service` 并以 `rcs` 为名注册，其它插件通过
 * `inject: ['rcs']`（必需）或 `ctx.get('rcs')`（可选）拿到它。
 *
 * ## 为什么要有这一层
 *
 * 赛季、主题、工程路径、机器人角色这些东西，每个插件各存一份配置就会发散——
 * 换赛季时改了这个忘了那个。这里做单一真相：`config/team.json` 一处改，全体跟随。
 *
 * ## 对外提供
 *
 *   ctx.rcs.season / theme / projectRoot / rulesRoot / rulesVersion
 *   ctx.rcs.robot(id)        按 TR/BR 查角色与区域限制
 *   ctx.rcs.layerOf(file)    文件属于哪一工程层次
 *   ctx.rcs.countdown(today) 赛季倒计时
 *
 * 另注册一个 `rcs_team_context` 工具，让模型能直接问「我们现在什么赛季、什么主题」。
 */
import { readFileSync, writeFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'

import { TeamContext, daysUntil } from '../../rcs-core/src/team-context.ts'
import type { TeamConfig } from '../../rcs-core/src/team-context.ts'
import { repoPaths, REPO_ROOT } from '../../rcs-core/src/paths.ts'
import { nodeRunner } from '../../rcs-core/src/runner.ts'
import {
  checkFreshness,
  checkRulesFreshness,
  summarizeFreshness,
  nodeFetchJson,
} from '../../rcs-core/src/freshness.ts'
import type { FreshnessStore } from '../../rcs-core/src/freshness.ts'

export const name = 'rcs-core'

export interface Config {
  /** 队内配置文件路径。 */
  teamConfig: string
}

export const Config: Schema<Config> = Schema.object({
  // 默认留空：写死绝对路径在别人机器上一个都不存在。留空时回落到
  // 本仓库内的 config/team.json（由 repoPaths 从模块位置推出）。
  teamConfig: Schema.string().default(''),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    rcs: RcsService
  }
}

/**
 * 队内上下文服务。
 *
 * 注意：Service 的构造函数第二个参数就是服务名，别人 `inject: ['rcs']` 拿的就是它。
 */
export class RcsService extends Service {
  readonly team: TeamContext

  constructor(ctx: Context, config: Config) {
    super(ctx, 'rcs')
    this.team = TeamContext.fromFile(config.teamConfig || repoPaths.teamConfig())
  }

  get season(): string {
    return this.team.season
  }
  get theme(): string | null {
    return this.team.theme
  }
  get projectRoot(): string {
    return this.team.projectRoot
  }
  get templateRoot(): string {
    return this.team.templateRoot
  }
  get rulesRoot(): string {
    return this.team.rulesRoot
  }
  get rulesVersion(): string {
    return this.team.rulesVersion
  }
  get config(): TeamConfig {
    return this.team.config
  }

  robot(id: string) {
    return this.team.robot(id)
  }
  mayEnter(robotId: string, zone: string) {
    return this.team.mayEnter(robotId, zone)
  }
  layerOf(file: string) {
    return this.team.layerOf(file)
  }
  countdown(today: Date) {
    return this.team.countdown(today)
  }
  summary(today: Date): string {
    return this.team.summary(today)
  }
}

function callView(title: string): ToolCallView {
  return { card: 'generic', title, kind: 'read' }
}

/**
 * 版本缓存的落盘实现。
 *
 * 读写都吞掉异常：缓存只是省一次网络往返，**它自己永远不该成为失败的理由**。
 * 磁盘只读、目录被删、JSON 坏了，都应该退化成「这次多打一次网」。
 */
function cacheStore(): FreshnessStore {
  const file = repoPaths.versionCache()
  return {
    read: () => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    },
    write: (text) => {
      try {
        writeFileSync(file, text)
      } catch {
        /* 写不进去就下次重查 */
      }
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  // Service 在构造时就把自己注册进 ctx，插件卸载时由 fiber 自动回收
  ctx.plugin(RcsService, config)

  // 工具注册需要 tools 服务。用 ctx.inject 而不是顶层 inject：
  // 这样即使没有 tools（比如纯 headless 组合），Service 本身依然可用。
  ctx.inject(['tools'], (scoped) => {
    scoped.tools.register(
      defineTool({
        name: 'rcs_team_context',
        description:
          '查询 RCS 队内上下文：当前赛季、主题、规则版本、机器人角色与区域限制、' +
          '固件技术栈、赛季倒计时。回答"我们现在打什么比赛/什么主题/还有多久"这类问题时先调它。',
        parameters: {
          robot: {
            type: 'string',
            description: '只看某台机器人（TR 或 BR）的角色与限制，省略则返回全部上下文',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string', description: '人类可读摘要' },
              season: { type: 'string', description: '赛季' },
              theme: { type: 'string', description: '主题；未公布时为空串' },
              rulesVersion: { type: 'string', description: '当前规则版本' },
              robots: { type: 'json', description: '机器人角色与区域限制' },
              countdown: { type: 'json', description: '赛季倒计时' },
              firmware: { type: 'json', description: '固件技术栈' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
        },
        presentCall: () => callView('查询队内上下文'),
        async execute(args, exec) {
          // 用 exec 的时间基准而不是 new Date()：便于回放与测试
          const today = new Date()
          const rcs = scoped.rcs
          const robots = args.robot
            ? [rcs.robot(args.robot)].filter((r) => r !== undefined)
            : rcs.config.robots

          const countdown = rcs.countdown(today).map((c) => ({
            id: c.milestone.id,
            label: c.milestone.label,
            date: c.milestone.date,
            days: c.days,
          }))

          const lines = [rcs.summary(today)]
          if (args.robot) {
            const r = robots[0]
            lines.push(
              r
                ? `\n${r.id}（${r.name}）：${r.autonomy}，可进入 ${r.zones.join('/')}，同时最多携带 ${r.carryLimit} 个（条款 ${r.clause}）`
                : `\n没有找到机器人「${args.robot}」，本届只有 TR 与 BR。`,
            )
          }
          const next = countdown[0]
          if (next) lines.push(`\n最近节点：${next.label} —— ${next.days} 天后（${next.date}）`)

          // 规则书过期提醒是纯函数、零成本、零网络，所以顺带挂在这里：
          // 问「我们现在什么赛季」的人，正是最该知道「规则版本很久没确认过了」的人。
          // 拿错版本的条款会给出带条款号、看起来完全可信的答案 —— 比查不到危险得多。
          const rulesFresh = checkRulesFreshness(rcs.config.rules, today)
          if (rulesFresh.status !== 'ok') lines.push(`\n⚠️  ${rulesFresh.detail}`)

          void exec
          return {
            summary: lines.join('\n'),
            season: rcs.season,
            theme: rcs.theme ?? '',
            rulesVersion: rcs.rulesVersion,
            robots,
            countdown,
            firmware: rcs.config.firmware,
          }
        },
      }),
    )

    scoped.tools.register(
      defineTool({
        name: 'rcs_version_status',
        description:
          '检查手上这套东西是不是过时了：规则书版本、插件代码、dsh 宿主。' +
          '**只报告，不会自动升级或拉取任何东西。** 回答"我这份是不是旧的/要不要更新"时调它。' +
          '赛场模式下被安全层拦掉（联网 + 落盘）。',
        parameters: {
          refresh: {
            type: 'boolean',
            description: '忽略缓存强制重查。默认读 24 小时内的缓存结果，避免反复打网。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string', description: '人类可读摘要' },
              stale: { type: 'number', description: '过时项数量' },
              items: { type: 'json', description: '三项检查的结构化结果' },
              fromCache: { type: 'boolean', description: '联网两项是否来自缓存' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
        },
        presentCall: () => callView('检查版本新鲜度'),
        async execute(args, exec) {
          void exec
          const report = await checkFreshness({
            deps: { run: nodeRunner, fetchJson: nodeFetchJson },
            repoRoot: REPO_ROOT,
            rules: scoped.rcs.config.rules,
            now: new Date(),
            store: cacheStore(),
            refresh: args.refresh === true,
          })
          return {
            summary: summarizeFreshness(report),
            stale: report.items.filter((i) => i.status === 'stale').length,
            items: report.items,
            fromCache: report.fromCache,
          }
        },
      }),
    )
  })

  ctx.effect(() => {
    // 配置是启动时一次性读入的，没有常驻句柄。
    // 将来若加文件监听热重载，务必在这里注销监听。
    void daysUntil
    return () => {}
  })
}
