/**
 * RCS 专属视觉 token —— **接口已定，品牌色待队内确认**。
 *
 * 这里只定义 token 的**契约**，不定义最终色值。理由：
 *   1. 我不知道 RCS 的品牌色与厦大校色规范，编一套出来就是假的；
 *   2. dsh 自带 `dsh-client-ui-theme`，最终要跟宿主主题（含深浅色）协调，
 *      硬编码色值会在暗色模式下翻车。
 *
 * 待队内补充：把 `RCS_BRAND` 换成实际品牌色，并确认深色模式下的对应值。
 */
import type { Tone, RcsLayer } from './view-model.ts'

/** 一个 token 在浅色/深色下的一对取值。 */
export interface ColorToken {
  light: string
  dark: string
}

export interface RcsThemeTokens {
  /** 品牌主色，用于面板标题、进度条。 */
  brand: ColorToken
  /** 语义色调。 */
  tone: Record<Tone, ColorToken>
  /** 五个工程层次的着色 —— 让人一眼看出问题出在哪一层。 */
  layer: Record<RcsLayer, ColorToken>
}

/**
 * 占位主题。**色值是中性占位，不是 RCS 品牌色。**
 * 换成真实品牌色时只改这个常量，所有消费方自动跟随。
 */
export const RCS_BRAND: RcsThemeTokens = {
  brand: { light: '#2563eb', dark: '#60a5fa' },
  tone: {
    critical: { light: '#dc2626', dark: '#f87171' },
    warning: { light: '#d97706', dark: '#fbbf24' },
    neutral: { light: '#6b7280', dark: '#9ca3af' },
    success: { light: '#16a34a', dark: '#4ade80' },
  },
  layer: {
    RCS_HAL: { light: '#7c3aed', dark: '#a78bfa' },
    RCS_Module: { light: '#0891b2', dark: '#22d3ee' },
    RCS_Support: { light: '#16a34a', dark: '#4ade80' },
    RCS_Template: { light: '#ca8a04', dark: '#facc15' },
    user: { light: '#db2777', dark: '#f472b6' },
    unknown: { light: '#6b7280', dark: '#9ca3af' },
  },
}

/**
 * 纯文本 UI（TUI、日志、模型可见文本）用的记号。
 * 不用颜色也要能区分严重级别 —— 赛场上可能就是一个黑白终端。
 */
export const TONE_MARK: Record<Tone, string> = {
  critical: '✗',
  warning: '!',
  neutral: '·',
  success: '✓',
}

/** 层次的短标签，用于紧凑显示。 */
export const LAYER_LABEL: Record<RcsLayer, string> = {
  RCS_HAL: 'HAL',
  RCS_Module: 'MOD',
  RCS_Support: 'SUP',
  RCS_Template: 'TPL',
  user: 'USR',
  unknown: '—',
}
