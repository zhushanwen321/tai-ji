<script setup lang="ts">
/**
 * ProjectSwitcher —— ProjectSwitcher 3A：2 列卡片网格（形态权威见 git 历史 project-switcher-demo.html 变体 3A 单行 pill，
 * 原 docs/page-design/ 已退役）+ 1 步点击切换 + 拖拽/键盘排序（D7/D8）。
 *
 * 形态（demo 3A）：单行 pill 卡（26px）= 项目名（截断 + title 全名兜底）+ 会话数徽章；
 * 网格尾部「新建」卡（点击展开内联 Input，Enter/blur 提交、Esc 取消）。
 *
 * 排序（D7，2026-09-02 语义修正）：卡片顺序完全由用户控制——有 userOrder 升序在前，
 * 无 userOrder 按创建/持久化序稳定在后；点击切换不改顺序（active/lastUsedAt 不参与
 * 排序）。drop 与方向键（←→↑↓，focus 后）调用 store.reorderProject 同一入口，
 * 提交时对整个列表密集重编号 0..n-1。
 *
 * 拖拽（D8）：原生 HTML5 DnD（draggable + dragstart/dragover/drop）——全仓零 dnd 库依赖
 * （@dnd-kit 是 React 库，Vue 不可用，设计已裁决）。
 *
 * 徽章：computeProjectSessionCounts 与 SessionList 过滤共用 sessionBelongsToProject
 * 规则 SSOT——徽章数字 = 点击该卡后 SessionList 实际显示的会话数；默认项目计入
 * 未归类 + 孤儿 session。
 *
 * 删除：demo 3A 卡片无删除按钮（26px 单行放不下），保留既有删除能力走右键 ContextMenu
 * （reka 原语，SessionItem 同范式）→ ConfirmDialog 确认；默认项目卡不渲染删除项
 * （review MF-1 双保险，与 store.removeProject 守卫一致）。
 *
 * 数据层：session 按 projectId 直接关联过滤（SSOT 见 shared/project.ts）；列表持久化
 * runtime projects.json（deep watch → 全量 save，userOrder 随之持久化，跨重启稳定）。
 */
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { Plus, Trash2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
} from 'reka-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useProjectStore } from '@/stores/project'
import { useSessionStore } from '@/stores/session'
import { computeProjectSessionCounts } from '@/composables/logic/project-session'

const { t } = useI18n()
const projectStore = useProjectStore()
const sessionStore = useSessionStore()

// ── 徽章计数（与 SessionList 过滤同一规则 SSOT）──
const sessionCounts = computed(() =>
  computeProjectSessionCounts(sessionStore.groups, projectStore.projects),
)

function displayName(p: { name: string }): string {
  return p.name || t('sidebar.projectSwitcher.defaultName')
}

function select(id: string) {
  projectStore.setActiveProject(id)
}

// ── 原生 HTML5 DnD（D8；拖拽与键盘共用 reorderProject 单一入口）──
const dragId = ref<string | null>(null)
const overId = ref<string | null>(null)

function onDragStart(e: DragEvent, id: string) {
  dragId.value = id
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, id: string) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  overId.value = id
}

function onDragLeave(id: string) {
  if (overId.value === id) overId.value = null
}

function onDrop(e: DragEvent, id: string) {
  e.preventDefault()
  overId.value = null
  if (dragId.value) projectStore.reorderProject(dragId.value, id)
  dragId.value = null
}

function onDragEnd() {
  dragId.value = null
  overId.value = null
}

// ── 键盘 reorder（D8 键盘可达性）：focus 卡片后 ↑/← 与前一位交换、↓/→ 与后一位交换，
//    与 drop 走同一 reorderProject；v-for 以 project.id 为 key，交换后元素复用焦点不丢。
function moveCard(id: string, delta: -1 | 1) {
  const order = projectStore.recentProjects
  const idx = order.findIndex((p) => p.id === id)
  const neighbor = order[idx + delta]
  if (!neighbor) return
  projectStore.reorderProject(id, neighbor.id)
}

// ── 删除流（右键菜单 → ConfirmDialog variant=danger；默认项目卡不渲染菜单）──
const deleteOpen = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = computed(
  () => projectStore.projects.find((p) => p.id === pendingDeleteId.value)?.name ?? '',
)

function canDelete(p: { name: string }): boolean {
  return Boolean(p.name) && projectStore.projects.length > 1
}

function requestDelete(id: string) {
  pendingDeleteId.value = id
  deleteOpen.value = true
}

function confirmDelete() {
  if (pendingDeleteId.value) projectStore.removeProject(pendingDeleteId.value)
  pendingDeleteId.value = null
  deleteOpen.value = false
}

// ── 新建流（网格尾部 add 卡 / Input 互斥；Esc 取消 / Enter、blur 提交）──
const creating = ref(false)
const draft = ref('')
const inputRef = ref<ComponentPublicInstance | null>(null)

function startCreate() {
  creating.value = true
  draft.value = ''
  nextTick(() => {
    // Input 组件根元素是 <input>，template ref 拿到组件实例，$el 是 input DOM
    const el = inputRef.value?.$el
    if (el instanceof HTMLInputElement) el.focus()
  })
}

function commitCreate() {
  const name = draft.value.trim()
  if (name) projectStore.addProject(name)
  creating.value = false
  draft.value = ''
}

function cancelCreate() {
  creating.value = false
  draft.value = ''
}
</script>

<template>
  <div class="mb-1 mx-1" data-testid="project-switcher">
    <!-- 2 列卡片网格（demo 3A：gap 4px / 单行 pill 26px / radius-sm） -->
    <div class="grid grid-cols-2 gap-1" data-testid="project-grid">
      <template v-for="p in projectStore.recentProjects" :key="p.id">
        <!-- 右键菜单（删除入口；默认项目卡无菜单项 → Portal 条件渲染，不吞右键） -->
        <ContextMenuRoot>
          <ContextMenuTrigger as-child>
            <!-- 卡片：div role=button（旧列表项同范式，避免 button 嵌套 input/触发器）；
                 active 态沿用侧栏既有范式 bg-surface + text-accent（SessionItem/旧列表一致）。 -->
            <div
              role="button"
              tabindex="0"
              draggable="true"
              data-testid="project-card"
              :data-project-id="p.id"
              class="flex h-[26px] min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-sm border px-2 text-[length:var(--text-xs)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
              :class="[
                p.id === projectStore.activeProjectId
                  ? 'border-transparent bg-surface text-accent'
                  : 'border-transparent text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg',
                dragId === p.id ? 'opacity-45' : '',
                overId === p.id && dragId !== p.id ? 'border-accent border-dashed' : '',
              ]"
              :title="displayName(p)"
              :aria-label="displayName(p)"
              @click="select(p.id)"
              @keydown.enter="select(p.id)"
              @dragstart="onDragStart($event, p.id)"
              @dragover="onDragOver($event, p.id)"
              @dragleave="onDragLeave(p.id)"
              @drop="onDrop($event, p.id)"
              @dragend="onDragEnd"
              @keydown.up.prevent="moveCard(p.id, -1)"
              @keydown.left.prevent="moveCard(p.id, -1)"
              @keydown.down.prevent="moveCard(p.id, 1)"
              @keydown.right.prevent="moveCard(p.id, 1)"
            >
              <span class="min-w-0 flex-1 truncate text-left" data-testid="project-card-name">
                {{ displayName(p) }}
              </span>
              <!-- 会话数徽章：规则与 SessionList 过滤共享（SSOT），数字 = 点击后列表实际条数 -->
              <span
                data-testid="project-card-count"
                class="flex-none rounded-full px-[5px] text-center text-[length:var(--text-3xs)] leading-[15px]"
                :class="
                  p.id === projectStore.activeProjectId
                    ? 'bg-surface-hover text-accent'
                    : 'bg-surface-hover text-neutral-dim'
                "
              >
                {{ sessionCounts.get(p.id) ?? 0 }}
              </span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuPortal v-if="canDelete(p)">
            <ContextMenuContent
              data-testid="project-context-menu"
              class="z-[1100] min-w-[160px] rounded-md border border-border-strong bg-bg-elevated p-1 text-neutral-fg shadow-2 outline-none"
            >
              <ContextMenuItem
                data-testid="project-delete-item"
                class="flex h-auto w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[length:var(--text-xs)] text-danger/90 outline-none hover:bg-danger-soft hover:text-danger [&_svg]:size-[13px]"
                @select="requestDelete(p.id)"
              >
                <Trash2 />
                <span>{{ t('sidebar.projectSwitcher.deleteProject') }}</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenuPortal>
        </ContextMenuRoot>
      </template>

      <!-- 新建：add 卡 / 内联 Input 互斥（Esc 取消 / Enter、blur 提交） -->
      <Input
        v-if="creating"
        ref="inputRef"
        v-model="draft"
        data-testid="project-create-input"
        class="h-[26px] rounded-sm border-border-strong bg-bg-input px-2 text-[length:var(--text-xs)] text-neutral-fg"
        :placeholder="t('sidebar.projectSwitcher.namePlaceholder')"
        @keydown.enter.prevent="commitCreate"
        @keydown.esc.prevent="cancelCreate"
        @blur="commitCreate"
      />
      <Button
        v-else
        variant="ghost"
        type="button"
        data-testid="project-add-btn"
        class="h-[26px] w-full justify-center gap-1 rounded-sm border border-dashed border-border-strong text-[length:var(--text-xs)] text-neutral-dim [&_svg]:size-3"
        @click="startCreate"
      >
        <Plus class="shrink-0" />
        <span>{{ t('sidebar.projectSwitcher.newProject') }}</span>
      </Button>
    </div>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('sidebar.projectSwitcher.deleteTitle')"
      :description="t('sidebar.projectSwitcher.deleteDesc', { name: pendingDeleteName || t('sidebar.projectSwitcher.defaultName') })"
      :confirm-text="t('sidebar.projectSwitcher.deleteConfirm')"
      :cancel-text="t('sidebar.projectSwitcher.cancel')"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>
