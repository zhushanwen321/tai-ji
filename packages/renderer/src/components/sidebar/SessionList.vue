<template>
  <!--
    展示组件 · 会话列表（R6.2 锚定分组形态，demo Sidebar.vue sessions 视图权威）。
    区头「项目与会话」+ 总会话计数 + 双段模式开关，下方为：
    - 默认项目区（用户裁决 2026-10-13 方案 A）：默认项目 = 未归类收件箱，不展示项目框——
      平铺模式 = 置顶平铺会话区（无组头/无左线/无缩进）；目录模式 = 置顶目录标签序列
      （无组头包裹）。空区不渲染；锚定/新建/拖放入口 = DefaultProjectHead 轻量头行
      （点行锚定默认项目 +「+」在此新建 + session drop 落点）。
    - 命名项目组：保持 ProjectGroup 框（组头 + 左线 + 缩进）。两种模式的展开态都按组
      独立记忆（多项目同开）：平铺模式点组头 = 切换锚定并展开目标组（其余组开合不动，
      点当前组头 = 折叠/展开翻转），锚定只决定新会话归属与「当前」chip；目录模式 =
      浏览态：全部组默认展开，组头只开合自己、不切换锚定，「当前」chip 只读；组内按
      cwd 目录静态标签分组（SessionDirLabel，与默认项目目录区共用同一实现）。目录行
      悬停操作（目录内新建 / 批量删除）为 real 独有功能性入口。
    - session 拖拽移动归属（落点 = 各组头 + 默认头行）：useSessionDropTarget 统一交互
      （types 命中判别 + dropActive 高亮），drop 走既有 setProject 事件链（同归属 no-op），
      落折叠组后强制展开。
    分组规则 SSOT = sessionBelongsToProject（默认项目聚合未归类 + 孤儿）；组序 SSOT =
    projectStore.orderedProjects（lastUsedAt 稳定序 + 默认项目固定最后，锚定切换不重排；
    默认区置顶是纯视图层拆分，不改组序）。组内平铺序 = runtime 组序展平。
    新建项目入口 = 区头行内「+」钮（紧贴模式开关左侧，用户裁决 2026-10-11）：点击后列表
    顶部出现草稿输入行，Enter 确认 → 锚定新项目并展开空态（空名 / Esc 丢弃草稿）。
    空命名组显示「暂无会话，点组头「+」在此新建任务」（缩进对齐左线内侧）。
  -->
  <div class="session-list flex h-full min-h-0 flex-col">
    <!-- 区头（demo .sess-head：gap 6px / padding 8px 10px 5px；lbl 12px mid、count mono 11px fg-2、
         右侧模式开关 = .mode-seg 凹陷槽）。固定于 ScrollArea 外（不随列表滚动）。 -->
    <div class="flex shrink-0 items-center gap-[6px] px-[10px] pt-[8px] pb-[5px]" data-testid="session-list-header">
      <span class="truncate text-[length:var(--text-xs)] text-neutral-mid">
        {{ t('sidebar.sessionList.header') }}
      </span>
      <span class="font-mono text-[length:var(--text-2xs)] text-neutral-fg-2">{{ totalCount }}</span>
      <!-- 右侧工具组（用户裁决 2026-10-11）：新建项目「+」紧贴模式开关（组内 gap 2px，
           组整体 ml-auto 承接右贴）。新建项目入口 = 区头「+」→ 列表顶部草稿行（见列表容器首行），
           不再使用区头内联输入。
           [session-archive D10] 归档入口插在「+」与模式开关之间：Package 图标 +
           archiveCount 角标（count 0 隐藏，按钮仍可点——空归档列表有引导空态）。 -->
      <div class="ml-auto flex items-center gap-[2px]">
        <Button
          variant="ghost"
          size="icon"
          data-testid="project-add-btn"
          class="grid size-[24px] place-items-center rounded-[var(--radius-xs)] p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[13px]"
          :title="t('sidebar.projectGroup.newProject')"
          :aria-label="t('sidebar.projectGroup.newProject')"
          @click="startCreate"
        >
          <Plus :stroke-width="1.8" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="sidebar-archive-entry-btn"
          class="relative grid size-[24px] place-items-center rounded-[var(--radius-xs)] p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[13px]"
          :title="t('sidebar.archiveEntry.title', { count: archiveCount })"
          :aria-label="t('sidebar.archiveEntry.title', { count: archiveCount })"
          @click="emit('openArchives')"
        >
          <Package :stroke-width="1.8" />
          <!-- 计数角标（D10：count 0 隐藏；>0 右上角 accent 圆形 mono 小字，99 封顶） -->
          <span
            v-if="archiveCount > 0"
            data-testid="sidebar-archive-count-badge"
            class="absolute -right-[3px] -top-[3px] grid min-w-[14px] place-items-center rounded-full bg-accent px-[3px] font-mono text-[9px] leading-[14px] text-neutral-fg"
          >{{ archiveCount > 99 ? '99+' : archiveCount }}</span>
        </Button>
        <!-- A/C 双段图标开关（demo .mode-seg：surface 槽 + hairline 边 + 26×24 钮 + 13px 图标）：
             选中态 = demo Tier A 状态件范式（--sel-bg accent tint 底 + fg 字 + 1px --sel-edge 内描边）。
             title 承载模式名（无 label 文字，demo 悬停提示范式）。 -->
        <div class="flex items-center rounded-sm border border-hairline bg-surface p-[2px]">
          <Button
            variant="ghost"
            size="icon"
            data-testid="session-mode-flat"
            class="h-[24px] w-[26px] rounded-[var(--radius-xs)] p-0"
            :class="mode === 'flat'
              ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
              : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
            :title="t('sidebar.sessionList.modeFlat')"
            :aria-pressed="mode === 'flat'"
            @click="setMode('flat')"
          >
            <List class="size-[13px]" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="session-mode-groups"
            class="h-[24px] w-[26px] rounded-[var(--radius-xs)] p-0"
            :class="mode === 'groups'
              ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
              : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
            :title="t('sidebar.sessionList.modeGroup')"
            :aria-pressed="mode === 'groups'"
            @click="setMode('groups')"
          >
            <Folder class="size-[13px]" :stroke-width="1.8" />
          </Button>
        </div>
      </div>
    </div>

    <ScrollArea ref="listScrollArea" class="min-h-0 flex-1">
    <!-- 顶缘渐焦（spec sidebar §3.1：三视图滚动容器接 EdgeFade）：滚动宿主显式传入
         （reka 封装在挂载点与真滚动 viewport 之间有内部 wrapper），显隐/mask 仍自驱动，
         reduced-transparency 降级纯色渐隐 -->
    <EdgeFade :scroller-el="listScrollerEl" />
    <div class="flex flex-col pt-0.5 pb-2 pl-1.5">
      <!-- 新建项目草稿行（用户裁决 2026-10-11：区头「+」点击后，列表顶部出现新组输入态；
           Enter / 失焦提交非空名 → 创建并锚定展开，空名 / Esc 丢弃草稿不创建） -->
      <div v-if="creating" class="flex items-center px-[6px] py-[5px]" data-testid="project-draft-row">
        <Input
          ref="createInputRef"
          v-model="draft"
          data-testid="project-create-input"
          class="min-w-0 flex-1 h-[24px] rounded-[5px] border-border-strong bg-bg-input px-[7px] text-[length:var(--text-xs)] text-neutral-fg"
          :placeholder="t('sidebar.projectGroup.namePlaceholder')"
          :aria-label="t('sidebar.projectGroup.newProject')"
          @keydown.enter.prevent="commitCreate"
          @keydown.esc.stop.prevent="cancelCreate"
          @blur="onDraftBlur"
        />
      </div>
      <!-- 平铺模式：默认项目平铺区（置顶）+ 命名项目锚定分组 -->
      <template v-if="mode === 'flat'">
        <!-- 默认项目平铺区（用户裁决 2026-10-13 方案 A）：默认项目 = 未归类收件箱，
             不展示项目组框（无组头/无左线/无缩进），session 直接平铺在列表顶部；
             空区不渲染。命名项目组照旧（锚定展开 + 折叠一行）。 -->
        <div
          v-if="defaultZone && defaultZone.items.length"
          class="flex flex-col"
          data-testid="default-project-flat-zone"
        >
          <!-- 默认项目轻量头行（锚定/新建/drop 落点入口；有会话才渲染，与空区不渲染一致） -->
          <DefaultProjectHead
            :current="projectStore.isDefaultProject"
            :name="defaultZone.name"
            @anchor="onAnchorDefault"
            @create-task="onCreateTaskIn(defaultZone)"
            @drop-session="onDropToDefault"
          />
          <SessionItem
            v-for="s in defaultZone.items"
            :key="s.id"
            :session="s"
            :active="s.id === activeId"
            :status="statusOf(s.id)"
            :child-count="childCountOf(s)"
            :parent-label="parentLabelOf(s)"
            :restored-highlight="s.id === restoredSessionId"
            @select="emit('select', $event)"
            @rename="emit('rename', $event)"
            @archive="emit('archive', $event)"
            @set-project="emit('setProject', $event)"
            @navigate-parent="emit('navigateParent', $event)"
            @abort="emit('abort', $event)"
            @force-quit="emit('forceQuit', $event)"
            @export-jsonl="emit('exportJsonl', $event)"
          />
        </div>
        <!-- 命名项目组（多开：每組开合独立记忆，点组头切锚定并展开目标组、其余组不动；
             「当前」chip 标识锚定组。会话行缩进（demo .pgi .si）：行内左距 9px 与目录标签
             对齐；作用到 ProjectGroup 槽内直接子 .session-item（任意变体替代 scoped 后代
             选择器） -->
        <ProjectGroup
          v-for="pg in namedGroups"
          :key="pg.id"
          :project-id="pg.id"
          :name="pg.name"
          :count="pg.items.length"
          :current="pg.id === projectStore.activeProjectId"
          :expanded="!flatClosed.has(pg.id)"
          :is-default="pg.isDefault"
          class="[&>.session-item]:pl-[9px]"
          @head-click="onGroupHeadClick(pg)"
          @create-task="onCreateTaskIn(pg)"
          @rename-commit="onRenameCommit(pg, $event)"
          @delete-request="requestDelete(pg)"
          @drop-session="onDropToGroup(pg, $event)"
        >
          <SessionItem
            v-for="s in pg.items"
            :key="s.id"
            :session="s"
            :active="s.id === activeId"
            :status="statusOf(s.id)"
            :child-count="childCountOf(s)"
            :parent-label="parentLabelOf(s)"
            :restored-highlight="s.id === restoredSessionId"
            @select="emit('select', $event)"
            @rename="emit('rename', $event)"
            @archive="emit('archive', $event)"
            @set-project="emit('setProject', $event)"
            @navigate-parent="emit('navigateParent', $event)"
            @abort="emit('abort', $event)"
            @force-quit="emit('forceQuit', $event)"
            @export-jsonl="emit('exportJsonl', $event)"
          />
          <div
            v-if="!pg.items.length"
            class="pt-[2px] pb-[6px] pl-[9px] pr-[8px] text-[length:var(--text-2xs)] text-neutral-dim"
            data-testid="project-group-empty"
          >
            {{ t('sidebar.sessionList.groupEmpty') }}
          </div>
        </ProjectGroup>
      </template>
      <!-- 目录模式：默认项目目录区（置顶，无组框）+ 命名项目组（浏览态） -->
      <template v-else>
        <!-- 默认项目：无组头，轻量头行（锚定/新建/drop 入口，同平铺模式）+ 目录标签直接
             平铺在列表顶部（用户裁决 2026-10-13：默认项目不展示项目 item；目录模式下同样
             不给框，标签自描述无需包裝） -->
        <template v-if="defaultZone">
          <DefaultProjectHead
            v-if="defaultZone.items.length"
            :current="projectStore.isDefaultProject"
            :name="defaultZone.name"
            @anchor="onAnchorDefault"
            @create-task="onCreateTaskIn(defaultZone)"
            @drop-session="onDropToDefault"
          />
          <template v-for="g in defaultZone.dirs" :key="g.cwd">
            <SessionDirLabel
              :cwd="g.cwd"
              :count="g.sessions.length"
              :confirming="folderConfirmingCwd === g.cwd"
              :delete-available="isFolderDeleteAvailable(defaultZone, g.cwd)"
              @new-in-folder="emit('newSessionInFolder', $event)"
              @remove-click="onFolderRemoveClick"
              @leave="onFolderMouseLeave"
            />
            <div class="gi">
              <SessionItem
                v-for="s in g.sessions"
                :key="s.id"
                :session="s"
                :active="s.id === activeId"
                :status="statusOf(s.id)"
                :child-count="childCountOf(s)"
                :parent-label="parentLabelOf(s)"
                :restored-highlight="s.id === restoredSessionId"
                @select="emit('select', $event)"
                @rename="emit('rename', $event)"
                @archive="emit('archive', $event)"
                @set-project="emit('setProject', $event)"
                @navigate-parent="emit('navigateParent', $event)"
                @abort="emit('abort', $event)"
                @force-quit="emit('forceQuit', $event)"
                @export-jsonl="emit('exportJsonl', $event)"
              />
            </div>
          </template>
        </template>
        <!-- 命名项目组：全部默认展开，组头只开合不切换锚定 + 目录静态标签分组。
             目录内会话行再深一级（demo .pgi .gi .si = 21px），任意变体替代 scoped 后代选择器 -->
        <ProjectGroup
          v-for="pg in namedGroups"
          :key="pg.id"
          :project-id="pg.id"
          :name="pg.name"
          :count="pg.items.length"
          :current="pg.id === projectStore.activeProjectId"
          :expanded="!dirClosed.has(pg.id)"
          :is-default="pg.isDefault"
          class="[&_.gi>.session-item]:pl-[21px]"
          @head-click="onGroupHeadClick(pg)"
          @create-task="onCreateTaskIn(pg)"
          @rename-commit="onRenameCommit(pg, $event)"
          @delete-request="requestDelete(pg)"
          @drop-session="onDropToGroup(pg, $event)"
        >
          <div
            v-if="!pg.items.length"
            class="pt-[2px] pb-[6px] pl-[9px] pr-[8px] text-[length:var(--text-2xs)] text-neutral-dim"
            data-testid="project-group-empty"
          >
            {{ t('sidebar.sessionList.groupEmpty') }}
          </div>
          <template v-else>
            <!-- 目录静态标签（SessionDirLabel，与默认项目目录区共用同一实现）：
                 group/folder 命名 group 在标签行组件内（Tailwind 命名 group 是「任意层级祖先」
                 匹配，容器带它会令 hover 组内任意 SessionItem 时也触发 folder 按钮，
                 破坏单行独立 hover 语义）。 -->
            <div v-for="g in pg.dirs" :key="g.cwd" class="grp">
              <SessionDirLabel
                :cwd="g.cwd"
                :count="g.sessions.length"
                :confirming="folderConfirmingCwd === g.cwd"
                :delete-available="isFolderDeleteAvailable(pg, g.cwd)"
                @new-in-folder="emit('newSessionInFolder', $event)"
                @remove-click="onFolderRemoveClick"
                @leave="onFolderMouseLeave"
              />
              <!-- 目录内会话行（再深一级缩进）：每条 session 渲染 SessionItem（扁平列表：
                   fork 分支 / agent 子会话均按一般 session 各占一行，侧栏不做父子聚合——D9）。 -->
              <div class="gi">
                <SessionItem
                  v-for="s in g.sessions"
                  :key="s.id"
                  :session="s"
                  :active="s.id === activeId"
                  :status="statusOf(s.id)"
                  :child-count="childCountOf(s)"
                  :parent-label="parentLabelOf(s)"
                  :restored-highlight="s.id === restoredSessionId"
                  @select="emit('select', $event)"
                  @rename="emit('rename', $event)"
                  @archive="emit('archive', $event)"
                  @set-project="emit('setProject', $event)"
                  @navigate-parent="emit('navigateParent', $event)"
                  @abort="emit('abort', $event)"
                  @force-quit="emit('forceQuit', $event)"
                  @export-jsonl="emit('exportJsonl', $event)"
                />
              </div>
            </div>
          </template>
        </ProjectGroup>
      </template>

    </div>
  </ScrollArea>

    <!-- 删除项目二次确认（文案写明后果，spec sidebar §3.7：「N 个会话将归回默认项目」；
         计数 = 该组实际会话数——数字 = 实际归回的会话数） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('sidebar.projectGroup.deleteTitle')"
      :description="t('sidebar.projectGroup.deleteDesc', {
        name: pendingDelete?.name || t('sidebar.projectGroup.defaultName'),
        count: pendingDelete?.items.length ?? 0,
      })"
      :confirm-text="t('sidebar.projectGroup.deleteConfirm')"
      :cancel-text="t('sidebar.projectGroup.cancel')"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import type { DerivedStatus } from '@/types'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, Folder, List, Package } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EdgeFade } from '@/components/ui/edge-fade'
import { isSessionCompleted } from '@/composables/logic/sessionStatus'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { useProjectGroups, type ProjectGroupVM } from '@/composables/features/sidebar/useProjectGroups'
import { useSidebarSessionMode } from '@/composables/features/sidebar/use-sidebar-session-mode'
import ProjectGroup from './ProjectGroup.vue'
import DefaultProjectHead from './DefaultProjectHead.vue'
import SessionDirLabel from './SessionDirLabel.vue'
import SessionItem from './SessionItem.vue'

const { t } = useI18n()
const projectStore = useProjectStore()

const props = withDefaults(defineProps<{
  /** 按 cwd 分组的会话（对齐后端 SessionGroup[]，全量、不预过滤——分组归属在本组件按项目切分） */
  groups: SessionGroup[]
  activeId: string | null
  /** 派生状态点，由容器注入 useSessionDerivations.derivedStatus */
  statusOf: (id: string) => DerivedStatus
  /**
   * 归档条目数（session-archive D10 归档入口角标数据源）：config.sessions 广播帧携带值
   * / 归档列表拉取对账（store.archiveCount 经 Sidebar 注入）。0 = 角标隐藏，按钮仍可点。
   * 可选缺省 0（既有测试挂载不传时角标隐藏的默认形态）。
   */
  archiveCount?: number
  /**
   * 刚恢复的 session id（session-archive §5.1 恢复高亮：unarchive reply 消费点，经
   * Sidebar 从 archive store 注入；null = 无恢复高亮）。置顶构造性成立（恢复重写主文件
   * → mtime = 恢复时刻 → 组内第一），本字段只驱动行 accent-soft 高亮渐隐。
   */
  restoredSessionId?: string | null
}>(), { archiveCount: 0, restoredSessionId: null })

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  /**
   * 归档（session-archive D6）：SessionItem 悬停归档钮两段确认后透传——Sidebar 接
   * useSidebarSessionActions.onArchiveSession（useSidebar.archiveSession core 编排）。
   */
  archive: [sessionId: string]
  newSession: []
  /** 打开归档列表视图（D10 工具组归档入口钮；Sidebar 接 useArchiveView.openArchiveView） */
  openArchives: []
  /** 目录行「+」：以该 cwd 为预选目录进 landing 新建（延迟 create，由 Sidebar 调 newSession(cwd)） */
  newSessionInFolder: [cwd: string]
  /** 停止运行中的 session（软停止，SessionItem 两段确认后调 abort → stopped，可 restore） */
  abort: [sessionId: string]
  /** 删除指定 cwd 下所有 session（folder 维度批量删除，两段式确认后由 Sidebar 调 deleteFolder） */
  deleteFolder: [cwd: string]
  /** 归入项目（D14 语义修正）：透传 SessionItem 的 setProject */
  setProject: [{ sessionId: string; projectId: string }]
  /** 查看父 session（agent-managed-session U8）：透传 SessionItem 的 navigateParent */
  navigateParent: [parentAgentSessionId: string]
  /** 强制退出（两段确认后）：透传 SessionItem 的 forceQuit，Sidebar 接 sessionApi.forceQuit */
  forceQuit: [sessionId: string]
  /** 导出 JSONL：透传 SessionItem 的 exportJsonl，
   *  Sidebar 接 exportSessionJsonl IPC + toast。 */
  exportJsonl: [payload: { sessionId: string; sessionFile?: string; suggestedName?: string }]
}>()

// 滚动宿主（EdgeFade scrollerEl）：reka ScrollArea 在 slot 内容与真滚动 viewport 之间有
// 内部 content wrapper，parentElement 探测不成立——从 ScrollArea expose 显式取 viewport 元素
//（expose 链两层解包：ScrollArea.viewportEl（自动解包的 ref）→ Viewport 实例.viewportElement）
const listScrollArea = ref<{ viewportEl: { viewportElement: HTMLElement } | null } | null>(null)
const listScrollerEl = ref<HTMLElement | undefined>(undefined)
onMounted(() => {
  listScrollerEl.value = listScrollArea.value?.viewportEl?.viewportElement ?? undefined
})


/**
 * 子会话计数（D9 中性计数徒标）：按 parentAgentSessionId 分组计数（零新协议，纯内存推导）。
 * 口径 = **未完成数**（判据见 sessionStatus.ts 的 isSessionCompleted）：绿点（idle/done）
 * 不予计入，active / error / stopped / dead 都算。取全量 groups 计数——锚定分组形态下
 * 全部会话行都已挂载（折叠组体常驻 DOM），跨项目的 agent 子会话同样可见可数。
 */
const childCountByParent = computed<Map<string, number>>(() => {
  const counts = new Map<string, number>()
  for (const g of props.groups) {
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
 * SessionItem 模板用 `session.parentLabel || session.parentSession` 展示血缘，本 helper 按
 * session.parentSession 反查父 session，取其 label 注入 parentLabel。
 *
 * 匹配规则（FR-20 双键兜底）：parentSession 可能是父的 sessionFile（活跃 session
 * 落盘路径）或父的 id（源未落盘时用 sessionId 作血缘键），两种 key 取并集保证命中。
 * 仅在当前 session 所在 cwd 组内查找（分支与父同 cwd）；无父或父不在同组返回空串，
 * SessionItem 回退到 parentSession 原值。
 */
function parentLabelOf(s: SessionSummary): string {
  if (!s.parentSession) return ''
  const parent = props.groups
    .filter((g) => g.cwd === s.cwd)
    .flatMap((g) => g.sessions)
    .find((p) => p.sessionFile === s.parentSession || p.id === s.parentSession)
  return parent?.label ?? ''
}

/**
 * folder 删除可用性（review MF-2，项目分组版）：该 cwd 在**此项目分组内**的可见 session 数
 * < 该 cwd 全量 session 数时隐藏删除按钮。removeByCwd 是 cwd 全量删除（项目无关）——
 * 同一 cwd 的 session 可散布在多个项目分组（按 session.projectId 逐条切分），任一分组内
 * 只显示子集；仅当某分组恰好包含该 cwd 全量会话时点删除才不会连带删掉不可见 session。
 */
function isFolderDeleteAvailable(pg: ProjectGroupVM, cwd: string): boolean {
  const total = props.groups.find((g) => g.cwd === cwd)?.sessions.length ?? 0
  const visible = pg.dirs.find((g) => g.cwd === cwd)?.sessions.length ?? 0
  return total > 0 && total === visible
}

/** 单一 Esc 监听器——避免每个 SessionItem 各自注册 window keydown listener（N 项 N 个监听器）。
 *  SessionItem inject 后 watch escCount 变化清自身确认态。 */
const escCount = ref(0)
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') escCount.value++
})
provide('sessionItemEsc', escCount)

/** 后代 SessionItem 删除确认态登记槽（§6.7 后行档聚合谓词的读点来源）：
 *  每个 SessionItem 把自己的 confirming ref 注入本集合，卸载即撤。聚合谓词直读各 ref 当前值
 *  （动作时刻新鲜度），不经 escCount 反向推导——广播计数器单调递增、非状态本体（§6.7 禁绑）。 */
const itemConfirmingSet = new Set<Ref<boolean>>()
provide('sessionItemConfirmingSet', itemConfirmingSet)

/**
 * folder 维度删除的两段式确认态（与 SessionItem.confirming 同范式）。
 * 存当前确认的 cwd（同时只允许一个 folder 处于确认态）；二次点击同 cwd 才 emit deleteFolder。
 * Esc / mouseleave / 点击外部复位。
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

// ── A/C 双模式（N8 延续：flat = 锚定聚焦 / groups = 目录浏览态；类型来自 useProjectGroups）──

/** 模式开关抽 composable（use-sidebar-session-mode，持久化键与恢复逻辑随迁）；切模式实际发生后的联动复位经回调留在本组件 */
const { mode, setMode } = useSidebarSessionMode(() => {
  folderConfirmingCwd.value = null
})

// ── 项目分组派生与动作（useProjectGroups：归属切分 / 组序 / 锚定交互 / 新建草稿流 /
//    重命名与删除确认态；切模式复位 folderConfirmingCwd 的联动保留在本组件 setMode）──
const {
  projectGroups,
  totalCount,
  flatClosed,
  dirClosed,
  expandGroup,
  onGroupHeadClick,
  onCreateTaskIn,
  deleteOpen,
  pendingDelete,
  requestDelete,
  confirmDelete,
  onRenameCommit,
  creating,
  draft,
  createInputRef,
  startCreate,
  commitCreate,
  onDraftBlur,
  cancelCreate,
} = useProjectGroups({
  groups: () => props.groups,
  mode,
  onNewSession: () => emit('newSession'),
})

// ── 默认项目头行交互 + session 拖拽落点（拖到组头/默认行 = 移动归属，走既有 setProject 链）──

/** 点默认头行主体：锚定切回默认项目（修复「锚定一旦落到命名项目即无法新建到默认区」死角） */
function onAnchorDefault(): void {
  projectStore.setActiveProject(DEFAULT_PROJECT_ID)
}

/** drop 落点统一写入口：同归属 no-op（防自拖自落 + 省一次 RPC），否则透传既有 setProject
 *  事件链（Sidebar → assignSessionToProject → RPC + 乐观更新），拖拽与右键菜单同一写通道 */
function assignDropped(projectId: string, sessionId: string): void {
  const session = props.groups.flatMap((g) => g.sessions).find((s) => s.id === sessionId)
  if ((session?.projectId ?? '') === projectId) return
  emit('setProject', { sessionId, projectId })
}

/** 拖入命名组头：移动归属 + 强制展开目标组（落折叠组后会话直接可见，不消失） */
function onDropToGroup(pg: ProjectGroupVM, sessionId: string): void {
  assignDropped(pg.id, sessionId)
  expandGroup(pg.id)
}

/** 拖入默认头行：归回未归类聚合（projectId 空串语义，assign-targets 同口径） */
function onDropToDefault(sessionId: string): void {
  assignDropped('', sessionId)
}

/**
 * 默认项目区 vs 命名项目组（用户裁决 2026-10-13 方案 A：默认项目不展示项目框）。
 * 默认项目 = 未归类收件箱：平铺模式渲染为置顶平铺区（无组头/左线/缩进），目录模式
 * 渲染为置顶目录标签序列（无组头包裹）；命名项目组保持 ProjectGroup 框。组序 SSOT
 * 不动（orderedProjects 默认项目仍固定最后），拆分纯视图层：区置顶 = 渲染位置，
 * 非重排。锚定/新建/drop 入口由 DefaultProjectHead 轻量头行承载（不恢复项目框）。
 */
const defaultZone = computed(() => projectGroups.value.find((pg) => pg.isDefault))
const namedGroups = computed(() => projectGroups.value.filter((pg) => !pg.isDefault))

watch(escCount, () => {
  if (folderConfirmingCwd.value) folderConfirmingCwd.value = null
})

/**
 * 点击 folder 确认按钮外部时复位确认态（与 SessionItem.onClickOutside 同范式）。
 * folder 标题行处于 v-for 循环（多个 folder），不便逐项挂 onClickOutside ref，故用
 * 单一 window pointerdown 监听（pointerdown 先于 click，比 click 更早收尾确认态）。
 *
 * 同级 folder 按钮冲突规避：点击另一 folder 的删除按钮时，该按钮的 @click.stop 会切
 * folderConfirmingCwd 到新 cwd。若此处无条件复位会覆盖新值。故只在「点击目标不在任何
 * folder 删除按钮内」时复位——新 cwd 的切换由 onFolderRemoveClick 自行处理，互不干扰。
 */
useEventListener(window, 'pointerdown', (e: PointerEvent) => {
  if (!folderConfirmingCwd.value) return
  const target = e.target as Element | null
  if (target?.closest('[data-testid="folder-delete-btn"]')) return
  folderConfirmingCwd.value = null
})

/** 删除确认态聚合谓词（§6.7 后行档开合态绑定源 = 确认态本体）：
 *  N 个 SessionItem 后代确认态 与 folderConfirmingCwd。任一确认态开着 ⇒ 入聚合让位族
 *  （yieldsEsc=true，见 modal-surface-registry 登记表），编排器 Esc 不动作、由本组件 escCount
 *  链路清确认态——一次 Esc 只清确认不动容器，第二次 Esc 才走层级序。 */
const anyDeleteConfirming = (): boolean =>
  folderConfirmingCwd.value !== null || [...itemConfirmingSet].some((confirming) => confirming.value)

const disposeSurfaceRegistration = registerModalSurface({
  surface: 'session-delete-confirm',
  key: 'session-list-delete-confirm',
  isOpen: anyDeleteConfirming,
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>

