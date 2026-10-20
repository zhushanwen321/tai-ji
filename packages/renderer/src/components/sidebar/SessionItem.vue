<template>
  <!--
    展示组件 · 单会话项（7px 单一 icon 范式），职责块拆子组件（session-item/）：
      - SessionItemContextMenu：右键菜单整棵树 + 强制退出两段确认状态机（Trigger as-child 合并到根 div）
      - SessionItemDisplay：7px 状态 icon + unread 圆点 + label + 徽标 + sub 元信息 + 时间（纯展示零 emit）
      - SessionItemActions：hover ghost 操作 + 归入项目菜单 + 删除两段确认 UI（confirming 经 v-model 提升）
    本组件只保留：对外 props/emit 契约、根 div 与确认态多路 reset 通道、ariaLabel 语义补回。
  -->
  <!-- N8 hover 详情卡（demo .sess-pop 权威形态）：Teleport fixed 全局浮层，不被侧栏
       滚动容器裁剪；交互 = mouseenter 立即开 / 离行即关 / 卡体进入即关（demo Sidebar.vue
       openCard/closeCard 同款，含 focusin/focusout 键盘路径）；字段 = fork 血缘 + 分支 +
       完整目录 + 末行「相对时间 · 消息数」两段（消息数经 session.getMessageCount 按需
       拉取；拉取式 + lastActiveAt 键控缓存，见
       session-item/use-message-count.ts）。
       实现说明：不用 reka HoverCard 原语——其 Trigger/Anchor as-child 跨 SessionItemContextMenu
       （多根组件）合并事件/ref 时 fallthrough 中断（实施期两个嵌套方向均实测断链：外层嵌套断
       pointerenter、内层嵌套断 contextmenu），故触发事件直挂根 div + 受控显隐，卡片定位取行
       rect（demo openCard 公式：右弹 8px + 右缘/下缘视口钳制）。 -->
  <SessionItemContextMenu
    :session-id="session.id"
    :session-label="session.label"
    :parent-agent-session-id="session.parentAgentSessionId"
    :has-agent-parent="hasAgentParent"
    :can-force-quit="canForceQuit"
    :can-stop="canStop"
    :project-id="session.projectId"
    :session-file="session.sessionFile"
    @navigate-parent="emit('navigateParent', $event)"
    @abort="emit('abort', $event)"
    @force-quit="emit('forceQuit', $event)"
    @set-project="emit('setProject', $event)"
    @export-jsonl="emit('exportJsonl', $event)"
  >
    <!-- 激活态（用户裁决 2026-10-13 demo 选型）：选中 = 悬停同色实底（bg-surface-hover）+ 行文字
         提亮 fg，无竖条无描边——选中强度 ≥ hover（两者同底，字色 fg > fg-2 拉开），普通行不加行级色
         （标题色三级范式：普通 fg-2 由 Display 的 .nm 分支承载，hover 只变背景不变字色） -->
    <div
      ref="rootEl"
      role="button"
      tabindex="0"
      draggable="true"
      class="session-item group/item relative flex cursor-pointer select-none items-center gap-[8px] rounded-sm px-[8px] py-[7px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-surface-hover"
      :class="[
        active ? 'bg-surface-hover text-neutral-fg' : '',
        isDead || dragging ? 'opacity-50' : '',
      ]"
      :aria-label="ariaLabel"
      data-testid="session-item"
      @click="emit('select', session.id)"
      @keydown="onItemKeydown"
      @pointerenter="onDetailEnter"
      @pointerleave="onDetailLeave"
      @focusin="onDetailEnter"
      @focusout="onDetailLeave"
      @mouseleave="confirming = false"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
    >
      <!-- 右槽与悬停钮：Actions 经默认 slot 注入 Display 右槽（absolute inset-0 覆盖点+时间，
           2026-10-11 裁决：钮只覆盖槽区，名称由槽左缘截断构造性不受遮） -->
      <SessionItemDisplay :session="displaySession" :status="status" :child-count="childCount" :active="active" :confirming="confirming">
        <SessionItemActions
          v-model:confirming="confirming"
          :session="session"
          @delete="emit('delete', $event)"
          @rename="emit('rename', $event)"
          @set-project="emit('setProject', $event)"
        />
      </SessionItemDisplay>
    </div>
  </SessionItemContextMenu>

  <!-- hover 详情卡（2026-10-13 用户裁决 demo 方案 A 全族迁移后：fixed 232px / bg-bg 底
       （composer 同源档，旧 elevated 浮层档退役）/ border / radius-lg / shadow-2 / 行间
       hairline 分隔 / 行首 13px 图标 + mono 值 + 末行时间 meta / opacity+ translateX
       dur-fast ease-out 进出过渡 / z-hovercard 梯队 / mouseenter 立即开 + 卡体进入即关） -->
  <Teleport to="body">
    <Transition name="sess-pop">
      <div
        v-if="detailVisible"
        data-testid="session-detail-card"
        class="fixed z-[var(--z-hovercard)] w-[232px] rounded-lg border border-border bg-bg px-3 py-2 text-neutral-fg shadow-2"
        :style="detailStyle"
        @pointerenter="onDetailLeave"
      >
        <div class="flex flex-col divide-y divide-hairline">
          <!-- 行形态 = demo .sess-pop .pr：行首 13px 图标（dim）+ 值（mono 12px fg-2 break-all），
               padding 5px 0 / gap 7px；图标 margin-top 2px 对齐首行文本 -->
          <!-- fork 血缘（原列表行 sub 信息随单行化迁入卡片：spec §8.5「↑ fork 自 <父名>」；
               demo 无此概念，复用分支行 GitBranch 图标语言） -->
          <div v-if="session.parentSession" class="flex items-start gap-[7px] py-[5px]">
            <GitBranch class="mt-[2px] size-[13px] shrink-0 text-neutral-dim" :stroke-width="1.8" />
            <span class="min-w-0 break-all text-[length:var(--text-xs)] leading-[1.55] text-neutral-fg-2">
              {{ t('sidebar.sessionItem.forkFrom') }} {{ session.parentLabel || session.parentSession }}
            </span>
          </div>
          <div v-if="session.gitBranch" class="flex items-start gap-[7px] py-[5px]">
            <GitBranch class="mt-[2px] size-[13px] shrink-0 text-neutral-dim" :stroke-width="1.8" />
            <span class="min-w-0 break-all font-mono text-[length:var(--text-xs)] leading-[1.55] text-neutral-fg-2">
              {{ session.gitBranch }}
            </span>
          </div>
          <div class="flex items-start gap-[7px] py-[5px]">
            <Folder class="mt-[2px] size-[13px] shrink-0 text-neutral-dim" :stroke-width="1.8" />
            <span class="min-w-0 break-all font-mono text-[length:var(--text-xs)] leading-[1.55] text-neutral-fg-2">
              {{ session.cwd }}
            </span>
          </div>
          <!-- 末行 meta（demo .pr.meta：dim 12px 纯文本行；demo 内容 = `upd · msgs` 两段，
               分隔 = ` · `；real 段一 = 相对时间，段二 = 消息计数（通道 2 按需拉取，
               未返回前该段不渲染——避免闪 0）） -->
          <div class="py-[5px] text-[length:var(--text-xs)] leading-[1.55] text-neutral-dim">
            {{ timeLabel }}<template v-if="messageCount !== null"> · <span data-testid="session-detail-card-msg-count">{{ msgCountLabel }}</span></template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside } from '@vueuse/core'
import { Folder, GitBranch } from '@lucide/vue'
import { isMarkedDone } from '@/composables/useSessionMarkers'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { fetchSessionMessageCount } from './session-item/use-message-count'
import { SESSION_DRAG_MIME } from './session-drag'
import type { DerivedStatus } from '@/types'
import SessionItemContextMenu from './session-item/SessionItemContextMenu.vue'
import SessionItemDisplay from './session-item/SessionItemDisplay.vue'
import SessionItemActions from './session-item/SessionItemActions.vue'
import type { SessionItemSession } from './session-item/types'

/**
 * 展示组件 · 单会话项（spec §5.6A / D12 列表主行范式）。
 * active = demo .si.on（workbench.css 文件尾 Tier B 范式）：无底无框，仅行文字提亮 fg
 * （2026-10-10 对齐 demo 终态；此前 accent 浅底 + 2px 竖条形态对应的是旧 demo .sess.is-active，
 * demo 单行 .si 化后选中态已收编为 Tier B）；
 * hover ghost 操作（bottom-right）；
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
  /** 父 session 显示名（SessionList 反查血缘注入，hover 详情卡血缘行展示「fork 自 <父名>」；
   *  缺省回退 session.parentSession 原值——卡片血缘行的 `parentLabel || parentSession`） */
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
  /** 导出 JSONL：透传 ContextMenu 的 exportJsonl
   *  （payload = main 侧 IPC 请求体），Sidebar 接 exportSessionJsonl IPC + toast。 */
  exportJsonl: [payload: { sessionId: string; sessionFile?: string; suggestedName?: string }]
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

// ── 键盘可达（demo Sidebar.vue onSiKey 同链路：Tab 聚焦行 → Enter/Space 选择 →
//    ContextMenu/Shift+F10 开右键菜单）──

/** 行级键处理：e.target 检查行自身聚焦（子钮聚焦时 Enter 冒泡到此不得二次触发
 *  select，钮激活交还原生 click）。Enter/Space = 选择（Space preventDefault 防滚动）。
 *  不用 Vue 按键修饰符：withKeys 按 hyphenate(event.key) 匹配（@vue/runtime-dom
 *  keyNames 表），'ContextMenu' 键 hyphenate 后为 'context-menu' 无对应修饰符，
 *  shift 检查也无法表达——手写判断。 */
function onItemKeydown(e: KeyboardEvent): void {
  const el = rootEl.value
  if (!el || e.target !== el) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('select', props.session.id)
    return
  }
  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault()
    onKeyOpenMenu()
  }
}

/** 键盘呼出菜单的锚点下探量（px）：demo openCtxKey 取行左下角 +2px。 */
const KEYBOARD_MENU_ANCHOR_GAP_PX = 2

/** 键盘打开右键菜单：reka ContextMenuTrigger 只监听 contextmenu 事件且菜单锚点取
 *  event.clientX/Y（reka-ui dist/ContextMenu/ContextMenuTrigger.js handleContextMenu），
 *  无受控 open 通道——按 radix/reka 生态惯例合成 contextmenu MouseEvent 转发。
 *  锚点 = 行左下角（demo openCtxKey：无指针坐标时以触发行左下角锚定菜单，spec §3.4）。 */
function onKeyOpenMenu(): void {
  const el = rootEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left),
      clientY: Math.round(rect.bottom + KEYBOARD_MENU_ANCHOR_GAP_PX),
    }),
  )
}

// ── N8 hover 详情卡（demo .sess-pop 交互同款）──

/** 卡宽（demo .sess-pop 232px 固定宽）；定位常量 = demo Sidebar.vue openCard 公式：
 *  右弹 gap 8px，右缘 clamp 预留 240（卡宽 232 + 8），视口下缘按卡估高 158 钳制，四边最小 8px */
const DETAIL_CARD_GAP_PX = 8
const DETAIL_VIEWPORT_MARGIN = 240
const DETAIL_CARD_ESTIMATED_H = 158
const DETAIL_MIN_EDGE_PX = 8

const detailVisible = ref(false)
const detailStyle = ref<Record<string, string>>({})

/** 行 hover/键盘聚焦进入：立即取行 rect 右弹定位显示详情卡（demo @mouseenter=openCard 同款，
 *  无防扫过延迟——mock 权威即此交互；键盘路径 focusin 同样开卡，与 demo @focusin 一致）；
 *  开卡同时按需拉取消息计数（通道 2：缓存命中即回，未命中经 in-flight 去重发 RPC） */
function onDetailEnter(): void {
  void loadMessageCount()
  const el = rootEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const left = Math.min(
    rect.right + DETAIL_CARD_GAP_PX,
    window.innerWidth - DETAIL_VIEWPORT_MARGIN,
  )
  detailStyle.value = {
    left: `${Math.max(DETAIL_MIN_EDGE_PX, left)}px`,
    top: `${Math.max(DETAIL_MIN_EDGE_PX, Math.min(rect.top, window.innerHeight - DETAIL_CARD_ESTIMATED_H))}px`,
  }
  detailVisible.value = true
}

/** 行 hover/聚焦离开（及卡体进入）：收卡——demo 卡体 @mouseenter=closeCard，卡为纯展示不可进入 */
function onDetailLeave(): void {
  detailVisible.value = false
}

// ── 拖拽移动到项目（侧栏拖拽落点 = ProjectGroup 组头 / DefaultProjectHead）──

/** dragstart 写入 sessionId（SESSION_DRAG_MIME），落点按 types 命中识别（dragover 阶段
 *  getData 不可读）。dragging 半透明反馈源行；dragend 兜底复位（drop 被取消也还原）。 */
const dragging = ref(false)

function onDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData(SESSION_DRAG_MIME, props.session.id)
  e.dataTransfer.effectAllowed = 'move'
  dragging.value = true
  // drag 期间 pointerleave 不触发，详情卡显式收起
  detailVisible.value = false
}

function onDragEnd(): void {
  dragging.value = false
}

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

/** 确认态上供祖先聚合（§6.7 后行档：SessionList 聚合谓词读本 ref——绑定「确认态本体」）：
 *  注入集合缺省空集（脱离 SessionList 直挂时零副作用），卸载即撤（防泄漏幽灵读点）。 */
const itemConfirmingSet = inject<Set<Ref<boolean>>>('sessionItemConfirmingSet', new Set<Ref<boolean>>())
itemConfirmingSet.add(confirming)
onBeforeUnmount(() => itemConfirmingSet.delete(confirming))

/** 点击外部取消：点该 item 外部时清掉确认态 */
onClickOutside(rootEl, () => {
  confirming.value = false
})

/** 详情卡末行 meta 段一：相对时间（demo .pr.meta 的 upd 段） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))

// ── 悬停详情卡消息计数 ──

/** 计数段值：null = 未返回 / 拉取失败（该段不渲染，避免闪 0 与失败误显示） */
const messageCount = ref<number | null>(null)

/** 开卡触发：拉取式（缓存命中 lastActiveAt 未变即回，失败占位 null 不缓存） */
async function loadMessageCount(): Promise<void> {
  messageCount.value = await fetchSessionMessageCount({
    id: props.session.id,
    lastActiveAt: props.session.lastActiveAt,
  })
}

/** 详情卡末行 meta 段二：消息计数（demo msgs 段语气对齐：zh「N 条消息」/ en「N msgs」） */
const msgCountLabel = computed(() => t('sidebar.sessionItem.msgCount', { count: messageCount.value ?? 0 }))

/** 无障碍 label：归档态把归档语义拼进 label，让屏幕阅读器读出「已归档: <名称>」。
 *  背景是归档态移除了可见的「已归档」文字（改用 opacity-60 降权），opacity 不影响 a11y，
 *  故在此补回语义。 */
const ariaLabel = computed(() =>
  isMarkedDone(props.session.id)
    ? `${t('sidebar.sessionItem.archived')}: ${props.session.label}`
    : props.session.label,
)
</script>

<style scoped>
/* 详情卡进出过渡（demo .sess-pop：opacity + translateX(-3px) dur-fast ease-out）——
   Transition 类是 scoped style 的合法 escape hatch；reduced-motion 停（demo 同款）。 */
.sess-pop-enter-active,
.sess-pop-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.sess-pop-enter-from,
.sess-pop-leave-to {
  opacity: 0;
  transform: translateX(-3px);
}
@media (prefers-reduced-motion: reduce) {
  .sess-pop-enter-active,
  .sess-pop-leave-active {
    transition: none;
  }
}
</style>
