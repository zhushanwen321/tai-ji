<template>
  <!--
    展示组件 · 单会话项（7px 单一 icon 范式），职责块拆子组件（session-item/）：
      - SessionItemContextMenu：右键菜单整棵树 + 强制退出两段确认状态机（Trigger as-child 合并到根 div）
      - SessionItemDisplay：7px 状态 icon + unread 圆点 + label + 徽标 + sub 元信息 + 时间（纯展示零 emit）
      - SessionItemActions：hover ghost 操作 + 归入项目菜单 + 删除两段确认 UI（confirming 经 v-model 提升）
    本组件只保留：对外 props/emit 契约、根 div 与确认态多路 reset 通道、ariaLabel 语义补回。
  -->
  <SessionItemContextMenu
    :session-id="session.id"
    :parent-agent-session-id="session.parentAgentSessionId"
    :has-agent-parent="hasAgentParent"
    :can-force-quit="canForceQuit"
    :can-stop="canStop"
    @navigate-parent="emit('navigateParent', $event)"
    @abort="emit('abort', $event)"
    @force-quit="emit('forceQuit', $event)"
  >
    <div
      ref="rootEl"
      class="session-item group/item relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors"
      :class="[
        active ? 'bg-surface' : 'hover:bg-surface-hover',
        isDead ? 'opacity-50' : '',
      ]"
      :aria-label="ariaLabel"
      @click="emit('select', session.id)"
      @mouseleave="confirming = false"
    >
      <SessionItemDisplay :session="displaySession" :active="active" :status="status" :child-count="childCount" />

      <SessionItemActions
        v-model:confirming="confirming"
        :session="session"
        @delete="emit('delete', $event)"
        @rename="emit('rename', $event)"
        @set-project="emit('setProject', $event)"
      />
    </div>
  </SessionItemContextMenu>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside } from '@vueuse/core'
import { isMarkedDone } from '@/composables/useSessionMarkers'
import type { DerivedStatus } from '@/types'
import SessionItemContextMenu from './session-item/SessionItemContextMenu.vue'
import SessionItemDisplay from './session-item/SessionItemDisplay.vue'
import SessionItemActions from './session-item/SessionItemActions.vue'
import type { SessionItemSession } from './session-item/types'

/**
 * 展示组件 · 单会话项（spec §5.6A / D12 列表主行范式）。
 * active=bg-surface+text-accent；hover ghost 操作（bottom-right）；
 * agent-spawned session（U8）：标题旁 [AI] badge + 右键「查看父 session」菜单。
 * 非 dead session 右键另有「强制退出」逃生入口（两段确认，状态机在 ContextMenu 子组件）。
 */
const { t } = useI18n()

const props = withDefaults(defineProps<{
  session: SessionItemSession
  active: boolean
  status: DerivedStatus
  /** 子会话数（按 parentAgentSessionId 计数，SessionList 注入）；只读徒标，0 不渲染 */
  childCount?: number
  /** 父 session 显示名（SessionList 反查血缘注入，sub 行展示「fork 自 <父名>」；
   *  缺省回退 session.parentSession 原值——SessionItemDisplay 的 `parentLabel || parentSession`） */
  parentLabel?: string
}>(), { childCount: 0 })

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
  /** 归入项目（D14 语义修正）：payload 单对象（规则 #1）。projectId 空串 = 归回默认项目。 */
  setProject: [{ sessionId: string; projectId: string }]
  /** 查看父 session（U8）：payload 单字符串 = parentAgentSessionId（与 select 同形）。
   *  跳转本身由上层（Sidebar/store）接线，本组件只发事件。 */
  navigateParent: [parentAgentSessionId: string]
  /** 停止（软停止，两段确认后 emit）：abort 中止当前生成，上层接 chat.abort。
   *  与 forceQuit（硬杀 pi 进程 → dead）不是同一能力，不可互相替代。 */
  abort: [sessionId: string]
  /** 强制退出（两段确认后 emit）：杀 pi 进程 + stopped 收敛，上层接 RPC。 */
  forceQuit: [sessionId: string]
}>()

/** dead session（进程已退出）置灰，仍可点击（点击触发 restore 重开） */
const isDead = computed(() => props.session.status === 'dead')
/** 右键「查看父 session」条件：agent 经 session-manager 创建且带父 id。 */
const hasAgentParent = computed(
  () => props.session.spawnSource === 'agent' && !!props.session.parentAgentSessionId,
)
/** 非 dead session 可强制退出（dead 进程已退出，无需强杀；点击走 restore 重开）。 */
const canForceQuit = computed(() => !isDead.value)
/** 运行中（session.status === 'active' = pi 进程存活且生成中）可软停止：
 *  菜单项「停止」→ abort（会话转 stopped，可 restore 重开）——ForkGroup 退役后能力迁入（D9）。 */
const canStop = computed(() => props.session.status === 'active')

/**
 * 血缘展示用 session：把容器（SessionList.parentLabelOf）反查到的父名合并进展示对象。
 * parentLabel 是展示期注入字段（不污染 SessionSummary 实体），合并在展示边界完成——
 * 此前 SessionList 传了 :parent-label 但 SessionItem 未声明该 prop，血缘 sub 行实际
 * 回退到 parentSession 原值（文件路径/UUID，不可读），与 SessionList 注释声明的机制不符。
 */
const displaySession = computed<SessionItemSession>(() =>
  props.parentLabel ? { ...props.session, parentLabel: props.parentLabel } : props.session,
)

/**
 * 删除两段式确认态（确认 UI 在 Actions 子组件，经 v-model:confirming 双向）。
 * 首次点击进入红底确认态（不 emit），再次点击才 emit delete。
 * 多路 reset 防红按钮长期停留：mouseleave（模板兜底）、失焦（watch active）、
 * Esc 键、点击外部（onClickOutside）。
 */
const confirming = ref(false)

/** 根元素引用（onClickOutside 目标） */
const rootEl = ref<HTMLElement | null>(null)

/** 失焦自动重置：切到其它 session（active → false）时清掉残留确认态 */
watch(
  () => props.active,
  (active) => {
    if (!active) confirming.value = false
  },
)

/** Esc 取消：从 SessionList 接收单一 Esc 监听（避免每实例注册 window listener）。
 *  watch escCount 变化 → 清 confirming 态（不影响全局快捷键）。 */
const escCount = inject<Ref<number>>('sessionItemEsc', ref(0))
watch(escCount, () => {
  if (confirming.value) confirming.value = false
})

/** 点击外部取消：点该 item 外部时清掉确认态 */
onClickOutside(rootEl, () => {
  confirming.value = false
})

/** 无障碍 label：归档态把归档语义拼进 label，让屏幕阅读器读出「已归档: <名称>」。
 *  背景是归档态移除了可见的「已归档」文字（改用 opacity-60 降权），opacity 不影响 a11y，
 *  故在此补回语义。 */
const ariaLabel = computed(() =>
  isMarkedDone(props.session.id)
    ? `${t('sidebar.sessionItem.archived')}: ${props.session.label}`
    : props.session.label,
)
</script>
