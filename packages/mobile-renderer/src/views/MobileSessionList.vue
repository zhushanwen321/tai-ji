<script setup lang="ts">
// MobileSessionList —— 移动壳会话列表（core createSessionStore/createUseSession 驱动，remote-use-mobile D7（移动壳 v1 功能集裁定）的列表行）。
//
// 数据源：app-runtime 的 sessionList（runtime 组序投影，A13：客户端不重排——排序谓词
// sessionsInRuntimeGroupOrder 已下沉 core（U20），store.list 经它派生，与桌面同源）+
// listLoadError（core loadSessions 错误落 store，点击重试走同一入口）。
// 状态点 = 派生态（A14/U20）：逐条目经 core deriveSessionStatus 按参数化输入计算——
// isActive/isCompacting（core chat store occupancy）+ hasBackgroundWork（A9 subagent 运行态
// 分区读口）+ metaStatus（条目 status）；hasBlockingOverlay 缺省 false（移动壳无 extensionUI
// store，D9② 白名单）。全表 computed：computed 体内读 chat 分区/subagent 分区建立响应式
// 依赖，任一变化整表重算——列表 N 小（<50，桌面 W3 同款论证），单条判定只取分区末位，
// 流式期高频重算成本可忽略；不用 per-session computed 缓存（免失效管理面）。
// 点击条目 → dead 分流（A3：dead 弹「重新打开」引导菜单，走恢复三步编排）或 core
// selectSession（12 步切入链 headless 形态）→ 上抛 open-chat 切到聊天视图。
// 长按条目 → 动作菜单（A4：重命名/删除——删除走 core deleteSession 销毁唯一编排点，
// triggerSessionCleanups 全清注册项；重命名走 core renameSession 乐观更新）。
// 新建入口「+」上抛 new-task（表单由 App 挂载）。
// 行条目渲染委托 SessionListItem（u13/A5：内联模板机械拆出 + 模型/思考档只读标签）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { Button, Input } from '@taiji/ui'
import type { DerivedStatus } from '@taiji/core'
import { deriveSessionStatus } from '@taiji/core'
import type { SessionSummary } from '@taiji/shared'
import {
  chatStore,
  deleteSession,
  loadSessions,
  renameSession,
  restoreSession,
  selectSession,
  sessionList,
  sessionStore,
} from '../shell/app-runtime'
import { hasRunningSubagents } from './SubagentStatusLine.vue'
import SessionListItem from './SessionListItem.vue'

const emit = defineEmits<{
  (e: 'new-task'): void
  (e: 'open-chat', sessionId: string): void
}>()

const { t } = useI18n()

const loadError = computed(() => sessionStore.listLoadError.value)
const activeId = computed(() => sessionStore.activeId.value)

/** 列表条目：runtime 组序原样渲染（A13 统一裁决——服务端权威序，客户端零重排） */
const items = computed<SessionSummary[]>(() => sessionList.value)

/**
 * 逐条目派生状态（A14/U20）：core 谓词单点判定，移动输入 = occupancy + subagent 运行态
 * 子集（输入契约见 core SessionStatusInputs 注释）。dead 进程态经 metaStatus 进入谓词
 * （未 hydrate 兜底语义）且 SessionListItem 保留红点特判——进程态权威于对话派生。
 * 在渲染 effect 内调用：读 chat 分区/subagent 分区建立响应式依赖，任一变化行自动重算
 * （列表 N 小，单条判定只取分区末位——成本论证见文件头）。
 */
function deriveStatusOf(item: SessionSummary): DerivedStatus {
  return deriveSessionStatus(item.id, chatStore, {
    isActive: chatStore.isActive(item.id),
    isCompacting: chatStore.isCompacting(item.id),
    hasBackgroundWork: hasRunningSubagents(item.id),
    metaStatus: item.status,
  })
}

async function onOpen(sessionId: string): Promise<void> {
  // 长按弹菜单后的 click 穿透抑制（长按计时器已 fire 过则本次 click 是松手伴生事件）
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  // dead 分流（A3）：不直接切入空白会话，弹「重新打开」引导菜单走恢复编排
  const target = items.value.find((s) => s.id === sessionId)
  if (target?.status === 'dead') {
    openMenu(target)
    return
  }
  await selectSession(sessionId)
  emit('open-chat', sessionId)
}

function onRetry(): void {
  void loadSessions()
}

// ── 长按检测 + 动作菜单（A4）─────────────────────────────────────────

/** 长按判定窗（ms）：触屏惯例时长，具名常量防 magic-number */
const LONG_PRESS_MS = 500

/** 菜单目标（null = 菜单关闭） */
const menuSession = ref<SessionSummary | null>(null)

let longPressTimer: ReturnType<typeof setTimeout> | null = null
let suppressNextClick = false

function openMenu(session: SessionSummary): void {
  menuSession.value = session
}

function closeMenu(): void {
  menuSession.value = null
}

function onItemPointerDown(session: SessionSummary): void {
  clearLongPressTimer()
  longPressTimer = setTimeout(() => {
    longPressTimer = null
    suppressNextClick = true
    openMenu(session)
  }, LONG_PRESS_MS)
}

function onItemPointerUp(): void {
  // 未达长按窗即松手（普通点击）——取消判定，click 正常路由
  clearLongPressTimer()
}

function onItemPointerCancel(): void {
  clearLongPressTimer()
}

function clearLongPressTimer(): void {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

/** 菜单·重新打开（A3）：dead 会话恢复三步编排（restore RPC → 切入链 → revive，app-runtime 出口） */
async function onMenuRestore(): Promise<void> {
  const target = menuSession.value
  closeMenu()
  if (!target) return
  try {
    await restoreSession(target.id)
  } catch (e) {
    // 降级策略：壳级一次性编排失败 console 留痕，不占用错误条单槽（coreChannelDeps.toast
    // 已接错误条承载 core 失败面——A7；对齐 app-runtime.restoreSession 同口径）
    console.error('[session-list] restore failed:', e)
  }
}

/** 菜单·删除（A4）：core deleteSession 销毁唯一编排点（triggerSessionCleanups 全清注册项） */
async function onMenuDelete(): Promise<void> {
  const target = menuSession.value
  closeMenu()
  if (!target) return
  try {
    await deleteSession(target.id)
  } catch (e) {
    // 降级策略：删除失败不产生本地半删态（core 编排在 remove RPC 成功后才清本地），
    // 条目保留可重试；壳级一次性编排失败 console 留痕，不占用错误条单槽
    console.error('[session-list] delete failed:', e)
  }
}

// ── 重命名（A4）─────────────────────────────────────────────────────

const renameOpen = ref(false)
const renameTarget = ref<SessionSummary | null>(null)
const renameLabel = ref('')

function openRename(): void {
  const target = menuSession.value
  closeMenu()
  if (!target) return
  renameTarget.value = target
  renameLabel.value = target.label
  renameOpen.value = true
}

async function onRenameSubmit(): Promise<void> {
  const target = renameTarget.value
  const label = renameLabel.value.trim()
  if (!target || label === '') return
  try {
    await renameSession(target.id, label)
    renameOpen.value = false
  } catch (e) {
    // 降级策略：壳级一次性编排失败 console 留痕，不占用错误条单槽（coreChannelDeps.toast
    // 已接错误条承载 core 失败面——A7）；表单保持打开——标签未变（乐观更新只在 RPC 成功后），用户可直接重试
    console.error('[session-list] rename failed:', e)
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="mobile-session-list">
    <div class="flex shrink-0 items-center justify-between px-3 py-2">
      <span class="text-sm font-medium text-neutral-fg">{{ t('mobile.tabs.sessions') }}</span>
      <Button
        variant="ghost"
        size="icon"
        data-testid="mobile-new-task"
        :aria-label="t('mobile.sessionList.newTask')"
        :title="t('mobile.sessionList.newTask')"
        @click="emit('new-task')"
      >
        <Plus class="size-5" />
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <p
        v-if="loadError"
        data-testid="mobile-session-list-error"
        class="cursor-pointer rounded px-2 py-3 text-sm text-danger"
        role="alert"
        @click="onRetry"
      >
        {{ loadError ?? t('mobile.sessionList.loadFailed') }}
      </p>
      <p v-else-if="items.length === 0" class="px-2 py-6 text-center text-sm text-neutral-dim" data-testid="mobile-session-list-empty">
        {{ t('mobile.sessionList.empty') }}
      </p>
      <ul v-else class="flex flex-col gap-1">
        <SessionListItem
          v-for="item in items"
          :key="item.id"
          :item="item"
          :active="item.id === activeId"
          :derived-status="deriveStatusOf(item)"
          @open="onOpen"
          @pointerdown="onItemPointerDown(item)"
          @pointerup="onItemPointerUp"
          @pointercancel="onItemPointerCancel"
        />
      </ul>
    </div>

    <!-- 动作菜单（长按任意条目 / 点 dead 条目引导；底部 sheet 形态对齐 NewTaskSheet 先例） -->
    <div v-if="menuSession" class="fixed inset-0 z-50 flex flex-col justify-end" data-testid="mobile-session-menu">
      <div class="absolute inset-0 bg-bg/60" data-testid="mobile-session-menu-backdrop" @click="closeMenu" />
      <div class="relative flex flex-col gap-1 rounded-t-lg border-t border-[var(--border)] bg-bg-input p-3" data-testid="mobile-session-menu-sheet">
        <span class="truncate px-2 pb-1 text-sm font-medium text-neutral-fg">{{ menuSession.label }}</span>
        <Button
          v-if="menuSession.status === 'dead'"
          variant="ghost"
          data-testid="mobile-session-menu-restore"
          class="justify-start"
          @click="onMenuRestore"
        >
          {{ t('mobile.sessionList.restore') }}
        </Button>
        <Button variant="ghost" data-testid="mobile-session-menu-rename" class="justify-start" @click="openRename">
          {{ t('mobile.sessionList.menuRename') }}
        </Button>
        <Button variant="ghost" data-testid="mobile-session-menu-delete" class="justify-start" @click="onMenuDelete">
          {{ t('mobile.sessionList.menuDelete') }}
        </Button>
      </div>
    </div>

    <!-- 重命名表单（动作菜单二级；Input 组件，禁原生表单元素） -->
    <div v-if="renameOpen" class="fixed inset-0 z-50 flex flex-col justify-end" data-testid="mobile-session-rename">
      <div class="absolute inset-0 bg-bg/60" data-testid="mobile-session-rename-backdrop" @click="renameOpen = false" />
      <div class="relative flex flex-col gap-3 rounded-t-lg border-t border-[var(--border)] bg-bg-input p-4" data-testid="mobile-session-rename-form">
        <span class="text-sm font-medium text-neutral-fg">{{ t('mobile.sessionList.renameTitle') }}</span>
        <Input
          v-model="renameLabel"
          :placeholder="t('mobile.sessionList.renamePlaceholder')"
          data-testid="mobile-session-rename-input"
          @keyup.enter="onRenameSubmit"
        />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" data-testid="mobile-session-rename-cancel" @click="renameOpen = false">
            {{ t('mobile.newTask.cancel') }}
          </Button>
          <Button data-testid="mobile-session-rename-confirm" @click="onRenameSubmit">
            {{ t('mobile.sessionList.renameConfirm') }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
