<script setup lang="ts">
/**
 * ModeDeclarationRow —— 消息流顶部的「模式声明行」（u5 mode-declaration-row）。
 *
 * 设计依据：`.tmp/tech-design/mode-system-composer-density.md` §6.5 D5 选型①（派生行）+ §7.4「声明行」行
 * + §7.5 错误规格 E7（三态降级）。
 *
 * 机制选型（D5 表候选①，零新机制）：
 * - 数据源 = `SessionSummary.launchPresetId` + preset store **派生**；
 * - **不写 transcript、不进 LLM 上下文、不新增 entry 类型**（0 token）；
 * - 锚在 MessageStream 的滚动容器**之外**（流顶），不随滚动消失。
 *
 * 可见性判据（D5 可执行判据，与 PresetChip 同源）：
 * `launchPresetId !== (defaultPresetId || 'builtin:full')`——只对非默认模式渲染（实现用 `||` 而非 `??`：
 * store 未加载时 defaultPresetId 是空串，`'' ?? x` 仍是 `''`，会让任意 id 都被判成「非默认」而误显示）；
 * **不得**套用 landing 的 resolve 链（会话创建后 launchPresetId 恒有值，照字面代入首项恒假）。
 *
 * E7 三态（§7.5）：
 * ① 未加载（store 空且无错误）→ **不渲染**（不能当「已删除」）；
 * ② 已加载但缺 id → 「模式已删除（<presetId>）」+「新建会话 ⌘N」出口；
 *    F1 回落披露（设计 §7.5 E4）：删除态下**两态区分**——未回落（会话尚未重启）仍报
 *    「模式已删除（id）」并**预告**「会话重启后将回落全工具」；已回落
 *    （`SessionSummary.launchPresetFallbackTo` 非空，pi 本次已以 builtin:full 启动）才声称
 *    「本次以全工具模式启动」。禁在未重启窗口内声称已用全工具（假陈述）。
 * ③ 加载失败（loadError 非空）→ **等同未加载：不渲染**（恢复通道 = 下一次 connected 自动补拉，
 *    见 usePiPresets.installPresetAutoLoad）。
 * 三态均不阻断会话。
 *
 * 形态：SystemNotice 同款分隔行（两端渐隐横线 + 13px/stroke2.2 图标 + 主文案 + 描边 chip）。
 * 出口形态与 PresetChip popover 一致：只做快捷键可达性披露（静态通知族），不新增点击机制。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SlidersHorizontal, TriangleAlert } from '@lucide/vue'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import { BUILTIN_PRESET_IDS, type PiLaunchPreset } from '@taiji/shared'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const { formatKbd } = usePlatformShortcut()
const sessionStore = useSessionStore()
const presetStore = usePresetStore()

/** 会话创建时锁定的模式 id（live 内存态 / reload sidecar 两条路径齐备）。 */
const launchPresetId = computed<string | undefined>(
  () => sessionStore.list.find((s) => s.id === props.sessionId)?.launchPresetId,
)
/**
 * F1 回落目标（`SessionSummary.launchPresetFallbackTo`）：非空 = 本进程本次 restore 已回落
 * 该 id（恒 builtin:full）启动。undefined = 未回落（模式仍可得 / 会话尚未重启）。
 */
const launchPresetFallbackTo = computed<string | undefined>(
  () => sessionStore.list.find((s) => s.id === props.sessionId)?.launchPresetFallbackTo,
)

/** 默认模式 id（D5 口径；未加载 → 回落 builtin:full，与 PresetChip.defaultModeId 同源）。 */
const defaultModeId = computed(() => presetStore.defaultPresetId || BUILTIN_PRESET_IDS.FULL)

/** 是否非默认模式（D5 可执行判据；`!!` 同时排除无 launchPresetId 的历史会话）。 */
const isNonDefault = computed(
  () => !!launchPresetId.value && launchPresetId.value !== defaultModeId.value,
)

/** E7 ①③：presets 是否处于「已加载」态（加载失败 loadError 非空 → 等同未加载，不算已加载）。 */
const presetsLoaded = computed(
  () => presetStore.loadError === null && presetStore.presets.length > 0,
)

/** 模式定义；已加载但缺 id → null（此时降级为 E7 ②「已删除」）。 */
const preset = computed<PiLaunchPreset | null>(() => {
  const id = launchPresetId.value
  if (!id) return null
  return presetStore.presets.find((p) => p.id === id) ?? null
})

/** 整行可见性（非默认模式 + 已加载；E7 ①③ 不渲染）。 */
const isVisible = computed(() => isNonDefault.value && presetsLoaded.value)

/** E7 ②：已加载但缺该 id → 降级为「模式已删除」+ 新建会话出口。 */
const isDeleted = computed(() => isVisible.value && preset.value === null)
/** F1 已回落（pi 本次确以 builtin:full 启动）——仅删除态下可成立。 */
const isFellBack = computed(() => isDeleted.value && launchPresetFallbackTo.value !== undefined)
/** 回落披露文案：未回落只预告后果；已回落才声称本次（E4 判定前提）。 */
const fallbackDisclosure = computed(() =>
  isFellBack.value
    ? t('panel.modeDeclaration.deletedFellBack')
    : t('panel.modeDeclaration.deletedFallbackPending'),
)

/** 主文案：模式名（E7 ② 为「模式已删除（id）」）。 */
const label = computed(() =>
  preset.value
    ? t('panel.modeDeclaration.label', { name: preset.value.name })
    : t('panel.modeDeclaration.deleted', { id: launchPresetId.value ?? '' }),
)

/** 工具面摘要（与 PresetChip 同口径；面摘要串 SSOT = panel.presetChip.*）。 */
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

/** 启用的提示词段数（替换 + 追加；与 PresetChip 同口径）。 */
const promptSegmentCount = computed(() => {
  const p = preset.value?.prompt
  if (!p) return 0
  return [p.replace, p.append].filter((s) => s?.enabled && (s.prompt ?? '').trim().length > 0).length
})

/** 两个描边 chip 的文案（工具面摘要 + 提示词段数）。 */
const toolChip = computed(() => t('panel.modeDeclaration.toolChip', { surface: toolSurface.value }))
const promptChip = computed(() =>
  t('panel.modeDeclaration.promptChip', { count: promptSegmentCount.value }),
)

/** 新建会话快捷键显示（跨平台；mac ⌘N / win Ctrl+N）。 */
const newSessionKbd = computed(() => formatKbd('n'))
</script>

<template>
  <!-- 可见性闸：非默认模式 + presets 已加载（E7 ①③ 不渲染，避免误报「已删除」） -->
  <div
    v-if="isVisible"
    class="mode-declaration-row content-col flex min-w-0 animate-notice-in items-center gap-2 py-1.5"
    data-testid="mode-declaration-row"
  >
    <!-- 两端渐隐横线（SystemNotice 同规格） -->
    <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
    <!-- 图标 13px + stroke 2.2（D3 规格）：正常 accent / 已删除 warn -->
    <TriangleAlert
      v-if="isDeleted"
      class="size-[13px] shrink-0 text-warn"
      stroke-width="2.2"
    />
    <SlidersHorizontal
      v-else
      class="size-[13px] shrink-0 text-accent"
      stroke-width="2.2"
    />
    <span class="flex min-w-0 items-center gap-1">
      <span
        class="min-w-0 truncate text-[length:var(--text-sm)] font-[550]"
        :class="isDeleted ? 'text-neutral-mid' : 'text-neutral-fg'"
        data-testid="mode-declaration-label"
      >{{ label }}</span>
      <!-- F1 回落披露（设计 §7.5 E4）：未回落预告 / 已回落声称本次——两态文案不同，禁混用 -->
      <span
        v-if="isDeleted"
        data-testid="mode-declaration-fallback"
        class="shrink-0 text-[length:var(--text-2xs)]"
        :class="isFellBack ? 'text-warn' : 'text-neutral-dim'"
      >{{ fallbackDisclosure }}</span>
      <!-- 正常态：工具面摘要 + 提示词段数（两个描边 chip） -->
      <template v-if="!isDeleted">
        <span
          class="shrink-0 rounded-[4px] border border-border-strong px-1.5 font-mono text-[length:var(--text-3xs)] font-medium leading-[1.8] text-neutral-mid"
          data-testid="mode-declaration-tool"
        >{{ toolChip }}</span>
        <span
          class="shrink-0 rounded-[4px] border border-border-strong px-1.5 font-mono text-[length:var(--text-3xs)] font-medium leading-[1.8] text-neutral-mid"
          data-testid="mode-declaration-prompt"
        >{{ promptChip }}</span>
      </template>
      <!-- E7 ② 出口：新建会话 ⌘N（只做快捷键披露，不新增点击机制） -->
      <span
        v-if="isDeleted"
        class="shrink-0 text-[length:var(--text-2xs)] text-neutral-dim"
        data-testid="mode-declaration-new-session"
      >
        {{ t('panel.modeDeclaration.newSession') }}
        <span class="ml-1 font-mono text-neutral-mid">{{ newSessionKbd }}</span>
      </span>
    </span>
    <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
  </div>
</template>
