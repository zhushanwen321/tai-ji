<script lang="ts">
/**
 * ResizeObserver 缺失时的一次性告警闸（模块作用域：分屏多实例 / 重复挂载只告警一次）。
 * 放普通 `<script>` 块而非 `<script setup>`：后者的顶层声明随 setup 每次挂载重建，
 * 无法跨实例去重。
 */
let warnedNoResizeObserver = false
</script>

<script setup lang="ts">
/**
 * PresetChip —— 「模式」（PiLaunchPreset）chip（u4 mode-visibility-chip）。
 *
 * 设计依据：`.tmp/tech-design/mode-system-composer-density.md` §6.5 D5（可见性）+ §7.4（renderer 界面表）
 * + §7.1（信任处置：含替换提示词的标记跨档不丢）+ §7.5 E7（数据源三态降级）。
 *
 * 语义（只读形态 —— 对话态 composer `#meta-row`）：`[模式图标] 模式名 + 锁（lucide Lock）`；
 *   **只对非默认模式渲染**——可执行判据 = `launchPresetId !== (defaultPresetId || 'builtin:full')`。
 *   用 `||` 回落：store 未加载时 `defaultPresetId` 是空串（`'' ?? x` 仍为 `''`），`||` 才能落
 *   `builtin:full`——避免把默认模式会话误判为非默认而错误显示。
 *   E7 三态（§7.5）：未加载（store 空且无错误）/ 加载失败 → **不渲染**（不报「已删除」）；
 *   已加载但缺 id → 「模式已删除（<presetId>）」。
 *   F1 回落披露（§7.5 E4，`fallbackTo` prop 由 useComposerModeChip 从 SessionSummary 透传）：
 *   删除态下**两态文案严格区分**——未回落（会话尚未重启）只预告「重启后将回落全工具」；
 *   已回落（`fallbackTo` 非空，pi 本次已以 builtin:full 启动）才声称「本次以全工具模式启动」。
 *   禁在未重启窗口内声称已用全工具（假陈述）。披露同时进 aria-label / icon 档 title / popover（不丢）。
 *   landing 态的预选 chip 走 ui 包 `PresetSelectChip`（ui 不得反向 import renderer），非本组件职责。
 * - 三档退化（模式名 → 短名 → 仅图标，§7.4）：`density` prop 显式指定（测试/父级驱动），
 *   不传则内部 ResizeObserver 按自身实测宽度自适应（无 RO 环境如 jsdom 回落 full 并一次性告警）。
 * - 信任标记跨档不丢（§7.1）：文本/短名档 = chip 内小后缀（warn 色）；纯图标档 = 右上角警示色
 *   角标（`data-testid="preset-chip-replace-badge"`）+ tooltip。**刻意不用 accent**（accent 底已表示
 *   「非默认模式」，两个语义不共色）。
 * - hover popover（只读）：模式描述 / 工具面 / 扩展面 / 提示词段数 / 锁定说明 + 「新建会话…」出口。
 * - chip **不承载子会话计数**（设计 D5/P0-22：计数归托盘第 4 件与侧栏）。
 *
 * 约束：禁 Emoji（图标全走 @lucide/vue）；禁原生表单元素（Button/HoverCard 原语）；颜色用 token；
 * 圆角走 Button 默认档（tokens）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock, SlidersHorizontal, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import { usePresetStore } from '@/stores/preset'
import { BUILTIN_PRESET_IDS, type PiLaunchPreset } from '@taiji/shared'

/** 三档退化密度（设计 §7.4：模式名 → 短名 → 仅图标） */
export type PresetChipDensity = 'full' | 'short' | 'icon'

const props = withDefaults(
  defineProps<{
    /** 模式（PiLaunchPreset）id；null → 不渲染 */
    presetId?: string | null
    /**
     * 回落目标 id（F1，设计 §7.5 E4）：该会话本次 restore 已回落本 id（恒 builtin:full）启动。
     * null/undefined = 无回落事实（模式仍可得，或会话尚未重启）→ 删除态只预告不声称。
     */
    fallbackTo?: string | null
    /** 显式密度档；不传 = 内部实测自适应（测试显式传，保证确定性） */
    density?: PresetChipDensity
  }>(),
  { presetId: null, fallbackTo: null, density: undefined },
)

const { t } = useI18n()
const { formatKbd } = usePlatformShortcut()
const presetStore = usePresetStore()

// ── 数据解析（preset store 是 renderer 侧模式定义 SSOT）──
/** 模式定义；store 未加载 / id 悬空 → null（名字走兜底，不误报「已删除」） */
const preset = computed<PiLaunchPreset | null>(() => {
  const id = props.presetId
  if (!id) return null
  return presetStore.presets.find((p) => p.id === id) ?? null
})
/** presets 是否已加载（E7 三态口径：加载失败 → 等同未加载；与 ModeDeclarationRow 同判据） */
const presetsLoaded = computed(
  () => presetStore.loadError === null && presetStore.presets.length > 0,
)
/**
 * 默认模式 id（D5「默认」口径 = defaultPresetId 解析结果）。
 * store 初值 ''（未加载）→ 回落 builtin:full：未加载期不得把任意模式都判成「非默认」而误显示。
 */
const defaultModeId = computed(() => presetStore.defaultPresetId || BUILTIN_PRESET_IDS.FULL)

/** 可见性（D5 可执行判据 + §7.5 E7 闸：非默认模式且 presets 已加载才渲染） */
const isVisible = computed(() => {
  if (!props.presetId) return false
  // E7 ①③：列表未加载 / 加载失败 → 不渲染（既不可误报「模式已删除」，也不闪裸 `custom:xxxx`）
  if (!presetsLoaded.value) return false
  return props.presetId !== defaultModeId.value
})

/** 模式全名（缺 id 时按 E7 区分未加载 / 已删除） */
const fullName = computed(() => {
  if (preset.value) return preset.value.name
  if (!props.presetId) return ''
  return presetsLoaded.value
    ? t('panel.presetChip.deleted', { id: props.presetId })
    : props.presetId
})
/** E7 ②：已加载但缺 id = 模式已删除（回落披露只在删除态下有义）。 */
const isDeleted = computed(() => !!props.presetId && presetsLoaded.value && preset.value === null)
/** F1：已回落（本进程本次 restore 已以 builtin:full 启动）——仅删除态下可成立。 */
const isFellBack = computed(() => isDeleted.value && props.fallbackTo != null)
/** 回落披露文案（未回落只预告；已回落才声称本次）——非删除态 null。 */
const fallbackDisclosure = computed<string | null>(() => {
  if (!isDeleted.value) return null
  return isFellBack.value
    ? t('panel.presetChip.deletedFellBack')
    : t('panel.presetChip.deletedFallbackPending')
})

/** 短名去尾缀后的最小保留长度（低于此值回退原标题，避免「模式」二字模式名被去空） */
const MIN_SHORT_NAME_LENGTH = 2

/** 短名（中文本土模式名去「模式」尾缀；无尾缀保持原名，由 truncate 收窄） */
const shortName = computed(() => {
  const name = preset.value?.name ?? fullName.value
  const stripped = name.replace(/模式$/, '')
  return stripped.length >= MIN_SHORT_NAME_LENGTH ? stripped : name
})

// ── 三档退化 ──
/** 内部实测自适应结果（无显式 density 时生效） */
const autoDensity = ref<PresetChipDensity>('full')
const density = computed<PresetChipDensity>(() => props.density ?? autoDensity.value)
/** 自适应阈值（px）：≤ ICON 仅图标；≤ SHORT 短名；否则全名。纯图标 chip 实宽约 28px + 余量 */
const ICON_TIER_MAX_WIDTH = 52
const SHORT_TIER_MAX_WIDTH = 116

/** 模板 ref 取其宿主 DOM（Button 根是 reka Primitive 渲染的 <button>） */
interface ElementHost { $el?: HTMLElement }
const rootRef = ref<ElementHost | null>(null)
let resizeObserver: ResizeObserver | null = null

/** 按实测宽度落档（内部自适应；实测驱动，非布局硬编码 —— 阈值仅作档位边界） */
function applyMeasuredWidth(width: number): void {
  if (width <= ICON_TIER_MAX_WIDTH) autoDensity.value = 'icon'
  else if (width <= SHORT_TIER_MAX_WIDTH) autoDensity.value = 'short'
  else autoDensity.value = 'full'
}

onMounted(() => {
  if (props.density !== undefined) return
  if (typeof ResizeObserver === 'undefined') {
    // 降级留痕（P0/P1 降级纪律）：无实测即停留全名档，一次性告警，不随实例数刷屏
    if (!warnedNoResizeObserver) {
      warnedNoResizeObserver = true
      console.warn('[preset-chip] ResizeObserver 不可用，模式 chip 停留在全名档（可能横向溢出）')
    }
    return
  }
  const el = rootRef.value?.$el
  if (!el) return
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (typeof width === 'number') applyMeasuredWidth(width)
  })
  resizeObserver.observe(el)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// ── 信任标记与模式面摘要 ──
/** 替换提示词段（信任标记判据 = enabled && 文案非空） */
const hasReplace = computed(() => {
  const seg = preset.value?.prompt?.replace
  return !!seg?.enabled && (seg.prompt ?? '').trim().length > 0
})
/** 启用的提示词段数（替换 + 追加；popover 展示用） */
const promptSegmentCount = computed(() => {
  const p = preset.value?.prompt
  if (!p) return 0
  return [p.replace, p.append].filter((s) => s?.enabled && (s.prompt ?? '').trim().length > 0).length
})
/** 工具面摘要（toolMode + 名单数） */
const toolSurface = computed(() => {
  const p = preset.value
  if (!p) return t('panel.presetChip.unknownSurface')
  if (p.toolMode === 'all') return t('panel.presetChip.toolAll')
  if (p.toolMode === 'none') return t('panel.presetChip.toolNone')
  if (p.toolMode === 'allowlist') {
    return t('panel.presetChip.allowCount', { count: p.allowedTools?.length ?? 0 })
  }
  return t('panel.presetChip.denyCount', { count: p.deniedTools?.length ?? 0 })
})
/** 扩展面摘要（extensionMode + 名单数） */
const extensionSurface = computed(() => {
  const p = preset.value
  if (!p) return t('panel.presetChip.unknownSurface')
  if (p.extensionMode === 'all') return t('panel.presetChip.extAll')
  if (p.extensionMode === 'none') return t('panel.presetChip.extNone')
  if (p.extensionMode === 'allowlist') {
    return t('panel.presetChip.allowCount', { count: p.allowedExtensions?.length ?? 0 })
  }
  return t('panel.presetChip.denyCount', { count: p.deniedExtensions?.length ?? 0 })
})

/** 密度档下的显示名（短名档用去尾缀短名） */
const displayName = computed(() => (density.value === 'short' ? shortName.value : fullName.value))
/** 三档统一的 a11y 名（纯图标档的可见信息全在此）；F1：回落披露一并入名（不丢）。 */
const ariaLabel = computed(() => {
  const base = t('panel.presetChip.ariaLabel', { name: fullName.value })
  const parts = [base]
  if (hasReplace.value) parts.push(t('panel.presetChip.replaceHint'))
  if (fallbackDisclosure.value) parts.push(fallbackDisclosure.value)
  return parts.join(' · ')
})
/** icon 档 title（可见信息唯一落点）；含回落披露。 */
const iconTitle = computed(() =>
  fallbackDisclosure.value ? `${fullName.value} · ${fallbackDisclosure.value}` : fullName.value,
)
/** 新建会话快捷键显示（跨平台；⌘N / Ctrl+N） */
const newSessionKbd = computed(() => formatKbd('n'))
/** chip 基础类（accent 底 = 非默认模式这一状态通道） */
const CHIP_CLASS =
  'relative h-auto min-w-0 shrink gap-1.5 rounded-md px-2 py-1 text-[12px] font-normal [&_svg]:size-3.5'
</script>

<template>
  <!-- 可见性闸（默认模式 / 未选中 / E7 未加载·加载失败 → 不渲染） -->
  <template v-if="isVisible">
    <!-- chip + hover popover（模式详情 + 锁定说明 + 新建会话出口） -->
    <HoverCard :open-delay="150">
      <HoverCardTrigger as-child>
        <Button
          ref="rootRef"
          data-testid="preset-chip"
          variant="ghost"
          :class="[CHIP_CLASS, 'bg-accent-soft text-accent hover:bg-accent-soft']"
          :aria-label="ariaLabel"
          :title="density === 'icon' ? iconTitle : undefined"
        >
          <SlidersHorizontal class="shrink-0" />
          <span
            v-if="density !== 'icon'"
            class="min-w-0 truncate font-mono"
            :class="density === 'short' && 'max-w-[48px]'"
          >{{ displayName }}</span>
          <!-- F1 回落披露（设计 §7.5 E4）：删除态两态区分——未回落预告 / 已回落声称本次。
               icon 档入 title/aria-label（不丢）；popover 另有一份完整文案。 -->
          <span
            v-if="fallbackDisclosure && density !== 'icon'"
            data-testid="preset-chip-fallback"
            class="shrink-0 text-[10px]"
            :class="isFellBack ? 'text-warn' : 'text-neutral-dim'"
          >{{ fallbackDisclosure }}</span>
          <!-- 信任标记（文本/短名档）：chip 内小后缀 -->
          <span
            v-if="hasReplace && density !== 'icon'"
            class="shrink-0 text-[10px] text-warn"
          >{{ t('panel.presetChip.replaceHint') }}</span>
          <!-- 信任标记（纯图标档）：右上角警示色角标（accent 底不参与）；tooltip 保留全名与标记 -->
          <span
            v-if="hasReplace && density === 'icon'"
            data-testid="preset-chip-replace-badge"
            class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-warn ring-1 ring-bg-input"
            :title="t('panel.presetChip.replaceHint')"
            aria-hidden="true"
          />
          <Lock class="shrink-0 text-neutral-dim" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" class="w-[300px] p-0">
        <div data-testid="preset-chip-popover" class="p-3">
          <div class="flex items-center gap-2">
            <SlidersHorizontal class="size-3.5 shrink-0 text-accent" />
            <span class="min-w-0 truncate text-[13px] font-medium text-neutral-fg">{{ fullName }}</span>
            <span
              v-if="preset?.builtin"
              class="shrink-0 rounded-sm border border-border px-1 text-[10px] text-neutral-dim"
            >{{ t('panel.presetChip.builtin') }}</span>
          </div>
          <p v-if="preset?.description" class="mt-1.5 text-[11px] text-neutral-mid">
            {{ preset.description }}
          </p>
          <dl class="mt-2 space-y-1 text-[11px]">
            <div class="flex items-center justify-between gap-2">
              <dt class="text-neutral-dim">{{ t('panel.presetChip.toolSurface') }}</dt>
              <dd class="font-mono text-neutral-mid">{{ toolSurface }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-neutral-dim">{{ t('panel.presetChip.extensionSurface') }}</dt>
              <dd class="font-mono text-neutral-mid">{{ extensionSurface }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-neutral-dim">{{ t('panel.presetChip.promptSegments') }}</dt>
              <dd class="font-mono text-neutral-mid">
                {{ t('panel.presetChip.promptCount', { count: promptSegmentCount }) }}
              </dd>
            </div>
          </dl>
          <!-- F1 回落披露（设计 §7.5 E4）：popover 完整文案（chip 截断时的可靠落点），两态区分 -->
          <p
            v-if="fallbackDisclosure"
            data-testid="preset-chip-fallback-popover"
            class="mt-2 flex items-start gap-1.5 text-[11px]"
            :class="isFellBack ? 'text-warn' : 'text-neutral-mid'"
          >
            <TriangleAlert class="mt-px size-3 shrink-0" />
            <span>{{ fallbackDisclosure }}</span>
          </p>
          <!-- 锁定说明：模式 id 在创建时确定、本会话内不可更换（模式定义可在设置页编辑，下次启动生效） -->
          <p class="mt-2 flex items-start gap-1.5 text-[11px] text-neutral-mid">
            <Lock class="mt-px size-3 shrink-0 text-neutral-dim" />
            <span>{{ t('panel.presetChip.lockNote') }}</span>
          </p>
          <!-- 出口提示（快捷键由全局 keymap 承载；本处只做可达性披露，不新增点击机制） -->
          <div class="mt-2 border-t border-border pt-2 text-[11px] text-neutral-dim">
            <span>{{ t('panel.presetChip.newSession') }}</span>
            <span class="ml-1 font-mono text-neutral-mid">{{ newSessionKbd }}</span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  </template>
</template>
