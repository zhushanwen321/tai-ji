/**
 * Preset store —— pi 启动预设的「纯状态容器」。
 *
 * 设计文档：docs/architecture/pi-launch-presets.md
 *
 * 职责（与其他 store 同构，纯状态容器铁律）：
 * - 持有 presets（预设列表）+ defaultPresetId（全局默认预设 id）+ loadError（加载错误态）三份 state。
 * - setPresets / setDefaultPresetId / setLoadError / clearLoadError：纯写入 actions，
 *   由 composable（usePiPresets）喂数据。
 *
 * 不职责（已下沉到 usePiPresets composable）：
 * - 不 import @/api（订阅 / RPC 编排归 features 层 composable）。
 * - 不挂订阅（preset 域无 server-push 广播，按需 load）。
 *
 * 不持有「landing 态选中预设 id」：选中态透传链路（B6 修复）已统一走 NewTaskFlow.pendingPreset
 * （PresetSelectChip emit select → Landing.onPresetSelect → flow.setPendingPreset →
 * submitFirstMessage 透传 sessionApi.create）。不再用 store.selectedPresetId 作第二真源，
 * 避免「默认回显」与「用户选择」混在一起伪装透传源。PresetSelectChip 用本地 ref 管回显态。
 *
 * 依赖方向（stores 间禁止互相 import；跨域协调由 composables/features 做）：
 * - 无外部依赖（仅 vue ref + shared 类型）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PiLaunchPreset } from '@xyz-agent/shared'

export const usePresetStore = defineStore('preset', () => {
  // ── State ──
  /** 全部预设列表（内置 + 自定义）。loadPresets 后填充，初值 []。 */
  const presets = ref<PiLaunchPreset[]>([])
  /**
   * 全局默认预设 id（设计文档 §5.3，存 pi-presets.json defaultPresetId）。
   * loadPresets 时从 preset.getDefault RPC 拉取填充；初值 ''（未加载）。
   * 缺省 'builtin:full'（runtime 在无配置时返回全工具模式）。
   */
  const defaultPresetId = ref('')
  /**
   * 加载错误态（S-RN-2）。
   * loadPresets 任一 RPC rejected 时由 usePiPresets 写入错误消息（Error.message）；
   * 成功时清为 null。让 PresetSelectChip 区分「未加载（presets=[] + loadError=null）」
   * 与「加载失败（presets=[] + loadError=字符串）」，不再永久卡「加载中…」。
   */
  const loadError = ref<string | null>(null)
  /**
   * Popover 打开请求计数器（FR-16 键盘快捷键）。
   * 键盘快捷键 Cmd+Shift+P 递增此值，PresetSelectChip watch 到变化后打开 Popover。
   * 用计数器而非 boolean，保证连续按两次也能触发（值变化 → watch 触发）。
   */
  const openRequest = ref(0)

  // ── Actions（纯写入；RPC 编排 + 订阅生命周期在 usePiPresets composable）──

  /** 覆盖预设列表（loadPresets 拉到数据后写）。 */
  function setPresets(list: PiLaunchPreset[]): void {
    presets.value = list
  }

  /** 覆盖全局默认预设 id（loadPresets 拉到 / setDefault 乐观更新后写）。 */
  function setDefaultPresetId(id: string): void {
    defaultPresetId.value = id
  }

  /** 写加载错误态（usePiPresets.loadPresets rejected 分支用）。 */
  function setLoadError(message: string | null): void {
    loadError.value = message
  }

  /** 乐观更新：upsert 预设（按 id 匹配替换，不存在则 push）。 */
  function upsertPreset(preset: PiLaunchPreset): void {
    const idx = presets.value.findIndex((p) => p.id === preset.id)
    if (idx >= 0) {
      presets.value = [...presets.value.slice(0, idx), preset, ...presets.value.slice(idx + 1)]
    } else {
      presets.value = [...presets.value, preset]
    }
  }

  /** 乐观更新：移除预设（按 id 过滤）。 */
  function removePreset(presetId: string): void {
    presets.value = presets.value.filter((p) => p.id !== presetId)
  }

  /** FR-16：请求打开 PresetSelectChip Popover（键盘快捷键触发）。 */
  function requestOpen(): void {
    openRequest.value += 1
  }

  return {
    // state
    presets,
    defaultPresetId,
    loadError,
    openRequest,
    // actions（纯写入）
    setPresets,
    setDefaultPresetId,
    setLoadError,
    upsertPreset,
    removePreset,
    requestOpen,
  }
})
