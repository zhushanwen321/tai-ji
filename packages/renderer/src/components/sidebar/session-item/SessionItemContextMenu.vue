<template>
  <!--
    SessionItem 右键菜单子块：整棵 reka ContextMenu 树 + 停止/强制退出两段确认状态机
    + 「移动到项目」分组（demo 菜单主体组，数据源与 ghost Popover 共用 assign-targets.ts）。
    Trigger as-child 合并到 slot（主组件的 .session-item 根 div），不引入额外包裹层破坏既有 flex/绝对定位。
    状态机在此内聚的理由：confirmingStop/confirmingQuit 只被菜单 item 消费，其重置通道（update:open）
    也挂在 ContextMenuRoot 上——与条目展示零耦合，拆出去反而要跨组件同步菜单开关状态。

    「停止」= 软停止（abort → 会话转 stopped，可 restore 重开），由 ForkGroup 退役迁入（D9）；
    「强制退出」= 硬杀 pi 进程 → dead（逃生入口），两者不是同一能力，不可互相替代。
    2026-10-10 用户裁决（入口重设计）：悬停 ghost 钮收敛为 3 个（重命名/删除/归入项目），
    「标记完成」「引用到输入区」自 ghost 层迁入本菜单（原「行操作组不承载」口径作废，
    重命名/删除仍归 ghost 层）。
  -->
  <!-- 右键菜单用 reka ContextMenu 原语（光标定位原语级支持，PanelContainer 同为直接引 reka-ui 先例）。 -->
  <ContextMenuRoot @update:open="onMenuOpenChange">
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <!-- 右键菜单（2026-10-10 入口重设计后恒有内容：标记完成/引用到输入区 + 移动到项目
         分组；导出 JSONL（2026-10-12 立项落地）/查看父/停止/强制退出按条件插入）。
         跳转/停止/退出/导出逻辑由上层接线，本组件只保证事件链 emit navigateParent /
         abort / forceQuit / exportJsonl。 -->
    <ContextMenuPortal>
      <ContextMenuContent
        ref="menuContentRef"
        data-testid="session-context-menu"
        class="z-[var(--z-popover)] min-w-[148px] rounded-md border border-border bg-bg p-[4px] text-neutral-fg shadow-2 outline-none"
        :collision-padding="8"
      >
        <!-- 标记完成（自 ghost 层迁入 2026-10-10）：toggle 模块级 markers 集合，
             Display 的 icon/降权响应式跟随；title 随态切换。
             键盘高亮 = data-[highlighted]（与 ui/select SelectItem 先例同形态；demo
             .ctxmenu button:hover 仅变底色）；确认态分支不挂 highlighted 类，红底不被覆盖。 -->
        <ContextMenuItem
          data-testid="session-mark-done-item"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-[8px] rounded-sm px-[9px] text-[length:var(--text-xs)] outline-none [&_svg]:size-[13px]"
          :class="markedDone
            ? 'text-success data-[highlighted]:bg-surface-hover'
            : 'text-neutral-fg hover:bg-surface-hover hover:text-neutral-fg data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg'"
          @select="onMarkDone"
        >
          <Archive :class="markedDone ? 'fill-current' : ''" />
          <span>{{ markedDone ? t('sidebar.sessionItem.unmarkDone') : t('sidebar.sessionItem.markDone') }}</span>
        </ContextMenuItem>
        <!-- 导出 JSONL（2026-10-12 立项落地；demo 菜单
             归档/导出相邻，紧随标记完成）。sessionFile 缺失（pi 延迟写入窗口，首条消息前
             文件未落盘）→ 禁用态：缺失是可预知的静态数据态（SessionSummary 快照已含该
             信息），禁用即最短反馈路径，不为已知不可用的动作走一轮失败 IPC。导出经
             emit exportJsonl 上层接线（SessionList → Sidebar → useSidebarSessionActions，
             toast 反馈与 abort/forceQuit 同通道）。 -->
        <ContextMenuItem
          data-testid="session-export-jsonl-item"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-[8px] rounded-sm px-[9px] text-[length:var(--text-xs)] text-neutral-fg outline-none hover:bg-surface-hover hover:text-neutral-fg data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg data-[disabled]:pointer-events-none data-[disabled]:text-neutral-dim [&_svg]:size-[13px]"
          :disabled="!sessionFile"
          :title="sessionFile ? undefined : t('sidebar.sessionItem.exportJsonlUnavailable')"
          @select="onExportJsonl"
        >
          <FileDown />
          <span>{{ t('sidebar.sessionItem.exportJsonl') }}</span>
        </ContextMenuItem>
        <!-- 引用到输入区（自 ghost 层迁入 2026-10-10）：四符号体系 §3.1.2 侧边栏直引 G2 入口，
             经 composerInjectionStore 一次性通道（语义同原 ghost 钮，landing 态 target=new）。 -->
        <ContextMenuItem
          data-testid="session-quote-item"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-[8px] rounded-sm px-[9px] text-[length:var(--text-xs)] text-neutral-fg outline-none hover:bg-surface-hover hover:text-neutral-fg data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg [&_svg]:size-[13px]"
          @select="onQuoteToComposer"
        >
          <Quote />
          <span>{{ t('sidebar.sessionItem.quoteToComposer') }}</span>
        </ContextMenuItem>
        <ContextMenuItem
          v-if="hasAgentParent"
          data-testid="session-view-parent-item"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-[8px] rounded-sm px-[9px] text-[length:var(--text-xs)] text-neutral-fg outline-none hover:bg-surface-hover hover:text-neutral-fg data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg [&_svg]:size-[13px]"
          @select="onViewParent"
        >
          <CornerLeftUp />
          <span>{{ t('sidebar.sessionItem.viewParent') }}</span>
        </ContextMenuItem>
        <!-- 停止（软停止，两段式确认）：仅运行中状态渲染（status 'active' = pi 进程存活且生成中，
             与 abort 的目标态一致）。首击 preventDefault 保持菜单打开并进入确认态（danger 底），
             再击才 emit abort。与下方「强制退出」是不同能力：本项不杀进程、可 restore 重开。 -->
        <ContextMenuItem
          v-if="canStop"
          data-testid="session-stop-item"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-[8px] rounded-sm px-[9px] text-[length:var(--text-xs)] outline-none [&_svg]:size-[13px]"
          :class="confirmingStop
            ? 'bg-danger text-neutral-fg'
            : 'text-neutral-fg hover:bg-surface-hover hover:text-neutral-fg data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg'"
          @select="onStopSelect"
        >
          <Square />
          <span>{{ confirmingStop ? t('sidebar.sessionItem.stopConfirm') : t('sidebar.sessionItem.stop') }}</span>
        </ContextMenuItem>
        <!-- 强制退出（两段式确认）：首击 preventDefault 保持菜单打开并进入确认态（danger 底），
             再击才 emit。reka ContextMenuItem 的 select event cancelable，preventDefault 可阻止自动关闭。 -->
        <ContextMenuItem
          v-if="canForceQuit"
          data-testid="session-force-quit-item"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-[8px] rounded-sm px-[9px] text-[length:var(--text-xs)] outline-none [&_svg]:size-[13px]"
          :class="confirmingQuit
            ? 'bg-danger text-neutral-fg'
            : 'text-danger hover:bg-danger-soft hover:text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger'"
          @select="onForceQuitSelect"
        >
          <Power />
          <span>{{ confirmingQuit ? t('sidebar.sessionItem.forceQuitConfirm') : t('sidebar.sessionItem.forceQuit') }}</span>
        </ContextMenuItem>
        <!-- 「移动到项目」分组（demo 菜单主体组，评审 F1）：sep + .ctx-label 标签行
             （padding 6/9/3、10.5px dim→real 取 --text-2xs 11px 档、letter-spacing 0.03em）+ 项目行首定宽勾标列
             （14px 居中 accent，当前归属项显 Check）。demo 勾标为文本字符（U+2713），
             real 按 no-emoji-in-template 规则换 lucide Check（同一勾形语义；像素形态差异
             为有意差异）。项目行 gap-2 =
             demo .ctxmenu button 同参（demo overlays spec §6 + §5.6 验收：项目名距菜单左缘
             ≈35px = 菜单 p4 + 行 px9 + 勾标列 14 + gap 8）。归属判定与 ghost
             Popover 同口径（projectId || '' 归一，review S-2）；归类动作 emit setProject
             复用 SessionItem 既有出站链（D14）。行操作组中「导出 JSONL」已于 2026-10-12
             立项进菜单（紧随标记完成 = demo 归档/导出
             相邻 IA）；重命名/删除仍归 ghost 层。 -->
        <!-- sep：demo .ctxmenu .sep = height 1px + margin 4px 6px + var(--hairline)；bg-hairline
             无对应工具类规则（config 只扩展 borderColor.hairline），曾渲染透明分隔线。 -->
        <ContextMenuSeparator class="my-1 mx-[6px] h-px bg-[var(--hairline)]" />
        <!-- ctx-label 字号：demo 精确值 10.5px 无对应 token 档，取 --text-2xs(11px) 档换
             --font-scale-sidebar 缩放能力，登记 0.5px 静态偏差（取舍登记已删除，git 可追溯）。 -->
        <div
          data-testid="context-assign-label"
          class="px-[9px] pt-[6px] pb-[3px] text-[length:var(--text-2xs)] text-neutral-dim [letter-spacing:0.03em]"
        >
          {{ t('sidebar.sessionItem.moveToProject') }}
        </div>
        <ContextMenuItem
          v-for="p in assignTargets"
          :key="p.id"
          data-testid="context-assign-project-option"
          class="flex h-[28px] w-full cursor-pointer select-none items-center gap-2 rounded-sm px-[9px] text-[length:var(--text-xs)] text-neutral-fg outline-none hover:bg-surface-hover data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg"
          @select="onAssignProject(p.id)"
        >
          <span class="flex w-[14px] shrink-0 items-center justify-center text-accent">
            <Check v-if="currentProjectId === p.id" class="size-[11px]" />
          </span>
          <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, Check, CornerLeftUp, FileDown, Power, Quote, Square } from '@lucide/vue'
import type { SessionJsonlExportPayload } from '@taiji/shared'
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from 'reka-ui'
import { registerModalSurface, surfaceRectOf } from '@/composables/features/app/modal-surface-registry'
import { useSessionStore } from '@/stores/session'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { toggleMarkedDone, isMarkedDone } from '@/composables/useSessionMarkers'
import { useAssignTargets } from './assign-targets'

const props = defineProps<{
  sessionId: string
  /** 会话显示名（引用到输入区的 chip label，SessionItem 透传） */
  sessionLabel: string
  /** 父 agent session id（U8）：「查看父 session」的跳转目标 payload */
  parentAgentSessionId?: string
  /** agent-spawned 且带父 id（badge 只标来源；右键菜单还需父 id 才有可导航目标） */
  hasAgentParent: boolean
  /** 非 dead session 可强制退出（dead 进程已退出，无需强杀；点击走 restore 重开） */
  canForceQuit: boolean
  /** 运行中（session.status === 'active'）可软停止（abort → stopped，可 restore） */
  canStop: boolean
  /** 当前归属 project id（undefined = 未归类，归一空串后与默认项目项命中勾标，review S-2） */
  projectId?: string
  /** 会话 JSONL 文件绝对路径（SessionSummary.sessionFile 透传）：
   *  「导出 JSONL」的 payload 源；缺失（pi 延迟写入窗口）→ 菜单项禁用。 */
  sessionFile?: string
}>()

const emit = defineEmits<{
  /** 查看父 session（U8）：payload 单字符串 = parentAgentSessionId（与 select 同形）。
   *  跳转本身由上层（Sidebar/store）接线，本组件只发事件。 */
  navigateParent: [parentAgentSessionId: string]
  /** 停止（软停止，两段确认后 emit）：abort 中止当前生成，上层接 chat.abort。 */
  abort: [sessionId: string]
  /** 强制退出（两段确认后 emit）：杀 pi 进程 + stopped 收敛，上层接 RPC。 */
  forceQuit: [sessionId: string]
  /** 归入项目（D14 语义修正）：payload 单对象（规则 #1）。projectId 空串 = 归回默认项目。
   *  与 ghost Popover 的 setProject 同链路（SessionItem 透传 → Sidebar → useSidebar）。 */
  setProject: [{ sessionId: string; projectId: string }]
  /** 导出 JSONL：payload 单对象（规则 #1），即 main
   *  侧 IPC 请求体（源路径三树校验 + 保存对话框 + copyFile 都在 main）。IPC 调用与
   *  toast 反馈由上层接线（Sidebar → useSidebarSessionActions）。 */
  exportJsonl: [payload: SessionJsonlExportPayload]
}>()

const { t } = useI18n()

// ── 标记完成（ghost 层迁入）──
const markedDone = computed(() => isMarkedDone(props.sessionId))
/** toggle 模块级 markers 集合，Display 的 icon/降权响应式跟随。 */
function onMarkDone(): void {
  toggleMarkedDone(props.sessionId)
}

// ── 引用到输入区（四符号体系 §3.1.2 侧边栏直引，自 ghost 层迁入）──
const sessionStore = useSessionStore()

/**
 * 把本 session 作为 # 引用注入当前 composer（语义同原 ghost 钮，见 SessionItemActions
 * 历史实现：被引用 = 本条 session，目标 = 当前活跃 session 的 composer）。landing 态
 * （无活跃 session）走 target=new。
 */
function onQuoteToComposer(): void {
  const activeId = sessionStore.active?.id ?? null
  composerInjectionStore.requestInjection(
    activeId
      ? { target: 'current', sessionId: activeId, refSessionId: props.sessionId, label: props.sessionLabel }
      : { target: 'new', refSessionId: props.sessionId, label: props.sessionLabel },
  )
}

// ── 「移动到项目」分组（demo 菜单主体组）──
const assignTargets = useAssignTargets()
/** 当前归属 project id（undefined 归一空串 = 默认项目项，与 ghost Popover 高亮口径一致）。 */
const currentProjectId = computed(() => props.projectId ?? '')
/** 菜单内归类：emit setProject（归类可逆，无需两段确认；链路同 SessionItemActions.onAssign）。 */
function onAssignProject(projectId: string): void {
  emit('setProject', { sessionId: props.sessionId, projectId })
}

/** 停止两段式确认态（同删除 confirming 模式；菜单内完成，靠 select preventDefault 保持菜单打开）。 */
const confirmingStop = ref(false)
/** 强制退出两段式确认态（同上）。 */
const confirmingQuit = ref(false)
/** 菜单开合态镜像（reka ContextMenuRoot open 经 update:open 广播；聚合注册读点直读）。 */
const menuOpen = ref(false)
/** 菜单关闭重置两个确认态，避免下次打开残留确认样式。 */
function onMenuOpenChange(open: boolean): void {
  menuOpen.value = open
  if (!open) {
    confirmingStop.value = false
    confirmingQuit.value = false
  }
}

// 模态表面聚合注册（§6.7 弹出层族）：右键菜单是键盘可感知的 reka 托管弹层（Esc 让位
// ——reka DismissableLayer 不 preventDefault，走聚合让位档），开合态绑 update:open
// 镜像 ref（ContextMenuRoot open 状态本体的官方通知通道，非广播计数器）；实例级 key
// 按 session（N 个 SessionItem 各持一棵菜单树，同 session 单实例）。旗标组由登记表按
// id 读取；几何读点取菜单内容组件实例 $el（未挂载/非元素 → null，主进程保守按相交）。
const menuContentRef = ref<{ $el?: unknown } | null>(null)
const disposeSurfaceRegistration = registerModalSurface({
  surface: 'session-item-context-menu',
  key: `session-context-menu-${props.sessionId}`,
  isOpen: () => menuOpen.value,
  rect: () => surfaceRectOf(menuContentRef.value),
})
onBeforeUnmount(disposeSurfaceRegistration)
/** 停止首击进入确认态并阻止菜单关闭（reka select event cancelable）；再击 emit 并复位。 */
function onStopSelect(e: Event): void {
  if (!confirmingStop.value) {
    e.preventDefault()
    confirmingStop.value = true
    return
  }
  confirmingStop.value = false
  emit('abort', props.sessionId)
}
/** 首击进入确认态并阻止菜单关闭（reka select event cancelable）；再击 emit 并复位。 */
function onForceQuitSelect(e: Event): void {
  if (!confirmingQuit.value) {
    e.preventDefault()
    confirmingQuit.value = true
    return
  }
  confirmingQuit.value = false
  emit('forceQuit', props.sessionId)
}
/** 菜单项点击：向上 emit 父 session id。守卫除防御外还承担 TS 窄化
 *  （props 字段 string|undefined → emit 要求 string），不可删。 */
function onViewParent(): void {
  const parent = props.parentAgentSessionId
  if (!parent) return
  emit('navigateParent', parent)
}

/** 导出 JSONL（单段确认，无破坏性不进两段式）：payload = main 侧 IPC 请求体原形
 *  （suggestedName = 会话 label——非法文件名字符清洗在 main 侧做，不双份实现）。 */
function onExportJsonl(): void {
  emit('exportJsonl', {
    sessionId: props.sessionId,
    sessionFile: props.sessionFile,
    suggestedName: `${props.sessionLabel}.jsonl`,
  })
}
</script>
