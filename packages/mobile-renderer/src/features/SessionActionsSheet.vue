<script setup lang="ts">
// SessionActionsSheet —— 会话长按动作 Sheet（remote-use-mobile-v2 §7.1 会话列表
// 「长按 480ms 动作 Sheet + 删除二次确认态」；§6.13 sheet-manager 单例槽位消费）。
//
// 动作集（M-1 迁移 + F14）：重新打开（仅 dead，恢复三步编排）/ 重命名（Sheet 内二级态，
// rename RPC + 乐观更新）/ 删除（二次确认态 → deleteSessionWithCascade 级联编排）。
//
// 删除二次确认态（spec A9/A10/F11）：确认前不删除；文案含不可逆声明与影响范围
// （「删除会话及其全部对话记录…不可恢复」）。删除经 deleteSessionWithCascade（§7.1
// 删除级联三件：core 销毁编排内摘 lastVisitedAt/丢草稿/摘未读 + 关闭活动 Sheet）。
//
// 长按打开与移动取消手势在 SessionsScreen（打开方），本组件只消费 sheet-manager 槽位：
// 挂载条件 = activeSheet === 'sessionActions'（SessionsScreen 模板条件挂载）；关闭统一走
// closeSheet()（遮罩点击/拖拽关闭由 Sheet 原语 update:open 透传）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Sheet } from '@taiji/ui'
import { Pencil, RotateCcw, Trash2 } from '@lucide/vue'
import type { SessionSummary } from '@taiji/shared'
import {
  renameSession,
  restoreSession,
} from '../shell/app-runtime'
import { deleteSessionWithCascade } from '../shell/sessions-runtime'
import { closeSheet } from '../shell/sheet-manager'

const props = defineProps<{
  /** 动作目标会话（长按行；null 防御性不渲染动作面） */
  session: SessionSummary | null
}>()

const { t } = useI18n()

// ── 内部视图态：动作列表 / 删除确认 / 重命名（Sheet 单槽内推进，不占新槽位——§6.13）──
// 本组件随 sheet-manager 槽位条件挂载（关闭即卸载）：内部视图态天然随重挂载复位到动作
// 列表——同会话再次长按不残留上次的确认态/重命名态，无需显式重置。

type SheetView = 'actions' | 'deleteConfirm' | 'rename'
const view = ref<SheetView>('actions')

const sheetTitle = computed(() => {
  if (view.value === 'deleteConfirm') return t('mobile.sessionActions.deleteConfirmTitle')
  if (view.value === 'rename') return t('mobile.sessionList.renameTitle')
  return props.session?.label ?? ''
})

// ── 重新打开（F14，仅 dead）─────────────────────────────────────────────────

const restoring = ref(false)

async function onRestore(): Promise<void> {
  const target = props.session
  if (!target) return
  restoring.value = true
  try {
    await restoreSession(target.id)
    closeSheet()
  } catch (e) {
    // 降级策略：恢复失败保持 Sheet 在场可重试（失败原因经 core restoreFailed 链呈现），
    // console 留痕不占用错误条单槽（对齐 app-runtime.restoreSession 口径）
    console.error('[session-actions] restore failed:', e)
  } finally {
    restoring.value = false
  }
}

// ── 删除（二次确认态 + 级联）───────────────────────────────────────────────

const deleting = ref(false)

function askDelete(): void {
  view.value = 'deleteConfirm'
}

async function onDelete(): Promise<void> {
  const target = props.session
  if (!target || deleting.value) return
  deleting.value = true
  try {
    await deleteSessionWithCascade(target.id)
    // closeSheet 由级联编排收尾（§7.1 关闭活动 Sheet）；此处不重复调
  } catch (e) {
    // 降级策略：删除失败不产生本地半删态（core 编排在 remove RPC 成功后才清本地），
    // 回动作列表可重试；console 留痕不占用错误条单槽（v1 onMenuDelete 同口径）
    console.error('[session-actions] delete failed:', e)
    view.value = 'actions'
  } finally {
    deleting.value = false
  }
}

// ── 重命名（Sheet 内二级态）───────────────────────────────────────────────

const renaming = ref(false)
const renameLabel = ref(props.session?.label ?? '')

function askRename(): void {
  renameLabel.value = props.session?.label ?? ''
  view.value = 'rename'
}

async function onRenameSubmit(): Promise<void> {
  const target = props.session
  const label = renameLabel.value.trim()
  if (!target || label === '' || renaming.value) return
  renaming.value = true
  try {
    await renameSession(target.id, label)
    closeSheet()
  } catch (e) {
    // 降级策略：重命名失败表单保持打开（乐观更新只在 RPC 成功后，用户可直接重试）；
    // console 留痕不占用错误条单槽（v1 onRenameSubmit 同口径）
    console.error('[session-actions] rename failed:', e)
  } finally {
    renaming.value = false
  }
}
</script>

<template>
  <!-- target 缺失（长按目标未及设置即被关闭等异常时序）防御性整表不渲染 -->
  <Sheet
    v-if="props.session"
    :open="true"
    :title="sheetTitle"
    :description="view === 'deleteConfirm' ? t('mobile.sessionActions.deleteConfirmDescription') : undefined"
    @update:open="(v: boolean) => { if (!v) closeSheet() }"
  >
    <!-- 动作列表态 -->
    <div v-if="view === 'actions'" class="flex flex-col gap-1" data-testid="session-actions-list">
      <Button
        v-if="props.session.status === 'dead'"
        variant="ghost"
        class="justify-start"
        data-testid="session-action-restore"
        :disabled="restoring"
        @click="onRestore"
      >
        <RotateCcw class="size-4" />
        {{ t('mobile.sessionList.restore') }}
      </Button>
      <Button variant="ghost" class="justify-start" data-testid="session-action-rename" @click="askRename">
        <Pencil class="size-4" />
        {{ t('mobile.sessionList.menuRename') }}
      </Button>
      <Button variant="destructive" class="justify-start" data-testid="session-action-delete" @click="askDelete">
        <Trash2 class="size-4" />
        {{ t('mobile.sessionList.menuDelete') }}
      </Button>
    </div>

    <!-- 删除二次确认态（A9/A10：确认前不删除；文案含不可逆声明与影响范围——description 行） -->
    <div v-else-if="view === 'deleteConfirm'" class="flex flex-col gap-3" data-testid="session-delete-confirm">
      <p class="text-sm text-neutral-fg" data-testid="session-delete-confirm-target">
        {{ t('mobile.sessionActions.deleteConfirmTarget', { label: props.session.label }) }}
      </p>
      <div class="flex gap-2">
        <Button variant="ghost" class="flex-1" data-testid="session-delete-cancel" @click="view = 'actions'">
          {{ t('mobile.newTask.cancel') }}
        </Button>
        <Button
          variant="destructive"
          class="flex-1"
          data-testid="session-delete-confirm-button"
          :disabled="deleting"
          @click="onDelete"
        >
          {{ t('mobile.sessionActions.deleteConfirm') }}
        </Button>
      </div>
    </div>

    <!-- 重命名态（Input 组件，禁原生表单元素） -->
    <form v-else class="flex flex-col gap-3" data-testid="session-rename-form" @submit.prevent="onRenameSubmit">
      <Input v-model="renameLabel" :placeholder="t('mobile.sessionList.renamePlaceholder')" data-testid="session-rename-input" />
      <div class="flex gap-2">
        <Button type="button" variant="ghost" class="flex-1" data-testid="session-rename-cancel" @click="view = 'actions'">
          {{ t('mobile.newTask.cancel') }}
        </Button>
        <Button type="submit" class="flex-1" data-testid="session-rename-confirm" :disabled="renaming">
          {{ t('mobile.sessionList.renameConfirm') }}
        </Button>
      </div>
    </form>
  </Sheet>
</template>
