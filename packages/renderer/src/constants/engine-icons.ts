/**
 * subagent 引擎 → icon 映射（U3，设计 D8 三分支 / D9 消费位置）。
 *
 * 三分支：
 *  - engine undefined/空串 → pi icon（缺省映射：pi 分支 record.engine 保持 undefined，
 *    归属由读侧缺省表达，见 shared SubagentRecord.engine 注释）
 *  - engine 为已注册 id → 对应 icon 组件
 *  - engine 为未知非空值 → 中性圆点（@lucide/vue Circle，纯防御分支，运行期不可达）
 *
 * 扩展：未来新引擎只需在 ENGINE_ICON_REGISTRY 加一行（id → icon 组件），
 * 并提交 assets/icons/engine/<id>.svg 资产（设计场景 8「零 UI 改动」）。
 *
 * 已注册 id：pi / zcode / codex / kimi / opencode（kimi / opencode 为规划接入引擎预注册）。
 * Claude Code 明确不支持，不注册其引擎 icon。
 * icon 几何源 = lobehub icons（@lobehub/icons-static-svg），mono 版 path d 原样入仓：
 * pi ← pi.svg · zcode ← zai.svg（Z.ai 品牌标，非 zhipu）·
 * kimi ← kimi.svg · codex ← codex.svg · opencode ← opencode.svg。
 * 各资产 viewBox 统一扩边留白（内容占比 60%），pi 为官方自带留白（占比 ~59%），观感一致。
 */
import type { Component } from 'vue'
import { Circle } from '@lucide/vue'
import EnginePiIcon from '@/components/icons/EnginePiIcon.vue'
import EngineZcodeIcon from '@/components/icons/EngineZcodeIcon.vue'
import EngineKimiIcon from '@/components/icons/EngineKimiIcon.vue'
import EngineCodexIcon from '@/components/icons/EngineCodexIcon.vue'
import EngineOpencodeIcon from '@/components/icons/EngineOpencodeIcon.vue'

/** 已注册引擎 id → icon 组件（几何 SSOT = assets/icons/engine/<id>.svg） */
const ENGINE_ICON_REGISTRY: Record<string, Component> = {
  pi: EnginePiIcon,
  zcode: EngineZcodeIcon,
  codex: EngineCodexIcon,
  kimi: EngineKimiIcon,
  opencode: EngineOpencodeIcon,
}

/** 缺省引擎（record.engine 缺省时的归属，见 shared SubagentRecord.engine 注释） */
export const DEFAULT_ENGINE_ID = 'pi'

/** 未知引擎 id 的中性兜底 icon（防御分支） */
const NEUTRAL_ENGINE_ICON: Component = Circle

export interface EngineIconResolution {
  /** 渲染用的 icon 组件（单色 currentColor，尺寸由调用方 class 控制） */
  icon: Component
  /** 引擎显示名（title 提示用；未知 id 原样透出） */
  label: string
  /** 是否命中已注册映射（false = 中性圆点防御分支） */
  known: boolean
}

/** D8 三分支解析：engine 缺省/已注册/未知 */
export function resolveEngineIcon(engine?: string): EngineIconResolution {
  if (!engine) {
    return { icon: ENGINE_ICON_REGISTRY[DEFAULT_ENGINE_ID], label: DEFAULT_ENGINE_ID, known: true }
  }
  const icon = ENGINE_ICON_REGISTRY[engine]
  if (icon) return { icon, label: engine, known: true }
  return { icon: NEUTRAL_ENGINE_ICON, label: engine, known: false }
}
