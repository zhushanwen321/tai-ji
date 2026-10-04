<script setup lang="ts">
/**
 * PresetSelectChip —— pi 启动预设选择 chip（设计文档 pi-launch-presets.md §3 / §5.4）。
 *
 * [w4 迁移] 自 renderer components/new-task/PresetSelectChip.vue（260 行）迁入 ui 包
 * features/new-task/（C-NT-4）。变化：presetStore.presets/defaultPresetId/openRequest →
 * deps.presets/deps.defaultPresetId/deps.presetOpenRequest（NewTaskDeps inject，C-W4-1，
 * Ref 保持响应式）；usePiPresets().loadPresets/setDefault → deps.loadPresets/deps.setDefaultPreset；
 * ui 原语走包内相对导入（不经顶层 barrel，防自引用环）。三态（landing/锁定/历史）逻辑 + emit 契约（select/
 * update:presetOpen）逐字迁移（CT-4，不做功能改动）。
 *
 * landing 态 chip 底色（设计文档 pi-launch-presets.md §5.1「颜色即状态」）：默认模式中性底（text-neutral-mid + 邻位 chip
 * 同款 hover 反馈），非默认模式 accent 底（props.accent，判据由 renderer 侧算好传入）。
 *
 * 三态（由 props.sessionId + props.launchPresetId 派生）：
 * 1. landing 态（sessionId=null）：Popover 可展开，列预设（PopoverListItem 项 + selected
 *    单选语义）+ 描述 + 「设为默认」Checkbox。回显 = launch-config 解析输出
 *    （explicit 显式选择 > 全局默认 > builtin:full，D2/D3 序）。
 * 2. 已创建态（sessionId!=null + launchPresetId 有值）：Lock 图标 + 预设名 + HoverCard tooltip
 *    「此 Session 使用 {预设名} 模式创建，不可更改」。不展开 Popover。
 * 3. 历史 session（sessionId!=null + launchPresetId undefined）：Lock 图标 + 「全工具模式」+
 *    HoverCard tooltip 加注「（历史 session，未记录预设）」。
 *
 * 互斥（preset 互斥 wave）：Popover 展开态不再用本地 open ref，改由父组件经 v-model:presetOpen
 * 透传的 prop 驱动。Landing.vue 的 isPresetOpen computed 接 flow.state==='preset-popover'，
 * 与 dir/branch popover 共享 NewTaskFlowState 单实例状态机，三 popover 互斥（开 preset 自动
 * 关 dir/branch，反之亦然）。组件本身不读 flow——只声明 presetOpen prop + emit update:presetOpen。
 *
 * 数据流（D3 单一解析层，废 B6「回显≠透传」echo 机制）：onMounted 调 deps.loadPresets()
 * 拉预设列表 + 默认预设写 deps 侧 store（presets/defaultPresetId/loadError）；chip 回显 =
 * core launch-config 的 createLaunchConfigView 输出（输入 = explicitPresetId（用户点击的
 * 显式选择档）+ deps.presets/deps.defaultPresetId，数据延迟到达响应式重算——P5①）。
 * **chip 显示的预设就是将生效的预设**：显式选择走 explicit 档（emit select → 父组件
 * Landing.vue 调 flow.setPendingPreset → submit 侧同函数透传），未显式选择走默认预设解析
 * 档（D3 默认预设生效化）——显示与 submit 消费同一 resolve 函数，「显示 ≡ 生效」由构造成立。
 *
 * emit select 的契约：仅在用户真实点击预设项时 emit（onSelectPreset）。显式选择的单向链
 * 是「点击 → 本地 explicitPresetId（resolve 输入）+ emit → Landing → flow.setPendingPreset」；
 * 回显真源是 resolve 输出（displayPresetId），本地 ref 只是 explicit 档输入、非显示真源。
 *
 * 加载错误态（S-RN-2）：loadPresets rejected 时 deps 侧 store.loadError 写入错误消息，本组件区分
 * 「未加载（presets=[] + loadError=null）」与「加载失败（presets=[] + loadError 有值）」，
 * 不再因 RPC 永久 reject 卡「加载中…」。
 *
 * 范式参考：DirSelectPopover/BranchSelectPopover（Popover + PopoverListItem 项，selected 单选语义）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Lock, SlidersHorizontal } from '@lucide/vue'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：new-task 组件经顶层 barrel
// 再导出，顶层 barrel 自引用会闭合循环依赖环（R2 S-1）
import { Button } from '../../primitives/button'
import { Checkbox } from '../../primitives/checkbox'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card'
import { Popover, PopoverContent, PopoverTrigger, PopoverListItem } from '../../primitives/popover'
import { useNewTaskDeps } from './new-task-deps'
import { createLaunchConfigView } from '@taiji/core'
import { BUILTIN_PRESET_IDS, type PiLaunchPreset } from '@taiji/shared'

const props = defineProps<{
  /** 绑定的 session id（landing 态为 null） */
  sessionId: string | null
  /** session 创建时锁定的预设 id（SessionSummary.launchPresetId）。undefined=历史 session */
  launchPresetId?: string
  /**
   * Popover 展开态（仅 landing 态用）。由父组件经 v-model:presetOpen 透传，派生自
   * NewTaskFlowState==='preset-popover'，与 dir/branch popover 共享 flow 单实例状态机互斥。
   * 组件只声明 + emit update，不读 flow（flow 耦合在 Landing.vue）。
   */
  presetOpen: boolean
  /** 显式三档退化密度（§7.4：模式名 → 短名 → 仅图标）；不传 = 实测自适应（无 RO 环境如 jsdom 回落 full） */
  density?: 'full' | 'short' | 'icon'
  /** 模式全名文案（renderer 侧提供，ui 不耦合 i18n）；缺省回落 deps.presets 解析名（既有接入零改动） */
  modeName?: string
  /** 短名档文案（renderer 侧提供）；缺省 = 全名去「模式」尾缀（无尾缀保持全名，由 truncate 收窄） */
  shortName?: string
  /** 信任标记判据（renderer 侧按 `replace.enabled && 文案非空` 计算）；缺省 false = 不渲染标记 */
  hasReplacePrompt?: boolean
  /** 信任标记文案（renderer 侧 i18n）：文本/短名档 = 内嵌后缀；纯图标档 = 角标 tooltip；空文案不渲染 */
  replaceHint?: string
  /**
   * 强调底档（设计 §5.1：「颜色即状态」）：真值 = 当前生效模式为**非默认模式**（默认档中性底，
   * 与 landing 首行邻位 chip 同弱反馈；非默认档保留 accent 底）。
   * 判据由 renderer 侧计算传入（`displayPreset.id !== (defaultPresetId || builtin:full)`，
   * 注意 `||` 而非 `??`——store 未加载时 defaultPresetId 为 `''`，`'' ?? x` 仍是 `''` 会误判非默认）；
   * 缺省 false = 中性底（恒亮 accent 不携带信息，且与对话态 PresetChip 只在非默认模式渲染的语义冲突）。
   */
  accent?: boolean
}>()

const emit = defineEmits<{
  /** landing 态用户真实点击选定预设变化（session.create 透传用，单参数对象） */
  select: [{ presetId: string }]
  /** v-model:presetOpen 同步（Popover 内部 open 变化回传父组件） */
  'update:presetOpen': [boolean]
}>()

const { t } = useI18n()
const { presets, defaultPresetId, presetOpenRequest, loadPresets, setDefaultPreset, flow } = useNewTaskDeps()

/**
 * 显式选择档（resolve 输入，非回显真源）：用户真实点击 popover 项时记录（onSelectPreset），
 * 同步 emit select → 父组件写 flow.pendingPreset（单向链，写点唯一）。外部重置（startFlow
 * 重入把 pendingPreset 归 null）经下方 watch 同步回本 ref——Landing 在 flow 活跃期间保持
 * 挂载（isActive 守卫），组件实例不重建，生命周期与 pendingPreset 不同构，须显式跟随。
 */
const explicitPresetId = ref<string | null>(null)

/**
 * 重入同步（G1 破口修复）：flow.pendingPreset 是 submit 透传真值（显式档单一真源），
 * startFlow 每次进入 landing 都无条件重置它（多次 ⌘N / initApp 重试 / cancelled 复活），
 * 而 Landing 不重挂载 → 本地 explicitPresetId 若不跟随会残留旧选择：chip 显示旧预设、
 * submit 按默认预设创建（显示与生效发散）。watch 单向跟随：重置 → explicit 档清空，
 * resolve 回落默认链；用户显式点击仍经 onSelectPreset 写入 + emit（链路不变）。
 *
 * immediate:true（挂载时序变体闭合）：chip 实例可能在 flow.pendingPreset 已非 null 时
 * 新挂载（如 landing 已有显式选择后新增分屏 pane）——新实例 explicitPresetId 初值 null，
 * 无 immediate 则 chip 显示默认链而 submit 消费显式档（显示 ≠ 生效的挂载变体）。
 * 挂载即跟随当前真值，与重入同步共用同一条单向链。
 */
watch(
  // ?. 防御：部分测试 mock 的 deps.flow 是简化形态（无 pendingPreset 字段，同
  // composer-shell pendingPreset 通道先例）——缺失时观察源恒 null，不阻断组件解析。
  () => flow.pendingPreset?.value ?? null,
  (v) => {
    explicitPresetId.value = v ?? null
  },
  { immediate: true },
)

/**
 * 单一解析层视图（D3）：chip 回显 = resolveLaunchConfig 对 preset 字段的解析输出
 * （explicit > 全局默认 > builtin:full，D2 序与 submit 侧同一函数）。输入经 getter 闭包读
 * deps 响应式数据源，loadPresets 数据延迟到达时自动重算（P5①），无需手动回显。
 */
const resolvedPreset = createLaunchConfigView(() => ({
  pendingPreset: explicitPresetId.value,
  presets: presets.value,
  defaultPresetId: defaultPresetId.value,
}))

/**
 * chip 显示的 preset id。resolve 输出 presetId=undefined 有两义，均映射到显示语义：
 * - 出厂等价 builtin:full（D3 不透传，但生效面 = 全工具 = builtin:full）→ 显示 full 本体
 * - presets 未加载/加载失败（列表空，解析不到任何档）→ ''（selectedPresetName 走
 *   loadingPresets / 错误态文案，与现状区分逻辑一致）
 */
const displayPresetId = computed(() => {
  const pid = resolvedPreset.value.presetId
  if (pid) return pid
  return presets.value.some((p) => p.id === BUILTIN_PRESET_IDS.FULL)
    ? BUILTIN_PRESET_IDS.FULL
    : ''
})

// ── 三态派生 ──
/** landing 态：sessionId 为空（无绑定 session，可创建/选预设） */
const isLanding = computed(() => props.sessionId == null)
/** 历史 session 态：sessionId 非空 + launchPresetId 缺失（设计上线前创建的 session） */
const isLegacy = computed(() => props.sessionId != null && props.launchPresetId == null)
// 注：已创建锁定态（sessionId!=null + launchPresetId 有值）是 isLegacy 的补集，
// 模板用 v-else 覆盖（isLanding=false 且 isLegacy=false 即锁定态），无需独立 isLocked computed。

/** 锁定态/历史态显示的预设名 */
const lockedPresetName = computed(() => {
  if (isLegacy.value) return t('newTask.presetSelect.legacyPresetName')
  const id = props.launchPresetId
  // presets 未加载 / 找不到时用 id 兜底（不崩）
  return presets.value.find((p) => p.id === id)?.name ?? id ?? ''
})

/**
 * landing 态触发按钮显示的预设名。
 * - 未加载（displayPresetId 空 + 无 loadError）→ loadingPresets「加载中…」
 * - 加载失败（displayPresetId 空 + loadError 有值）→ 仍显 loadingPresets（i18n key 不可改，
 *   popover 内空态行区分错误），避免 trigger 文案与 i18n SSOT 脱节。
 * - 有解析结果 → 查名兜底 id。
 */
const selectedPresetName = computed(() => {
  const id = displayPresetId.value
  if (!id) return t('newTask.presetSelect.loadingPresets')
  return presets.value.find((p) => p.id === id)?.name ?? id
})

// ── u4a 三档退化 + 信任标记（设计 §7.4 landing 首行 / §7.1 信任处置）──
/**
 * 全名文案（文本档 chip 文本 + 窄档 a11y 名 / title）。props 优先（renderer 侧文案，
 * 保持 ui 包与 i18n 解耦）；缺省回落 deps.presets 解析出的模式名（既有接入零改动）。
 */
const displayName = computed(() => props.modeName ?? selectedPresetName.value)
/** 短名收窄下限（字符数）：去尾缀后过短（如仅剩个别字）则保留全名，避免短名无信息 */
const MIN_SHORT_NAME_LENGTH = 2
/** 短名档文案（中档显示）：props 优先；缺省 = 全名去「模式」尾缀（无尾缀保持全名，由 truncate 收窄） */
const shortName = computed(() => {
  if (props.shortName) return props.shortName
  const name = displayName.value
  const stripped = name.replace(/模式$/, '')
  return stripped.length >= MIN_SHORT_NAME_LENGTH ? stripped : name
})
/**
 * 信任标记判据（设计 §7.1）：`replace.enabled && 文案非空` 由 renderer 侧计算经
 * `hasReplacePrompt` 传入；「文案非空」同样是判据的一部分（空文案不渲染空后缀/空 tooltip）。
 * 跨档不丢：文本/短名档 = chip 内小后缀；纯图标档 = 右上角警示色角标（见模板）。
 */
const hasReplace = computed(
  () => props.hasReplacePrompt === true && (props.replaceHint ?? '').trim().length > 0,
)
/** 内部实测自适应档（无显式 density 时生效）；无 RO 环境（jsdom）恒 full */
const autoDensity = ref<'full' | 'short' | 'icon'>('full')
/** 生效密度档（显式 prop 优先，否则实测自适应） */
const chipDensity = computed<'full' | 'short' | 'icon'>(() => props.density ?? autoDensity.value)
/** chip 显示名（短名档用短名，其余用全名） */
const chipLabel = computed(() => (chipDensity.value === 'short' ? shortName.value : displayName.value))
/** 三档统一的 a11y 名（纯图标档的可见信息全在此；含信任标记文案） */
const ariaLabel = computed(() =>
  hasReplace.value ? `${displayName.value} · ${props.replaceHint ?? ''}` : displayName.value,
)
/** 自适应阈值（px）：≤ ICON 仅图标；≤ SHORT 短名；否则全名。实测驱动，阈值仅作档位边界 */
const ICON_TIER_MAX_WIDTH = 52
const SHORT_TIER_MAX_WIDTH = 116
/** 模板 ref 取其宿主 DOM（Button 根是 reka Primitive 渲染的 <button>） */
interface ElementHost { $el?: HTMLElement }
const chipRootRef = ref<ElementHost | null>(null)
let chipResizeObserver: ResizeObserver | null = null
/** 按实测宽度落档（三档退化自适应） */
function applyMeasuredWidth(width: number): void {
  if (width <= ICON_TIER_MAX_WIDTH) autoDensity.value = 'icon'
  else if (width <= SHORT_TIER_MAX_WIDTH) autoDensity.value = 'short'
  else autoDensity.value = 'full'
}

/**
 * popover 列表区空态文案（S-RN-2）：
 * - loadError 有值 → 复用 noPresets（i18n key 不可改；错误详情已在壳层 loadPresets console.warn）
 * - 无错误 + 列表空 → noPresets「暂无预设」
 * 二者用同一 key 因 i18n 文件不在本任务可改范围；区分点在 loadError 本身（可观测 + 可重试扩展）。
 */
const emptyHint = computed(() => t('newTask.presetSelect.noPresets'))

/** 锁定态 tooltip 文案（已创建态 + 历史态分别拼接） */
const lockedTooltip = computed(() => {
  const base = t('newTask.presetSelect.presetLockedTooltip', { name: lockedPresetName.value })
  if (isLegacy.value) {
    return `${base}${t('newTask.presetSelect.legacySessionTooltip')}`
  }
  return base
})

/** 「设为默认」Checkbox 勾选态（当前显示/将生效 = 全局默认；未解析出显示值时恒不勾） */
const isDefaultChecked = computed(() => {
  if (!displayPresetId.value || !defaultPresetId.value) return false
  return displayPresetId.value === defaultPresetId.value
})

// onMounted 拉预设数据（landing 态）。回显无需手动写入——displayPresetId 是 resolve 响应式
// 视图，loadPresets 写 deps 侧 store（presets/defaultPresetId）后自动重算（P5①）。
// emit select 仍只在用户真实点击时发出（onSelectPreset），显式选择链路不变。
onMounted(async () => {
  // u4 三档退化自适应（显式 density / 无 RO 环境跳过）：观察 chip 自身宽度落档
  if (props.density === undefined && typeof ResizeObserver !== 'undefined') {
    const el = chipRootRef.value?.$el
    if (el) {
      chipResizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width
        if (typeof width === 'number') applyMeasuredWidth(width)
      })
      chipResizeObserver.observe(el)
    }
  }
  if (!isLanding.value) return // 锁定/历史态无需拉数据（只读展示，预设名从 launchPresetId 查）
  await loadPresets()
})

onBeforeUnmount(() => {
  chipResizeObserver?.disconnect()
  chipResizeObserver = null
})

// FR-16：键盘快捷键 Cmd+Shift+P → 打开 PresetSelectChip Popover
// presetOpenRequest 由壳层快捷键 action（app-commands requestPresetOpen）递增，watch 到变化后打开。
// preset 互斥 wave：展开态交父组件 flow 单实例状态机，这里 emit update:presetOpen=true，
// Landing.vue 的 isPresetOpen setter 调 flow.openPresetPopover（自动关 dir/branch popover）。
watch(() => presetOpenRequest.value, async () => {
  if (!isLanding.value) return
  await nextTick()
  emit('update:presetOpen', true)
})

/**
 * landing 态用户真实点击选预设（PopoverListItem selected 单选语义：点一项即选中）。
 * 写 explicitPresetId（resolve 输入）+ emit select → 父组件写 flow.setPendingPreset——
 * 显示（resolve explicit 档）与透传（submit 侧 resolve 读 pendingPreset）同源同步。
 */
function onSelectPreset(preset: PiLaunchPreset): void {
  explicitPresetId.value = preset.id
  emit('select', { presetId: preset.id })
}

/**
 * 勾选/取消「设为默认」。
 * 勾选：调 setDefaultPreset(displayPresetId) 把当前显示/将生效的预设写为全局默认。
 * 取消：no-op（全局默认至少有一个值，不支持取消到空——用户可选其他预设设默认替代）。
 */
async function onToggleDefault(checked: boolean | string): Promise<void> {
  if (checked && displayPresetId.value) {
    await setDefaultPreset(displayPresetId.value)
  }
}
</script>

<template>
  <!-- landing 态：Popover 可选预设（preset 互斥 wave：open 态由父 v-model:presetOpen 驱动，不再本地 open ref） -->
  <Popover v-if="isLanding" :open="presetOpen" @update:open="$emit('update:presetOpen', $event)">
    <PopoverTrigger as-child>
      <Button
        ref="chipRootRef"
        data-testid="chip-preset"
        variant="ghost"
        class="relative h-auto min-w-0 shrink gap-1.5 rounded-md px-2 py-1 text-[12px] font-normal [&_svg]:size-3.5"
        :class="
          accent
            ? 'bg-accent-soft text-accent hover:bg-accent-soft'
            : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'
        "
        :aria-label="ariaLabel"
        :title="chipDensity === 'icon' ? displayName : undefined"
      >
        <SlidersHorizontal class="shrink-0" />
        <span
          v-if="chipDensity !== 'icon'"
          class="min-w-0 truncate font-mono"
          :class="chipDensity === 'short' && 'max-w-[48px]'"
        >{{ chipLabel }}</span>
        <!-- 信任标记（文本/短名档）：chip 内小后缀 -->
        <span
          v-if="hasReplace && chipDensity !== 'icon'"
          class="shrink-0 text-[10px] text-warn"
        >{{ replaceHint }}</span>
        <!-- 信任标记（纯图标档）：右上角警示色角标 + tooltip（accent 底不参与）；刻意不用 accent 描边 -->
        <span
          v-if="hasReplace && chipDensity === 'icon'"
          data-testid="preset-chip-replace-badge"
          class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-warn ring-1 ring-bg-input"
          :title="replaceHint"
          aria-hidden="true"
        />
        <ChevronDown
          v-if="chipDensity !== 'icon'"
          class="ml-px shrink-0 transition-transform duration-200"
          :class="presetOpen && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" :collision-padding="8" :side-offset="8" class="w-[280px] p-0">
      <!-- head：透明背景 + border-b 分割，与 DirSelectPopover 搜索框区 / BranchSelectPopover 标题栏
           的头部样式对齐（三者头部都无背景色，靠 border-b 分割，露出 PopoverContent 的 bg-elevated）。
           历史背景：曾用 bg-surface-2 给头部加深色块，视觉上像粗边框/双层条带，与 dir/branch 头部
           透明背景不一致，故去掉对齐。 -->
      <div
        class="flex items-center justify-between border-b border-border px-3 py-2 font-mono text-[10px] text-neutral-dim"
      >
        <span>{{ t('newTask.presetSelect.title') }}</span>
      </div>
      <!-- 预设列表（PopoverListItem：与 DirSelect/BranchSelect 列表项统一选择态视觉范式——
           selected 走 surface-2 + accent inset ring + 尾部 Check，不再用 RadioGroup 自绘圆点。
           取舍：一致性优先于 RadioGroup 的标准 ↑↓ 键盘导航；单选语义靠 selected + click 实现） -->
      <div v-if="presets.length === 0" class="px-2.5 py-3 text-[12px] text-neutral-dim">
        {{ emptyHint }}
      </div>
      <PopoverListItem
        v-for="preset in presets"
        v-else
        :key="preset.id"
        :test-id="`preset-option-${preset.id}`"
        :selected="displayPresetId === preset.id"
        @click="onSelectPreset(preset)"
      >
        <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span class="truncate text-neutral-fg">{{ preset.name }}</span>
          <span v-if="preset.description" class="truncate text-[11px] text-neutral-dim">
            {{ preset.description }}
          </span>
        </span>
      </PopoverListItem>
      <!-- 设为默认（分隔线 + Checkbox）。已是默认时 disabled：全局默认至少一个，不能取消到空，只能选其他预设替代 -->
      <div class="flex items-center gap-2 border-t border-border px-2.5 py-2">
        <Checkbox
          :model-value="isDefaultChecked"
          :disabled="isDefaultChecked"
          data-testid="checkbox-set-default"
          @update:model-value="onToggleDefault"
        />
        <span class="text-[12px] text-neutral-mid">{{ t('newTask.presetSelect.setAsDefault') }}</span>
        <span v-if="isDefaultChecked" class="text-[10px] text-neutral-dim">· {{ t('newTask.presetSelect.alreadyDefault') }}</span>
      </div>
    </PopoverContent>
  </Popover>

  <!-- 锁定态 / 历史 session 态：Lock 图标 + 预设名 + HoverCard tooltip -->
  <HoverCard v-else :open-delay="200">
    <HoverCardTrigger as-child>
      <Button
        data-testid="chip-preset-locked"
        variant="ghost"
        class="h-auto cursor-default gap-1.5 px-2 py-1 text-[12px] text-neutral-dim hover:bg-transparent hover:text-neutral-dim [&_svg]:size-3.5"
      >
        <Lock class="shrink-0" />
        <span class="font-mono">{{ lockedPresetName }}</span>
      </Button>
    </HoverCardTrigger>
    <HoverCardContent side="top" class="max-w-[280px] px-2.5 py-1.5 text-[11px] text-neutral-mid">
      {{ lockedTooltip }}
    </HoverCardContent>
  </HoverCard>
</template>
