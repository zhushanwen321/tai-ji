<script setup lang="ts">
/**
 * ProjectSelectChip —— landing 态归属项目选择 chip（用户裁决 2026-10-22，需求：
 * landing 页标注当前创建的 session 属于哪个 project + 可下拉选择；置于 PresetSelectChip 右侧）。
 *
 * 范式参考 PresetSelectChip（同位 chip 行，Popover 下拉 + selected 单选语义 + 互斥态由父组件
 * flow 状态机驱动）。差异（简化面，均有意为之）：
 * - 无「设为默认」Checkbox：归属语义 = 本次创建落点（pending），全局锚定仍由侧栏组头承担
 *   （用户裁决 2026-10-22：landing 下拉选择只影响本次创建，不切换侧栏锚定）。
 * - 无三档退化密度：项目名短（同目录 chip 截断策略，max-w + truncate 收窄）。
 *
 * 三态（由 props.sessionId + props.projectId 派生，与 PresetSelectChip 同构）：
 * 1. landing 态（sessionId=null）：Popover 可展开，列项目（PopoverListItem selected 单选）。
 *    回显 = flow.pendingProjectId（显式选择档，单一真源在 core flow）> activeProjectId
 *    （锚定归属档）——与 submit 侧消费同一真源，「显示 ≡ 生效」由构造成立。
 * 2. 已创建态（sessionId!=null + projectId 有值）：Lock 图标 + 项目名 + HoverCard tooltip
 *    「此会话归属 {项目名}」。不展开 Popover。
 * 3. 历史会话（sessionId!=null + projectId undefined）：Lock 图标 + 「默认项目」+ HoverCard
 *    加注「（历史会话，未记录归属）」。无值读取侧统一兜底默认项目（shared SessionSummary 契约）。
 *
 * 互斥：Popover 展开态由父组件经 v-model:projectOpen 透传（Landing 的 isProjectOpen 绑
 * flow.state==='project-popover'，与 dir/branch/preset popover 共享 NewTaskFlowState 单实例
 * 状态机互斥）。组件本身不读 flow 状态——只声明 projectOpen prop + emit update:projectOpen。
 *
 * 显示名解析：Project.name 空串 = 默认项目（未命名兜底聚合，project store 契约）→ 统一
 * 「默认项目」文案；projects 里找不到 id（已删除项目的历史 session）→ 回落 id 本体不崩。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Folder, Lock } from '@lucide/vue'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：new-task 组件经顶层 barrel
// 再导出，顶层 barrel 自引用会封住循环依赖环（R2 S-1）
import { Button } from '../../primitives/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card'
import { Popover, PopoverContent, PopoverTrigger, PopoverListItem } from '../../primitives/popover'
import { useNewTaskDeps } from './new-task-deps'

const props = defineProps<{
  /** 绑定的 session id（landing 态为 null） */
  sessionId: string | null
  /** 已创建 session 的归属 project id（SessionSummary.projectId）。undefined = 历史会话（未记录归属） */
  projectId?: string
  /**
   * Popover 展开态（仅 landing 态用）。由父组件经 v-model:projectOpen 透传，派生自
   * NewTaskFlowState==='project-popover'，与 dir/branch/preset popover 共享 flow 单实例
   * 状态机互斥。组件只声明 + emit update，不读 flow 状态（flow 耦合在 Landing.vue）。
   */
  projectOpen: boolean
}>()

const emit = defineEmits<{
  /** landing 态用户真实点击选定归属项目变化（session.create 透传用，单参数对象） */
  select: [{ projectId: string }]
  /** v-model:projectOpen 同步（Popover 内部 open 变化回传父组件） */
  'update:projectOpen': [boolean]
}>()

const { t } = useI18n()
// ?. 防御：部分测试 mock 的 deps.flow 是简化形态（无 pendingProjectId 字段，同
// PresetSelectChip pendingPreset 通道先例）——缺失时显式档恒 null，回落锚定归属档。
const { projects, activeProjectId, flow } = useNewTaskDeps()

// ── 三态派生（与 PresetSelectChip 同构）──
const isLanding = computed(() => props.sessionId == null)
const isLegacy = computed(() => props.sessionId != null && props.projectId == null)

/** 项目显示名：name 空串（默认项目）→「默认项目」文案；找不到 id → 回落 id 本体不崩。 */
function projectNameOf(id: string | null | undefined): string {
  if (!id) return t('newTask.projectSelect.defaultProject')
  const p = projects.value.find((x) => x.id === id)
  if (!p) return id
  return p.name || t('newTask.projectSelect.defaultProject')
}

/**
 * landing 态 chip 回显 id：flow.pendingProjectId（显式选择档，submit 透传真值）>
 * activeProjectId（锚定归属档）。直接读 flow 真源，无本地副本——无 PresetSelectChip 的
 * 「组件生命周期与 pending 生命周期不同构须 watch 同步」问题（本组件无本地输入态）。
 */
const displayProjectId = computed(
  () => flow.pendingProjectId?.value ?? activeProjectId.value,
)
const displayName = computed(() => projectNameOf(displayProjectId.value))

/** 锁定态/历史态显示名：归属项目名 / 默认项目（未记录归属兜底）。 */
const lockedName = computed(() => projectNameOf(props.projectId))

/** 锁定态 tooltip 文案（已创建态 + 历史态分别拼接，与 PresetSelectChip 同构）。 */
const lockedTooltip = computed(() => {
  const base = t('newTask.projectSelect.projectLockedTooltip', { name: lockedName.value })
  if (isLegacy.value) {
    return `${base}${t('newTask.projectSelect.legacySessionTooltip')}`
  }
  return base
})

/** landing 态用户真实点击选定归属项目（emit select → 父组件写 flow.setPendingProject）。 */
function onSelectProject(projectId: string): void {
  emit('select', { projectId })
}
</script>

<template>
  <!-- landing 态：Popover 可选归属项目（互斥同 PresetSelectChip：open 态由父 v-model:projectOpen 驱动） -->
  <Popover v-if="isLanding" :open="projectOpen" @update:open="$emit('update:projectOpen', $event)">
    <PopoverTrigger as-child>
      <Button
        data-testid="chip-project"
        variant="ghost"
        class="h-auto min-h-6 min-w-0 shrink gap-1.5 rounded-sm px-2 py-[3px] font-normal text-[length:var(--text-xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-3.5"
        :aria-label="t('newTask.projectSelect.ariaLabel', { name: displayName })"
        :title="displayName"
      >
        <Folder class="shrink-0" />
        <span class="max-w-[110px] min-w-0 truncate font-mono">{{ displayName }}</span>
        <ChevronDown class="ml-px shrink-0 transition-transform duration-200" :class="projectOpen && 'rotate-180'" />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" :collision-padding="8" :side-offset="10" class="w-[280px] p-0">
      <!-- head：与 PresetSelectChip 头部同款（透明背景 + border-b 分割，mono 小字大写） -->
      <div
        class="flex items-center justify-between border-b border-hairline px-2 pt-1.5 pb-1 font-mono text-[length:var(--text-3xs)] tracking-[0.08em] uppercase text-neutral-dim"
      >
        <span>{{ t('newTask.projectSelect.title') }}</span>
      </div>
      <!-- 项目列表（PopoverListItem selected 单选语义，与 PresetSelectChip 同范式；数据源 =
           projectStore.orderedProjects 渲染序，与侧栏组序一致）。点击已选项 = 保持不变（selected
           单选语义，与预设列表一致——不提供「取消选择」入口：归属恒有落点，显式档可随时改选）。 -->
      <PopoverListItem
        v-for="p in projects"
        :key="p.id"
        :test-id="`project-option-${p.id}`"
        :selected="displayProjectId === p.id"
        @click="onSelectProject(p.id)"
      >
        <span class="min-w-0 truncate text-neutral-fg">{{ p.name || t('newTask.projectSelect.defaultProject') }}</span>
      </PopoverListItem>
    </PopoverContent>
  </Popover>

  <!-- 锁定态 / 历史会话态：Lock 图标 + 项目名 + HoverCard tooltip -->
  <HoverCard v-else :open-delay="200">
    <HoverCardTrigger as-child>
      <Button
        data-testid="chip-project-locked"
        variant="ghost"
        class="h-auto cursor-default gap-1.5 px-2 py-[3px] text-[length:var(--text-xs)] text-neutral-dim hover:bg-transparent hover:text-neutral-dim [&_svg]:size-3.5"
      >
        <Lock class="shrink-0" />
        <span class="max-w-[110px] truncate font-mono">{{ lockedName }}</span>
      </Button>
    </HoverCardTrigger>
    <HoverCardContent side="top" class="max-w-[280px] px-2.5 py-1.5 text-[length:var(--text-2xs)] text-neutral-mid">
      {{ lockedTooltip }}
    </HoverCardContent>
  </HoverCard>
</template>
