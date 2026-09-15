<template>
  <!--
    SessionItem hover ghost 操作子块（spec §3 SessionItem hover 帧）：
    markDone / 引用到输入区 / rename / 归入项目 Popover / 删除两段确认（仅确认态 UI）。
    两段确认的状态在主组件（reset 通道：根 div mouseleave / watch active / Esc / onClickOutside
    的锚点都在主组件），经 v-model:confirming 双向；markDone 与引用动作在本组件内闭环
    （toggle 模块级 markers 集合、写 composerInjectionStore），Display 的 unread/icon 响应式跟随。
  -->
  <!-- 位置 bottom-right（遮 meta 而非 dirName，与 demo 对齐）；删除走两段式确认。 -->
  <div
    class="absolute bottom-0.5 right-1 gap-0.5"
    :class="confirming ? 'flex' : 'flex opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100'"
  >
    <Button
      v-if="!confirming"
      variant="ghost"
      size="icon"
      data-testid="mark-done-btn"
      class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
      :class="markedDone ? 'text-success' : ''"
      :title="markedDone ? t('sidebar.sessionItem.unmarkDone') : t('sidebar.sessionItem.markDone')"
      @click.stop="onMarkDone"
    >
      <Archive class="size-[13px]" :class="markedDone ? 'fill-current' : ''" />
    </Button>
    <Button
      v-if="!confirming"
      variant="ghost"
      size="icon"
      data-testid="quote-to-composer-btn"
      class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
      :title="t('sidebar.sessionItem.quoteToComposer')"
      @click.stop="onQuoteToComposer"
    >
      <Quote class="size-[13px]" />
    </Button>
    <Button
      v-if="!confirming"
      variant="ghost"
      size="icon"
      class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
      :title="t('sidebar.sessionItem.rename')"
      @click.stop="emit('rename', session.id)"
    >
      <Pencil class="size-[13px]" />
    </Button>
    <!-- 归入项目（D14 语义修正 2026-08-04）：Popover 菜单列全部 project，点击即归类。
         归类可逆（可再点其他 project / 默认项目），无需两段确认。 -->
    <Popover v-if="!confirming" :open="assignOpen" @update:open="assignOpen = $event">
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          data-testid="assign-project-btn"
          class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          :title="t('sidebar.sessionItem.assignToProject')"
          @click.stop="assignOpen = true"
        >
          <FolderKanban class="size-[13px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" :collision-padding="8" class="w-44 p-1">
        <div class="flex flex-col gap-px">
          <!-- 默认项目项 id=''：未归类 session 的 projectId 是 undefined，必须归一为空串才能命中高亮（review S-2） -->
          <Button
            v-for="p in assignTargets"
            :key="p.id"
            variant="ghost"
            data-testid="assign-project-option"
            class="h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-[length:var(--text-xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
            :class="(session.projectId || '') === p.id ? 'text-accent' : ''"
            @click="onAssign(p.id)"
          >
            <span
              class="size-2 shrink-0 rounded-full"
              :class="(session.projectId || '') === p.id ? 'bg-accent' : 'bg-transparent'"
            />
            <span class="truncate">{{ p.name || t('sidebar.projectSwitcher.defaultName') }}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
    <Button
      variant="ghost"
      size="icon"
      :class="confirming
        ? 'size-[22px] rounded-sm bg-danger text-neutral-fg'
        : 'size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-danger'"
      :title="confirming ? t('sidebar.sessionItem.deleteConfirm') : t('sidebar.sessionItem.delete')"
      @click.stop="onRemoveClick"
    >
      <Check v-if="confirming" class="size-[13px]" />
      <Trash2 v-else class="size-[13px]" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Pencil, Trash2, Archive, FolderKanban, Quote } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useProjectStore } from '@/stores/project'
import { useSessionStore } from '@/stores/session'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import { toggleMarkedDone, isMarkedDone } from '@/composables/useSessionMarkers'
import type { SessionItemSession } from './types'

const props = defineProps<{
  session: SessionItemSession
  /** 删除两段式确认态（状态在主组件，reset 多路通道锚点在主组件） */
  confirming: boolean
}>()

const emit = defineEmits<{
  'update:confirming': [value: boolean]
  delete: [sessionId: string]
  rename: [sessionId: string]
  /** 归入项目（D14 语义修正）：payload 单对象（规则 #1）。projectId 空串 = 归回默认项目。 */
  setProject: [{ sessionId: string; projectId: string }]
}>()

const { t } = useI18n()

// ── 归入项目菜单（D14 语义修正 2026-08-04）──
const projectStore = useProjectStore()
const assignOpen = ref(false)
/** 归类目标列表：默认项目（未归类聚合）+ 全部命名 project。归回默认 = projectId 空串。 */
const assignTargets = computed(() => [
  { id: '', name: t('sidebar.projectSwitcher.defaultName') },
  ...projectStore.projects.filter((p) => p.name).map((p) => ({ id: p.id, name: p.name })),
])
/** 点击归类：emit + 关菜单（归类可逆，无需两段确认） */
function onAssign(projectId: string): void {
  emit('setProject', { sessionId: props.session.id, projectId })
  assignOpen.value = false
}

/** 标记完成态（按钮高亮 + title 切换；读 useSessionMarkers 模块级响应式集合，onMarkDone toggle 后自动跟随） */
const markedDone = computed(() => isMarkedDone(props.session.id))

/** 标记完成 toggle：写 useSessionMarkers 模块级集合，Display 的 icon/降权响应式跟随 */
function onMarkDone(): void {
  toggleMarkedDone(props.session.id)
}

/** 删除两段式确认：首次点击进确认态（不 emit），再次点击才 emit delete。
 *  复位由主组件多路通道执行（见 props.confirming 注释）。 */
function onRemoveClick(): void {
  if (!props.confirming) {
    emit('update:confirming', true)
    return
  }
  emit('update:confirming', false)
  emit('delete', props.session.id)
}

// ── 引用到输入区（四符号体系 §3.1.2 侧边栏直引，G2 入口）──
const sessionStore = useSessionStore()

/**
 * 把本 session 作为 # 引用注入当前 composer（被引用 = 本条 session，目标 = 当前活跃
 * session 的 composer，两者独立）。经既有 composerInjectionStore 一次性通道，消费端
 * （useComposerInjection watch）匹配后 insertSessionChip 产出紫 session chip。
 * landing 态（无活跃 session）走 target=new：landing composer 已挂载时直接消费
 * （injection.ts target=new 的 landing 分支），语义同 drawer「注入到新对话」。
 */
function onQuoteToComposer(): void {
  const activeId = sessionStore.active?.id ?? null
  composerInjectionStore.requestInjection(
    activeId
      ? { target: 'current', sessionId: activeId, refSessionId: props.session.id, label: props.session.label }
      : { target: 'new', refSessionId: props.session.id, label: props.session.label },
  )
}
</script>
