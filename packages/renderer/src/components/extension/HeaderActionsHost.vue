<!--
  HeaderActionsHost（plugin-header-action-modal-points AP-1 / u4b）——panel header 插件按钮区。

  消费 ContributionRegistry 的 headerAction 声明（经 bridge 的响应式声明镜像）+
  HeaderActionStore per-session 运行时镜像（badge/tooltip/disabled，#38）渲染按钮组。
  插入点：PanelHeader 既有按钮组内、ViewHost panel.header 之后 session-file 之前；
  与内置按钮同视觉规格（drawer/git 同款 size-[22px]，DESIGN.md §11 几何不动）。

  - badge ≤4 字符宿主截断，全文进 tooltip（AP-1 徽标契约）
  - E13 三态灰置：registered 可点 / unregistered 灰置+tooltip / unknown 保持上次值
    （首次缺省可点，E14 写路径兜底——失败不拦入口）
  - 运行时 disabled：插件 updateHeaderAction 推的 entry.disabled=true 直接灰置；
    缺 tooltip 时提示「暂不可用」不落声明 title（场景 12，插件侧业务态消费）
  - E3 点击 → CommandRegistry.execute：命令缺失（emit error，ERR6）后按钮本地置灰，
    禁静默 no-op；宿主重判 registered（命令重注册）后置灰让位、按钮恢复可点
  - 无声明时整组件零 DOM（不挤压右侧内置按钮，同 ViewHost empty="hidden" 语义）
-->
<template>
  <template v-if="buttons.length > 0">
    <Button
      v-for="b in buttons"
      :key="b.key"
      variant="ghost"
      size="icon"
      class="relative size-[22px] rounded-md text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-mid [-webkit-app-region:no-drag]"
      :data-testid="b.testid"
      :disabled="b.disabled"
      :title="b.tooltip"
      :aria-label="b.tooltip"
      @click="b.onClick()"
    >
      <component :is="b.icon" class="size-[15px]" />
      <span
        v-if="b.badge"
        class="absolute -right-1.5 -top-1.5 inline-flex h-3 min-w-3 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] font-semibold leading-none text-accent-fg ring-1 ring-bg"
      >{{ b.badge }}</span>
    </Button>
  </template>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { Clock, Puzzle } from '@lucide/vue'
import type { Component } from 'vue'
import { Button } from '@/components/ui/button'
import { useI18n } from 'vue-i18n'
import { HEADER_ACTIONS_SOURCE_KEY } from '@/composables/shell/useExtensionHostBridge'

const props = defineProps<{
  /** 所属 session（per-session 徽标分区路由键；空 = landing，不渲染） */
  sessionId?: string
}>()

const { t } = useI18n()
const source = inject(HEADER_ACTIONS_SOURCE_KEY, null)

/** badge 最大字符数（AP-1：徽标位是 22px 按钮的一个角，超长截断全文进 tooltip） */
const BADGE_MAX_CHARS = 4

/** lucide 名 → 组件映射（宿主解析，插件不给 SVG）。未登记名 fallback 到通用插件图标。 */
const HEADER_ACTION_ICONS: Record<string, Component> = {
  clock: Clock,
}

/** testid 形态 = header-action-<pluginId>-<actionId 的 id 段>（设计场景 1 契约：
 *  'scheduler-manager.open' → 'header-action-scheduler-manager-open'）。 */
function actionTestId(pluginId: string, actionId: string): string {
  const idSegment = actionId.includes('.') ? actionId.slice(actionId.lastIndexOf('.') + 1) : actionId
  return `header-action-${pluginId}-${idSegment}`
}

/** E13「保持上次值」簿记（key = sessionId::commandId）。非响应式：仅作渲染间记忆，
 *  unknown 态读它，registered/unregistered 判定写它——写入不触发重渲染（无循环）。 */
const lastResolved = new Map<string, 'registered' | 'unregistered'>()

/** 命令点击失败（E3 命令缺失）后的本地置灰集合（key 同上）。恢复途径 = 宿主可用性
 *  重判为 registered（命令重注册回来，如 connected 重放同步）→ disabled 计算让位、
 *  按钮恢复可点；切会话由下方 watch 清理（置灰期间按钮不可点，无「点击自愈」路径）。 */
const commandMissing = ref(new Set<string>())

const buttons = computed(() => {
  if (!source || !props.sessionId) return []
  const sid = props.sessionId
  const declarations = [...source.getDeclarations()]
    // order 升序；缺省排在内置按钮组声明之后（order ?? Infinity，追加在后语义）
    .sort((a, b) => (a.headerAction?.order ?? Number.POSITIVE_INFINITY) - (b.headerAction?.order ?? Number.POSITIVE_INFINITY))

  return declarations.map((decl) => {
    const ha = decl.headerAction
    if (!ha) return null
    const entry = source.getRuntimeState(sid, decl.contributionId)
    const availability = source.resolveCommandAvailability(sid, ha.commandId)
    if (availability !== 'unknown') lastResolved.set(`${sid}::${ha.commandId}`, availability)
    // E13 三态：unknown 保持上次值；首次（无上次值）缺省可点（E14 兜底不拦入口）
    const effective = availability === 'unknown' ? lastResolved.get(`${sid}::${ha.commandId}`) : availability
    const missing = commandMissing.value.has(`${sid}::${ha.commandId}`)
    // 运行时镜像第三源：插件 updateHeaderAction 推的 disabled（#38 镜像）直接灰置
    // （插件侧业务态，如「调度器运行中不可配置」），宿主侧 E13/E3 判定与之 OR 合成。
    // E3 让位规则（F5）：宿主已判 registered（命令重注册回来了）时 missing 不再置灰——
    // 一次性派发失败让位于重注册事实；unknown 语境无法确认重注册，保持本地置灰原行为
    // （executeCommand 返回 false ⟺ 注册表查无此命令 ⟹ 该失败只发生在非 registered 语境）
    const disabled =
      effective === 'unregistered'
      || (missing && availability !== 'registered')
      || entry?.disabled === true

    // tooltip 合成：unknown（会话恢复中）> unregistered（未加载扩展）> 运行时 entry.tooltip
    // ?? disabled 态泛化文案（场景 12：灰置按钮缺 tooltip 时不得落到声明 title 误导可点；
    // F6 分叉——unregistered 用「未加载扩展」原 key，插件业务 disabled 用「暂不可用」泛化 key）
    // ?? 声明 title；badge 截断时原文拼首行（全文进 tooltip 契约）
    const tooltipLines: string[] = []
    if (entry?.badge && entry.badge.length > BADGE_MAX_CHARS) tooltipLines.push(entry.badge)
    if (availability === 'unknown') tooltipLines.push(t('panel.header.pluginActionRestoring'))
    else if (effective === 'unregistered') tooltipLines.push(t('panel.header.pluginActionExtensionNotLoaded'))
    else tooltipLines.push(entry?.tooltip ?? (entry?.disabled === true ? t('panel.header.pluginActionTemporarilyUnavailable') : ha.title))
    const badge = entry?.badge ? entry.badge.slice(0, BADGE_MAX_CHARS) : ''

    return {
      key: `${decl.pluginId}::${decl.contributionId}`,
      testid: actionTestId(decl.pluginId, decl.contributionId),
      icon: HEADER_ACTION_ICONS[ha.icon] ?? Puzzle,
      badge,
      disabled,
      tooltip: tooltipLines.join('\n'),
      onClick: () => {
        // E3：execute 内部对缺失命令 emit error（ERR6）；返回 false 时本地置灰，禁静默 no-op
        const dispatched = source.executeCommand(ha.commandId)
        if (!dispatched) {
          const next = new Set(commandMissing.value)
          next.add(`${sid}::${ha.commandId}`)
          commandMissing.value = next
        }
      },
    }
  }).filter((b): b is NonNullable<typeof b> => b !== null)
})

// 切会话时清「上次值」簿记与 E3 本地置灰（per-session 语义不跨会话残留）
watch(() => props.sessionId, (_sid, prev) => {
  if (prev === undefined) return
  for (const key of [...lastResolved.keys()]) {
    if (key.startsWith(`${prev}::`)) lastResolved.delete(key)
  }
  if (commandMissing.value.size > 0) {
    const next = new Set([...commandMissing.value].filter((k) => !k.startsWith(`${prev}::`)))
    commandMissing.value = next
  }
})
</script>
