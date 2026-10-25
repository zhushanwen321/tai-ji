/**
 * useLandingPresetDisplay —— landing 模式 chip 显示推导（自 Landing.vue 抽出，script 行数
 * 上限拆分；推导逻辑与原实现逐行等价，数据源 = useNewTaskDeps + flow）。
 *
 * 与 PresetSelectChip 内部同一 resolve 链（explicit > 全局默认 > builtin:full，D3 单一解析层）：
 * renderer 侧算好全名 / 信任标记，经 props 传给 ui chip（ui 包不耦合 renderer i18n——u4a 契约）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolveLaunchConfig } from '@taiji/core'
import { BUILTIN_PRESET_IDS, type PiLaunchPreset } from '@taiji/shared'
import type { NewTaskDeps } from '@taiji/ui'
import type { useNewTaskFlow } from '@taiji/core'

export function useLandingPresetDisplay(
  deps: NewTaskDeps,
  flow: ReturnType<typeof useNewTaskFlow>,
) {
  const { t } = useI18n()

  /**
   * 当前显示 / 将生效的模式（u4b 接线）：与 PresetSelectChip 内部同一 resolve 链。
   * renderer 侧算好全名 / 信任标记文案，经 props 传给 ui chip（短名不在传参面——chip 内
   * fallback 是唯一实现，避免去尾缀启发式双实现漂移）。
   */
  const displayPreset = computed<PiLaunchPreset | null>(() => {
    const presets = deps.presets.value
    const resolved = resolveLaunchConfig({
      pendingPreset: flow.pendingPreset?.value ?? null,
      presets,
      defaultPresetId: deps.defaultPresetId.value,
    })
    const id =
      resolved.presetId ??
      (presets.some((p) => p.id === BUILTIN_PRESET_IDS.FULL) ? BUILTIN_PRESET_IDS.FULL : '')
    return presets.find((p) => p.id === id) ?? null
  })
  /** 模式全名（缺省 undefined → ui chip 回落其内部解析名，既有接入零改动） */
  const modeName = computed(() => displayPreset.value?.name)
  /** 信任标记判据（设计 §7.1：`replace.enabled && 文案非空`） */
  const modeHasReplace = computed(() => {
    const seg = displayPreset.value?.prompt?.replace
    return !!seg?.enabled && (seg.prompt ?? '').trim().length > 0
  })
  /** 信任标记文案（文本/短名档 = chip 内后缀；纯图标档 = 角标 tooltip；空 → ui chip 不渲染标记） */
  const modeReplaceHint = computed(() =>
    modeHasReplace.value ? t('newTask.presetChip.replaceHint') : undefined,
  )
  /**
   * 模式 chip 强调底判据（设计 §5.1「颜色即状态」；方案 B）：当前生效模式 ≠ 默认模式才算非默认。
   *
   * 与 displayPreset 同源（同一 resolve 链）——displayPreset 存在 + id !== 默认档。默认档用
   * `||` 而非 `??`：store 未加载时 deps.defaultPresetId 为 `''`（非 null），`'' ?? x` 仍是 `''`，
   * 会把默认模式误判成非默认（恒亮 accent = 不携带信息，正是本判据要消除的退化）。
   * 注意 displayPreset 已把「解析不到」回落到 builtin:full（含 presets 未加载的 `''` 分支），
   * 故存在性 + 默认档比对即可，无需再处理空档。
   */
  const isNonDefaultPreset = computed(() => {
    const p = displayPreset.value
    if (!p) return false
    return p.id !== (deps.defaultPresetId.value || BUILTIN_PRESET_IDS.FULL)
  })

  return { displayPreset, modeName, modeHasReplace, modeReplaceHint, isNonDefaultPreset }
}
