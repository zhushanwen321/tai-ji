<template>
  <!--
    展示组件 · 会话列表（子视图 A，draft-five-states 卡 A/D）。
    按 cwd 分组渲染（D7：对齐后端 SessionGroup[]）—— 每组一个标题（cwd 末段）+ 组内 SessionItem 列表。
    【D14 语义修正 2026-08-04】按 activeProject 过滤 session（session.projectId，cwd 只是展示聚合）：
    命名 project → 只显示归属它的 session（同 cwd 组内可混合不同归属，逐 session 过滤）；
    默认项目 → 未归类（无 projectId）+ 孤儿（归属的 project 已删除）聚合。
    ScrollArea 包裹；空态（D，session 数=0）显示极淡「暂无会话」占位。
    v-model 语义用 activeId（单向：子→父 select）。
  -->
  <ScrollArea class="session-list h-full">
    <div class="flex flex-col px-1">
      <div
        v-for="g in visibleGroups"
        :key="g.cwd"
        class="group-section flex flex-col gap-0.5"
      >
        <!-- 组标题：cwd 末段（长路径只显末段防溢出，与 SessionItem.dirName 同一信息原子）。
             sticky 贴顶用 bg-bg 不透明（侧边栏底色透明融合 bg，header 同色遮住滚过的 item 文字）。
             group/folder 命名 group 只放在 header 行上（本容器**不能**带 group/folder——Tailwind
             命名 group 是「任意层级祖先」匹配，容器带它会令 hover 组内任意 SessionItem 时也触发
             folder 按钮，破坏单行独立 hover 语义）。 -->
        <div class="group/folder sticky top-0 z-[1] flex items-center gap-1.5 bg-bg px-2 pb-0.5 pt-1">
          <Folder class="size-[11px] shrink-0 text-neutral-dim" />
          <span class="truncate text-[length:var(--text-3xs)] font-medium text-neutral-dim">
            {{ dirNameOf(g.cwd) }}
          </span>
          <span class="font-mono text-[length:var(--text-3xs)] text-neutral-dim opacity-60">{{ g.sessions.length }}</span>
          <!-- folder 行操作区：+ 新建（非破坏性，恒渲染）与批量删除（两段式确认）。
               容器 ml-auto 右贴 + hover 显隐；[review MF-2] 删除按钮仅当组内可见数 = 该 cwd 全量数时渲染：
               removeByCwd 是 cwd 全量删除（项目无关），项目过滤隐藏了部分 session 时点删除会误删
               用户不可见的其他 project session；+ 按钮无此守卫（新建不受过滤影响）。 -->
          <div
            class="ml-auto flex items-center gap-1"
            :class="folderConfirmingCwd === g.cwd ? '' : 'opacity-0 group-hover/folder:opacity-100'"
            @mouseleave="onFolderMouseLeave(g.cwd)"
          >
            <Button
              variant="ghost"
              size="icon"
              data-testid="folder-new-session-btn"
              class="size-[22px] rounded-sm border border-border-strong bg-surface text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
              :title="t('sidebar.sessionList.newSessionInFolder')"
              @click.stop="emit('newSessionInFolder', g.cwd)"
            >
              <Plus class="size-[13px]" />
            </Button>
            <Button
              v-if="isFolderDeleteAvailable(g.cwd)"
              variant="ghost"
              size="icon"
              data-testid="folder-delete-btn"
              :class="folderConfirmingCwd === g.cwd
                ? 'size-[22px] rounded-sm border border-danger bg-danger text-neutral-fg'
                : 'size-[22px] rounded-sm border border-border-strong bg-surface text-neutral-mid hover:bg-surface-hover hover:text-danger'"
              :title="folderConfirmingCwd === g.cwd
                ? t('sidebar.sessionList.deleteFolderConfirm')
                : t('sidebar.sessionItem.delete')"
              @click.stop="onFolderRemoveClick(g.cwd)"
            >
              <Check v-if="folderConfirmingCwd === g.cwd" class="size-[13px]" />
              <Trash2 v-else class="size-[13px]" />
            </Button>
          </div>
        </div>
        <!-- 每条 session 渲染 SessionItem（扁平列表：fork 分支 / agent 子会话均按一般 session 各占一行，
             侧栏不做父子聚合——D9；父条目右侧徒标承载子会话计数）。 -->
        <SessionItem
          v-for="s in g.sessions"
          :key="s.id"
          :session="s"
          :active="s.id === activeId"
          :status="statusOf(s.id)"
          :child-count="childCountOf(s)"
          :parent-label="parentLabelOf(s)"
          @select="emit('select', $event)"
          @rename="emit('rename', $event)"
          @delete="emit('delete', $event)"
          @set-project="emit('setProject', $event)"
          @navigate-parent="emit('navigateParent', $event)"
          @abort="emit('abort', $event)"
          @force-quit="emit('forceQuit', $event)"
        />
      </div>
    </div>
    <div
      v-if="totalCount === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center"
    >
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.sessionList.empty') }}</p>
      <Button
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 rounded-md px-2 text-[length:var(--text-2xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
        @click="emit('newSession')"
      >
        <Plus class="size-[14px]" />
        {{ t('sidebar.sessionList.newSession') }}
      </Button>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import type { DerivedStatus } from '@/types'
import { computed, provide, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, Folder, Trash2, Check } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { dirNameOf } from '@taiji/ui'
import { collectNamedProjectIds, sessionBelongsToProject } from '@/composables/logic/project-session'
import { isSessionCompleted } from '@/composables/logic/sessionStatus'
import { useProjectStore } from '@/stores/project'
import SessionItem from './SessionItem.vue'

const { t } = useI18n()
const projectStore = useProjectStore()

const props = defineProps<{
  /** 按 cwd 分组的会话（D7，对齐后端 SessionGroup[]） */
  groups: SessionGroup[]
  activeId: string | null
  /** 派生状态点（D6），由容器注入 useSessionDerivations.derivedStatus */
  statusOf: (id: string) => DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
  newSession: []
  /** 目录行「+」：以该 cwd 为预选目录进 landing 新建（延迟 create，由 Sidebar 调 newSession(cwd)） */
  newSessionInFolder: [cwd: string]
  /** 停止运行中的 session（软停止，SessionItem 两段确认后调 abort → stopped，可 restore） */
  abort: [sessionId: string]
  /** 删除指定 cwd 下所有 session（folder 维度批量删除，两段式确认后由 Sidebar 调 deleteFolder） */
  deleteFolder: [cwd: string]
  /** 归入项目（D14 语义修正）：透传 SessionItem 的 setProject */
  setProject: [{ sessionId: string; projectId: string }]
  /** 查看父 session（agent-managed-session U8）：透传 SessionItem 的 navigateParent，
   *  跳转接线（select 该父 session）由上层 Sidebar/store 完成。 */
  navigateParent: [parentAgentSessionId: string]
  /** 强制退出（两段确认后）：透传 SessionItem 的 forceQuit，Sidebar 接 sessionApi.forceQuit */
  forceQuit: [sessionId: string]
}>()

/**
 * 按 activeProject 过滤后的分组（D14 语义修正 2026-08-04，SSOT 见 shared/project.ts）。
 *
 * 过滤粒度是 **session 级**：同一 cwd 组内可混合不同归属的 session（project 可跨目录，
 * 同一目录下不同 session 可服务不同 project），按 session.projectId 逐条匹配后重组分组。
 *
 * 过滤规则本体已提取到 sessionBelongsToProject（composables/logic/project-session.ts SSOT），
 * ProjectSwitcher 徽章计数消费同一函数——保证徽章数字与点击后本列表实际显示数恒一致。
 *
 * 过滤后无匹配 → totalCount=0 走空态（「暂无会话」+ 新建按钮）。
 */
const visibleGroups = computed<SessionGroup[]>(() => {
  const pid = projectStore.activeProjectId
  const isDefault = projectStore.isDefaultProject
  const knownIds = collectNamedProjectIds(projectStore.projects)
  const matches = (s: SessionGroup['sessions'][number]): boolean =>
    sessionBelongsToProject(s, pid, isDefault, knownIds)
  return props.groups
    .map((g) => ({ cwd: g.cwd, sessions: g.sessions.filter(matches) }))
    .filter((g) => g.sessions.length > 0)
})

/** 全部 session 总数（空态判定，跨组汇总） */
const totalCount = computed(() =>
  visibleGroups.value.reduce((sum, g) => sum + g.sessions.length, 0),
)

/**
 * folder 删除可用性（review MF-2）：组内可见 session 数 < 该 cwd 全量 session 数时隐藏删除按钮。
 * 项目过滤按 session.projectId 逐条过滤（同 cwd 跨项目是模型常态），而 deleteFolder →
 * api.removeByCwd(cwd) 是项目无关的全量删除——过滤态下删除会连带删掉不可见的 session，
 * 且 header 计数（过滤后）会误导「删 1 个实际删 N 个」。全量数从未过滤的 props.groups 取，
 * 不改 runtime removeByCwd 语义。
 */
function isFolderDeleteAvailable(cwd: string): boolean {
  const total = props.groups.find((g) => g.cwd === cwd)?.sessions.length ?? 0
  const visible = visibleGroups.value.find((g) => g.cwd === cwd)?.sessions.length ?? 0
  return total === visible
}

/**
 * 子会话计数（D9 中性计数徒标）：按 parentAgentSessionId 分组计数（零新协议，纯内存推导）。
 * 口径 = **未完成数**（判据见 sessionStatus.ts 的 isSessionCompleted）：绿点（idle/done）
 * 不予计入，active / error / stopped / dead 都算——与徒标「还有多少未完成」的阅读预期一致，
 * 不再显示子会话总数。
 * 取可见分组（visibleGroups）计数——徒标与屏幕上实际可扫读的行保持一致（项目过滤下不会
 * 报出不可见子会话）。fork 分支走 parentSession 血缘，不计数：它已在扁平列表逐行可见，
 * 无需计数补偿（只有 agent 子会话在 project 视图下可能被遗漏）。
 */
const childCountByParent = computed<Map<string, number>>(() => {
  const counts = new Map<string, number>()
  for (const g of visibleGroups.value) {
    for (const s of g.sessions) {
      const parent = s.parentAgentSessionId
      if (!parent) continue
      if (isSessionCompleted(s.status)) continue
      counts.set(parent, (counts.get(parent) ?? 0) + 1)
    }
  }
  return counts
})

/** 取某 session 的未完成子会话数（0 = 无未完成子会话，徒标不渲染） */
function childCountOf(s: SessionSummary): number {
  return childCountByParent.value.get(s.id) ?? 0
}

/**
 * 反查分支 session 的父 session label（P3 修复血缘显示）。
 *
 * SessionItem 模板用 `session.parentLabel || session.parentSession` 展示血缘，但此前 SessionList
 * 从未传 parentLabel → 实际显示 parentSession（文件路径或 UUID，不可读）。本 helper 按
 * session.parentSession 反查父 session，取其 label 注入 parentLabel。
 *
 * 匹配规则（FR-20 双键兜底）：parentSession 可能是父的 sessionFile（活跃 session
 * 落盘路径）或父的 id（源未落盘时用 sessionId 作血缘键），两种 key 取并集保证命中。
 * 仅在当前 session 所在组内查找（分支与父同 cwd，不需跨组扫描）；无父（parentSession 空）或
 * 父不在当前分组返回空串，SessionItem 回退到 parentSession 原值。
 */
function parentLabelOf(s: SessionSummary): string {
  if (!s.parentSession) return ''
  const parent = visibleGroups.value
    .filter((g) => g.cwd === s.cwd)
    .flatMap((g) => g.sessions)
    .find((p) => p.sessionFile === s.parentSession || p.id === s.parentSession)
  return parent?.label ?? ''
}

/** 单一 Esc 监听器——避免每个 SessionItem 各自注册 window keydown listener（N 项 N 个监听器）。
 *  SessionItem inject 后 watch escCount 变化清自身确认态。 */
const escCount = ref(0)
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') escCount.value++
})
provide('sessionItemEsc', escCount)

/**
 * folder 维度删除的两段式确认态（与 SessionItem.confirming 同范式）。
 * 存当前确认的 cwd（同时只允许一个 folder 处于确认态）；二次点击同 cwd 才 emit deleteFolder。
 * Esc / mouseleave / 点击外部（onClickOutside）复位——folder 按钮直接用本组件持有的 escCount
 * 同源 ref，不需 inject（SessionList 是 provide 源头）。
 */
const folderConfirmingCwd = ref<string | null>(null)
function onFolderRemoveClick(cwd: string): void {
  if (folderConfirmingCwd.value !== cwd) {
    folderConfirmingCwd.value = cwd
    return
  }
  folderConfirmingCwd.value = null
  emit('deleteFolder', cwd)
}
/** 鼠标离开 folder 按钮区域时复位确认态（与 Esc 同源，防止误确认） */
function onFolderMouseLeave(cwd: string): void {
  if (folderConfirmingCwd.value === cwd) folderConfirmingCwd.value = null
}
watch(escCount, () => {
  if (folderConfirmingCwd.value) folderConfirmingCwd.value = null
})

/**
 * S4：点击 folder 确认按钮外部时复位确认态（与 SessionItem.onClickOutside 同范式）。
 * folder 标题行处于 v-for 循环（多个 folder），不便逐项挂 onClickOutside ref，故用
 * 单一 window pointerdown 监听（pointerdown 先于 click，比 click 更早收口确认态）。
 *
 * 同级 folder 按钮冲突规避：点击另一 folder 的删除按钮时，该按钮的 @click.stop 会切
 * folderConfirmingCwd 到新 cwd。若此处无条件复位 '' 会覆盖新值。故只在「点击目标不在任何
 * folder 删除按钮内」时复位——新 cwd 的切换由 onFolderRemoveClick 自行处理，互不干扰。
 * 用 [data-testid="folder-delete-btn"] 锚定 folder 删除按钮（S5 前置 testid），与 SessionItem
 * 的 session 删除按钮 testid 区分。
 */
useEventListener(window, 'pointerdown', (e: PointerEvent) => {
  if (!folderConfirmingCwd.value) return
  const target = e.target as Element | null
  if (target?.closest('[data-testid="folder-delete-btn"]')) return
  folderConfirmingCwd.value = null
})

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
</script>
