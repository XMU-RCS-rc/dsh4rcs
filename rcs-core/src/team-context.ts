/**
 * 队内共享上下文的纯逻辑部分。
 *
 * 单独成层的原因和其它模块一样：这部分要能脱离 dsh 单测，
 * dsh 适配层（`dsh-rcs-core`）只把它包成 Service 暴露为 `ctx.rcs`。
 *
 * 注意：下面几个纯数据形状用 `type` 而不是 `interface`。
 * dsh 工具的输出要满足 `JsonValue`（`{[key: string]: JsonValue}`），
 * 而 TS 的 interface **不隐式带索引签名**、type 别名带 —— 用 interface 会编译不过。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { KbSource, SyncPolicy } from './kb-sync.ts'
import { resolveFirmwareRoot, repoPaths } from './paths.ts'

export type RobotId = 'TR' | 'BR'

export type RobotSpec = {
  id: string
  name: string
  /** `manual-or-auto` 或 `full-auto-required` */
  autonomy: string
  /** 允许进入的区域。 */
  zones: string[]
  /** 同时可携带的比赛用品数上限。 */
  carryLimit: number
  /** 溯源条款号。 */
  clause: string
}

export type Milestone = {
  id: string
  label: string
  /** ISO 日期；官方未公布时为 null，UI 应显示「待定」而不是编一个。 */
  date: string | null
  done: boolean
}

export type FirmwareInfo = {
  repo: string
  template: string
  legacy?: string
  mcu: string
  framework: string
  rtos: string
  lang: string
  layers: string[]
  uart: Record<string, string>
  actuators: string[]
  chassis: string
}

/**
 * 飞书接入配置。
 *
 * **这里没有 app_secret，且永远不该有** —— 只记环境变量的**名字**
 * （`appSecretEnv`），密钥本身由运行时从环境变量读。配置文件会进 git。
 */
export type FeishuConfig = {
  appId: string
  /** 存放 app_secret 的环境变量名，默认 `FEISHU_APP_SECRET`。 */
  appSecretEnv: string
  domain?: string
  /** 授权范围本身 —— 同步器只遍历这些目录的子树。 */
  sources: KbSource[]
  /**
   * 共享文件夹根目录。**刻意不放进 sources**：它含全队资料，超出电控范围。
   * 记在这里只为诊断脚本能核查"应用实际能看到多少"。
   */
  rootFolderToken?: string
  cacheDir: string
  syncPageSize?: number
  /** 相邻请求最小间隔（毫秒）。整次同步的耗时几乎全在目录列举上，嫌慢就调小。 */
  minIntervalMs?: number
  sync?: SyncPolicy
}

export interface TeamConfig {
  team: string
  season: string
  event: string
  theme: string | null
  themeAnnouncedAt?: string
  rules: { root: string; currentVersion: string; abuHost?: string; officialSite?: string }
  feishu?: FeishuConfig
  robots: RobotSpec[]
  firmware: FirmwareInfo
  milestones: Milestone[]
}

export function loadTeamConfig(file: string): TeamConfig {
  if (!existsSync(file)) {
    throw new Error(`队内配置不存在：${file}\n请确认 config/team.json 存在，或修正插件的 teamConfig 路径。`)
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as TeamConfig
  if (!raw.season || !Array.isArray(raw.robots)) {
    throw new Error(`队内配置格式不对（缺 season 或 robots）：${file}`)
  }
  return raw
}

/** 从相对/绝对路径推断所属工程层次。识别不出返回 undefined。 */
export function layerOfPath(file: string, layers: string[]): string | undefined {
  const normalized = file.replace(/\\/g, '/')
  // 长的先匹配，避免 `user` 命中 `RCS_Template/user_test.c` 之类
  for (const l of [...layers].sort((a, b) => b.length - a.length)) {
    if (normalized.includes(`/${l}/`) || normalized.startsWith(`${l}/`) || normalized.endsWith(`/${l}`)) {
      return l
    }
  }
  return undefined
}

/**
 * 距离某个里程碑还有多少天。
 *
 * @param today 今天的日期。**必须显式传入** —— 纯函数才好测，
 *              也避免"今天"这种隐式输入让结果不可复现。
 */
export function daysUntil(m: Milestone, today: Date): number | null {
  if (!m.date) return null
  const target = new Date(`${m.date}T00:00:00Z`)
  if (Number.isNaN(target.getTime())) return null
  const day = 24 * 60 * 60 * 1000
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((target.getTime() - t0) / day)
}

/** 下一个未完成且有日期的里程碑。 */
export function nextMilestone(ms: Milestone[], today: Date): Milestone | undefined {
  return ms
    .filter((m) => !m.done && m.date !== null)
    .filter((m) => (daysUntil(m, today) ?? -1) >= 0)
    .sort((a, b) => (daysUntil(a, today) ?? 0) - (daysUntil(b, today) ?? 0))[0]
}

/** 队内上下文的只读视图。适配层把它挂到 ctx.rcs。 */
export class TeamContext {
  readonly config: TeamConfig
  readonly configFile: string

  constructor(config: TeamConfig, configFile: string) {
    this.config = config
    this.configFile = configFile
  }

  static fromFile(file: string): TeamContext {
    return new TeamContext(loadTeamConfig(file), file)
  }

  get season(): string {
    return this.config.season
  }

  get theme(): string | null {
    return this.config.theme
  }

  /**
   * 固件仓库根目录。
   *
   * `config/team.json` 里的 `firmware.repo` **默认留空** —— 写死绝对路径
   * 在别人机器上不存在。留空时走 `paths.ts` 的解析链（环境变量 → 同级发现）。
   *
   * 解析不到返回空串而**不抛异常**：这个 getter 会被呈现钩子间接调用，
   * 按契约不得抛。需要硬失败的调用方（如 rcs_lint_layer）自己调
   * `resolveFirmwareRoot` 并在失败时给出「找过哪些路径」的完整报错。
   */
  get projectRoot(): string {
    const configured = this.config.firmware.repo
    const r = resolveFirmwareRoot(configured ? { explicit: configured } : {})
    return r.ok ? r.root : ''
  }

  get templateRoot(): string {
    const root = this.projectRoot
    return root ? join(root, this.config.firmware.template) : ''
  }

  /** 规则数据根目录。留空时回落到本仓库的 `data/rules`。 */
  get rulesRoot(): string {
    return this.config.rules.root || repoPaths.rulesRoot()
  }

  get rulesVersion(): string {
    return this.config.rules.currentVersion
  }

  get feishu(): FeishuConfig | undefined {
    return this.config.feishu
  }

  /** 知识库镜像目录。留空时回落到本仓库的 `data/kb-cache`。 */
  get kbCacheDir(): string {
    return this.config.feishu?.cacheDir || repoPaths.kbCache()
  }

  /** 按 id 找机器人。大小写不敏感。 */
  robot(id: string): RobotSpec | undefined {
    const key = id.trim().toUpperCase()
    return this.config.robots.find((r) => r.id.toUpperCase() === key)
  }

  /** 某台机器人是否允许进入某区域。 */
  mayEnter(robotId: string, zone: string): boolean | undefined {
    const r = this.robot(robotId)
    return r ? r.zones.includes(zone) : undefined
  }

  /** 文件属于哪一工程层次。 */
  layerOf(file: string): string | undefined {
    return layerOfPath(file, this.config.firmware.layers)
  }

  /** 赛季倒计时。today 显式传入，便于测试。 */
  countdown(today: Date): { milestone: Milestone; days: number }[] {
    return this.config.milestones
      .filter((m) => !m.done && m.date !== null)
      .map((m) => ({ milestone: m, days: daysUntil(m, today) ?? 0 }))
      .sort((a, b) => a.days - b.days)
  }

  /** 一句话摘要，给模型当上下文用。 */
  summary(today: Date): string {
    const next = nextMilestone(this.config.milestones, today)
    const theme = this.theme ?? '（主题待公布）'
    const nextText = next
      ? `下一个节点：${next.label}（${daysUntil(next, today)} 天后）`
      : '暂无已排期的下一个节点'
    return [
      `${this.config.team} · ${this.config.season} 赛季 · ${this.config.event}`,
      `主题：${theme}`,
      `规则版本：${this.rulesVersion}`,
      `机器人：${this.config.robots.map((r) => `${r.id}(${r.name}, ${r.autonomy})`).join('、')}`,
      `固件：${this.config.firmware.mcu} / ${this.config.firmware.framework} / ${this.config.firmware.rtos}`,
      nextText,
    ].join('\n')
  }
}
