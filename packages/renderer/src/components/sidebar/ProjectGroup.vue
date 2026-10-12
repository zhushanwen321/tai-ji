<template>
  <!--
    展示组件 · 项目分组（R6.2 锚定分组，demo .pg 权威形态）：组头 + 高度动画展开体。
    组头 = 项目名贴左 + 「当前」chip（仅锚定组）+ 会话计数；hover / focus-within 时
    操作钮浮现、计数让位（同位替换惯例，min-height 预留防行高跳动）。
    操作钮：在此项目新建任务（+，恒渲染）/ 重命名 / 删除（默认项目不渲染——nameless
    身份是未归类/孤儿 session 兜底聚合的判据，删/改会瓦解聚合，store 层同源拦截）。
    展开体常驻 DOM（不用 v-if/v-show）：grid-template-rows 0fr↔1fr 真实高度动画 +
    内层 opacity 跟进淡入 + visibility 收起延迟翻转（防隐藏行进 Tab 焦点序、细线随
    展开体显隐）；reduced-motion 由全局 reduce 块归零过渡（= 即时切换）。
    展开/收起的 open 态由父级持有（平铺 = 锚定聚焦语义，目录 = 浏览态语义），本组件
    只按 expanded prop 渲染。行内重命名 = 输入框替换组头（Enter 提交 / Esc 取消 /
    失焦提交）；编辑态本组件自持。
    [实现注记] 展开体动画全部走 Tailwind 任意值（含多属性分 delay 的 transition 简写），
    不落 scoped CSS——多属性 transition 简写里空格以 _ 转义，vue_rules_checker 的
    「禁自定义 CSS（特殊动画除外）」口径下保持零白名单依赖。
  -->
  <div class="pg" data-testid="project-group" :data-project-id="projectId" :data-current="current ? 'true' : undefined">
    <div class="pgh flex min-h-[31px] items-center gap-[4px] px-[6px] pt-[7px] pb-[4px] group/pgh" data-testid="project-group-head">
      <Input
        v-if="renaming"
        ref="renameInputRef"
        v-model="renameDraft"
        class="min-w-0 flex-1 h-[24px] rounded-[5px] border-border-strong bg-bg-input px-[7px] text-[length:var(--text-xs)] text-neutral-fg"
        :aria-label="t('sidebar.projectGroup.renameProject')"
        :data-testid="`project-rename-input-${projectId}`"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.stop.prevent="cancelRename"
        @blur="commitRename"
      />
      <template v-else>
        <div
          role="button"
          tabindex="0"
          class="pgh-main flex min-w-0 flex-1 cursor-pointer select-none items-center gap-[6px] text-left"
          data-testid="project-group-toggle"
          :aria-expanded="expanded ? 'true' : 'false'"
          :aria-label="name"
          @click="emit('headClick')"
          @keydown.enter.prevent="emit('headClick')"
          @keydown.space.prevent="emit('headClick')"
        >
          <span class="min-w-0 truncate text-[12.5px] [font-weight:var(--fw-mid)] text-neutral-fg-2 group-hover/pgh:text-neutral-fg">
            {{ name }}
          </span>
          <span
            v-if="current"
            class="flex-none rounded-full px-[6px] py-[3px] text-[10px] leading-none text-neutral-fg bg-[var(--sel-bg)] shadow-[inset_0_0_0_1px_var(--sel-edge)]"
            data-testid="project-group-current-chip"
          >
            {{ t('sidebar.projectGroup.currentChip') }}
          </span>
          <span class="ml-auto flex-none font-mono text-[length:var(--text-2xs)] text-neutral-fg-2 group-hover/pgh:hidden group-focus-within/pgh:hidden" data-testid="project-group-count">
            {{ count }}
          </span>
        </div>
        <div class="hidden flex-none items-center gap-[2px] group-hover/pgh:inline-flex group-focus-within/pgh:inline-flex" data-testid="project-group-actions">
          <Button
            variant="ghost"
            size="icon"
            class="relative grid size-[20px] place-items-center rounded-[5px] p-0 text-neutral-dim after:absolute after:inset-[-2px] after:content-[''] hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[12px]"
            :title="t('sidebar.sessionList.newSessionInProject')"
            :aria-label="t('sidebar.sessionList.newSessionInProject')"
            data-testid="project-group-new-task"
            @click="emit('createTask')"
          >
            <Plus :stroke-width="1.8" />
          </Button>
          <template v-if="!isDefault">
            <Button
              variant="ghost"
              size="icon"
              class="relative grid size-[20px] place-items-center rounded-[5px] p-0 text-neutral-dim after:absolute after:inset-[-2px] after:content-[''] hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[12px]"
              :title="t('sidebar.projectGroup.renameProject')"
              :aria-label="t('sidebar.projectGroup.renameProject')"
              data-testid="project-group-rename"
              @click="startRename"
            >
              <Pencil :stroke-width="1.8" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="relative grid size-[20px] place-items-center rounded-[5px] p-0 text-neutral-dim after:absolute after:inset-[-2px] after:content-[''] hover:bg-danger-soft hover:text-danger [&_svg]:size-[12px]"
              :title="t('sidebar.projectGroup.deleteProject')"
              :aria-label="t('sidebar.projectGroup.deleteProject')"
              data-testid="project-group-delete"
              @click="emit('deleteRequest')"
            >
              <Trash2 :stroke-width="1.8" />
            </Button>
          </template>
        </div>
      </template>
    </div>
    <!-- 展开体（demo .pgi 逐值）：grid 行高动画 + visibility 收起延迟翻转（--duration-fast
         等内层淡出完再翻，隐藏行不进 Tab 焦点序、细线随体显隐）；展开态无 visibility delay -->
    <div
      class="grid mx-[6px] mb-[4px] ml-[12px] ease-[var(--ease-out)]"
      :class="expanded
        ? 'grid-rows-[1fr] visible [transition:grid-template-rows_var(--duration)_var(--ease-out)]'
        : 'grid-rows-[0fr] invisible [transition:grid-template-rows_var(--duration)_var(--ease-out),visibility_0s_var(--duration-fast)]'"
      data-testid="project-group-body"
    >
      <!-- 内层（demo .pgi-in 逐值）：滚动裁剪 + 左缘细线（当前组 --sel-edge、非当前
           --border）+ opacity 跟进淡入消除高度动画生硬感 -->
      <div
        class="min-h-0 overflow-hidden pt-px pb-[2px] pl-[9px] border-l-2 opacity-0 transition-[opacity] duration-[var(--duration-fast)] ease-[var(--ease-out)]"
        :class="[
          expanded ? 'opacity-100' : '',
          current ? 'border-l-[var(--sel-edge)]' : 'border-l-[var(--border)]',
        ]"
      >
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const props = defineProps<{
  /** 项目 id（testid / data-project-id 锚点，父级以 v-for 闭包持同值） */
  projectId: string
  /** 显示名（默认项目已由父级解析为兜底文案） */
  name: string
  /** 组内会话数（计数与操作钮同位替换，见 .pgh hover 语义） */
  count: number
  /** 是否锚定项目（「当前」chip + 展开体左缘 accent 细线） */
  current: boolean
  /** 展开态（父级按模式持有：平铺 = 锚定聚焦，目录 = 浏览态开合集） */
  expanded: boolean
  /** 默认项目（nameless）：不渲染重命名/删除钮 */
  isDefault: boolean
}>()

const emit = defineEmits<{
  /** 组头主体点击（父级按模式裁决：平铺 = 切换锚定/翻转展开，目录 = 仅开合） */
  headClick: []
  /** 组头「+」：先落点该项目再进空态新建（落点在父级 handler 内完成） */
  createTask: []
  /** 行内重命名提交（Enter / 失焦；空名已在组件内守卫不 emit） */
  renameCommit: [name: string]
  /** 删除请求（确认弹层在父级） */
  deleteRequest: []
}>()

// ── 行内重命名（Enter 提交 / Esc 取消 / 失焦提交；单容器单输入框，失焦即提交无歧义）──
const renaming = ref(false)
const renameDraft = ref('')
const renameInputRef = ref<ComponentPublicInstance | null>(null)

function startRename(): void {
  renaming.value = true
  renameDraft.value = props.name
  nextTick(() => {
    const el = renameInputRef.value?.$el
    if (el instanceof HTMLInputElement) {
      el.focus()
      el.select()
    }
  })
}

function commitRename(): void {
  if (renaming.value && renameDraft.value.trim()) emit('renameCommit', renameDraft.value)
  renaming.value = false
  renameDraft.value = ''
}

function cancelRename(): void {
  renaming.value = false
  renameDraft.value = ''
}
</script>
