/**
 * @rcs/ui —— RCS 专属 UI 的视图模型层。
 *
 * 纯投影 + 零依赖，被两处共用：
 *   Tier 1  工具呈现（presentCall / presentResult）—— 已接入
 *   Tier 2  客户端 UI（React slot）—— 队徽入口已接入，完整看板待补
 */
export {
  severityTone, layerOf, groupByFile, rankRootCauses,
  templateProgress, healthScore, healthFromFindings, callTitle, resultTitle,
  toPresentationMeta, isRcsMeta, statsLine,
} from './view-model.ts'
export type {
  Tone, RcsLayer, FileGroup, RootCause, StepProgress,
  TemplateProgressVM, HealthVM, RcsPresentationMeta,
  FindingLike, CheckResultLike,
} from './view-model.ts'

export { RCS_BRAND, TONE_MARK, LAYER_LABEL } from './theme.ts'
export type { ColorToken, RcsThemeTokens } from './theme.ts'

export { DEFAULT_PANEL_CONFIG, UnimplementedDashboardSource } from './panel-contract.ts'
export type {
  Milestone, RcsDashboardData, RcsPanelSection, RcsPanelConfig,
  RcsDashboardSource, RcsPanelState,
} from './panel-contract.ts'
