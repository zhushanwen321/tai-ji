// thinking-levels.ts —— ModelSheet 思考档七值四段映射（remote-use-mobile-v2 §7.2 映射表行）。
//
// 值域权威 = shared PI_THINKING_LEVELS（七值含 off/max；A-03 事故教训：手写值域漏 'max'
// 致最高档静默不生效——本模块零手写值域，全部自该常量/类型派生，漏键漏值编译期红）。
// 映射语义（§7.2 思考档行）：
// - 面板四段：低=low、中=medium、高=high、最高=max；
// - 非段值处置（off/minimal/xhigh）：四段全不选中（aria-selected 全 false、无选中底，
//   roving tabindex 锚首段保键盘可达），段外原值经 chip 短词 + offSegmentHint 提示行
//   标注，用户选段即下发段值；
// - chip 短词表覆盖七值（off=关 / minimal=极低 / low=低 / medium=中 / high=高 /
//   xhigh=超高 / max=最高），词表键 = ThinkingLevel 全集（Record 类型对照）。
import { PI_THINKING_LEVELS, type ThinkingLevel } from '@taiji/shared'

/** 面板四段段值词表（顺序即呈现序）：satisfies 类型对照 ThinkingLevel——段值越界编译红 */
export const THINKING_SEGMENTS = ['low', 'medium', 'high', 'max'] as const satisfies readonly ThinkingLevel[]

export type ThinkingSegment = (typeof THINKING_SEGMENTS)[number]

/**
 * chip 短词 i18n key 尾段表：键 = PI_THINKING_LEVELS 七值全集（运行时由本断言 +
 * Record<ThinkingLevel, string> 编译期双对照——shared 扩型时漏键即编译红，静默落后不可能）。
 */
export const THINKING_LEVEL_LABEL_KEYS = PI_THINKING_LEVELS.reduce(
  (acc, level) => ({ ...acc, [level]: level }),
  {} as Record<ThinkingLevel, string>,
)

/**
 * 当前值的就近段（非段值就近归段）：off/minimal → 'low' 段、xhigh → 'max' 段、
 * 段值原样；undefined / 未知值 → null（无段可归）。唯一消费 = ModelSheet 的
 * offSegmentHint 提示行显隐判据，不进段控（非段值四段全不选中）。
 */
export function nearestSegmentOf(level: string | undefined): ThinkingSegment | null {
  if (level === undefined) return null
  if ((THINKING_SEGMENTS as readonly string[]).includes(level)) return level as ThinkingSegment
  if (level === 'off' || level === 'minimal') return 'low'
  if (level === 'xhigh') return 'max'
  return null
}

/**
 * 段选中态判定（§7.2：非段值不点亮段选中态）：当前值精确等于段值才 true——
 * off/minimal/xhigh 四段全不选中（就近段无任何段级视觉呈现），用户点段即下发段值。
 */
export function isSegmentSelected(level: string | undefined, segment: ThinkingSegment): boolean {
  return level === segment
}

/** 当前值是否段外值（选中态全空时的呈现分支判据；undefined = 尚无权威值，不算段外） */
export function isOffSegmentValue(level: string | undefined): boolean {
  return level !== undefined && !(PI_THINKING_LEVELS as readonly string[]).includes(level)
}
