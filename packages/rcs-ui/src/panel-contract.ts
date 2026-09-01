/**
 * Tier 2：RCS 客户端面板契约 —— **接口已定，实现待补**。
 *
 * dsh 的客户端 UI 是一套 React slot 注册表（`@deepseek-ai/dsh-client-ui-slots`）：
 * 一次 `ctx.slots.register({ name, children?, store?, inject? }, Component)`
 * 把组件贡献进已声明的槽位，同时声明子槽位与 store 座位。
 *
 * 那是一个独立的**前端包**（React + 自己的构建产物 + 客户端运行时），
 * 与本仓库当前的 Node 侧插件不是一回事，因此这里只定义数据契约与刷新策略，
 * 组件实现留给 `packages/dsh-rcs-ui-client/`（尚未创建）。
 *
 * 为什么先定契约：面板要显示的数据必须由 Node 侧算好推过去，
 * 契约定下来，Tier 1（工具呈现）与 Tier 2（面板）就能共用同一套投影函数，
 * 不会出现两处各算一遍、结论还不一致的情况。
 */
import type { HealthVM, RootCause, TemplateProgressVM, Tone } from './view-model.ts'

/** 赛季里程碑。ROBOCON 每年主题重置，倒计时是战队最关心的公共信息之一。 */
export interface Milestone {
  id: string
  label: string
  /** ISO 日期字符串。主题未公布时为 null —— 面板应显示"待定"而不是假装有日期。 */
  date: string | null
  done: boolean
}

/** 工程健康看板的完整数据。 */
export interface RcsDashboardData {
  season: string
  /** 2027 主题公布前为 null。 */
  theme: string | null
  /** 工程健康分与分项。 */
  health: HealthVM
  /** 例程完成度，按 step1~step8 分组。 */
  template: TemplateProgressVM
  /** 污染源排名：先修哪个文件能一次解锁最多下游文件。 */
  rootCauses: RootCause[]
  /** 赛季里程碑倒计时。 */
  milestones: Milestone[]
  /** 上次检查时间（ISO）。 */
  lastCheckedAt: string | null
}

/** 面板的一块区域。面板由若干区块组成，便于按需裁剪。 */
export type RcsPanelSection =
  | 'health'
  | 'template-progress'
  | 'root-causes'
  | 'milestones'

export interface RcsPanelConfig {
  /** 显示哪些区块，按顺序。 */
  sections: RcsPanelSection[]
  /** 自动刷新间隔（毫秒）；0 表示只在手动触发时刷新。 */
  refreshIntervalMs: number
}

export const DEFAULT_PANEL_CONFIG: RcsPanelConfig = {
  sections: ['health', 'template-progress', 'root-causes', 'milestones'],
  // 默认不自动刷新：一次全量检查要遍历上万个文件，
  // 定时跑会白白占住 CPU，而这些数据本来就不是秒级变化的。
  refreshIntervalMs: 0,
}

/**
 * 面板数据源 —— **待实现**。
 *
 * Node 侧实现它，把结果推给客户端；客户端组件只消费，不自己算。
 */
export interface RcsDashboardSource {
  /** 取一次快照。 */
  snapshot(): Promise<RcsDashboardData>
  /** 订阅变化，返回取消订阅函数。 */
  subscribe(onChange: (data: RcsDashboardData) => void): () => void
}

/**
 * 尚未接入时的占位实现：明确报错，不返回假数据。
 * 面板显示"数据源未接入"远好于显示一个看起来正常的空看板。
 */
export class UnimplementedDashboardSource implements RcsDashboardSource {
  readonly reason: string

  constructor(reason = 'RCS 面板数据源尚未接入：需要先实现 Node 侧的快照与订阅') {
    this.reason = reason
  }

  snapshot(): Promise<RcsDashboardData> {
    return Promise.reject(new Error(this.reason))
  }

  subscribe(_onChange: (data: RcsDashboardData) => void): () => void {
    throw new Error(this.reason)
  }
}

/** 面板整体状态，供组件决定渲染什么。 */
export type RcsPanelState =
  | { status: 'loading' }
  | { status: 'ready'; data: RcsDashboardData }
  | { status: 'unavailable'; reason: string; tone: Tone }

/**
 * 待补充清单（Tier 2 实现时按此推进）：
 *
 * 1. 建 `packages/dsh-rcs-ui-client/`，依赖 `@deepseek-ai/dsh-client-ui-slots`
 *    与 React，产出客户端 bundle。
 * 2. 确认要挂进哪个已声明的槽位（sidebar / settings / conversation 各有槽位），
 *    未声明的槽位注册会在 register 时直接抛错。
 * 3. 实现 `RcsDashboardSource`：Node 侧跑检查 → 经 dsh 的客户端通道推送。
 * 4. 把 theme.ts 的 `RCS_BRAND` 换成真实品牌色，并与宿主的深浅色主题对齐。
 * 5. 赛季里程碑日期在 2027 主题公布后填入 `Milestone.date`。
 */
