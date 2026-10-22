<!--
  ArchiveSummaryView —— 归档摘要视图（session-archive 设计 D11，主区 B2）。

  挂载方（ArchiveMainView 卡壳内，u-renderer-entry）点击归档行后以本组件呈现：
  props 收 config.archives 元素（ArchiveSummary DTO，staging/archived 两态）；
  [恢复完整会话] 钮只 emit restore，恢复编排（RPC 调用 / 侧栏切回 / 主区回 chat /
  列表刷新）在挂载方。

  结构（D11 + 对话流卡头对齐）：
  - 卡头（40px，PanelHeader 同档：h-[40px] / px-3.5 / gap-2 / 字 base / border-b hairline，
    空白区 -webkit-app-region:drag、交互组 no-drag）：[已归档] pill + 会话名 +
    双 tab + accent 恢复钮（恢复钮与分段 tab 项同高 24px）
    折叠态让位（DESIGN.md §11，与 PanelHeader 同构）：侧栏折叠且非全屏时左内边距
    pl-[88px] 让位 mac 红黄绿（OS 绘制占 x=8..68）；全屏态红黄绿 OS 隐藏，回落 pl-3.5。
    本视图不迁入 chrome 按钮组（收起/前进后退/新建任务仍在侧栏与 PanelHeader），
    只承接安全区内边距——归档视图可独立于侧栏展开态显示（MainPanel view 路由）。
  - 摘要流（用户摘要 tab）：右浮用户气泡 + 左侧 agent 文本块，720px 居中
    （content-col 原语，同对话流规范）。气泡/正文为静态纯文本渲染（摘要数据无
    segments/消息 id，不复用 live 会话的 UserBubble/MarkdownRenderer——两者硬耦合
    ChatViewDeps 注入与编辑/撤回机器，只读归档视图语义不适用；视觉类族同款复刻）。
  - agent 引用视图 tab：mono 呈现 session_read 返回形态（formatArchiveAgentReference，
    用户预检 agent 将看到什么）。
  - 占位规则：turn 无 agent 文本 / 纯图片 user 空串 / staging 全区「摘要生成中」。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="archive-summary-view">
    <!-- 卡头：pill + 名称 + 双 tab（staging 隐藏——无内容可切）+ 恢复钮 -->
    <header
      class="flex h-[40px] shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3.5 text-[length:var(--text-base)] text-neutral-mid [-webkit-app-region:drag]"
      :class="showChrome && !isFullscreen ? 'pl-[88px]' : 'pl-3.5'"
      data-testid="archive-summary-banner"
    >
      <!-- 身份区（pill + 名称）no-drag：PanelHeader 会话名区同款——文本可选中、截断名
           hover 读全名（title），不落入窗口拖拽区（-webkit-app-region:drag 吞点击/hover） -->
      <div class="flex min-w-0 shrink items-center gap-2 [-webkit-app-region:no-drag]">
        <span
          class="shrink-0 rounded-sm border border-hairline px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] leading-none text-neutral-dim"
          data-testid="archive-archived-pill"
        >{{ t('archive.summary.archivedPill') }}</span>
        <h2
          class="min-w-0 shrink truncate text-[length:var(--text-base)] [font-weight:var(--fw-mid)] text-neutral-fg"
          :title="displayName"
          data-testid="archive-summary-name"
        >{{ displayName }}</h2>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
        <div
          v-if="isArchived"
          class="flex gap-[2px] rounded-sm border border-hairline bg-bg-input p-[2px]"
          role="tablist"
          :aria-label="t('archive.summary.tablistLabel')"
          data-testid="archive-summary-tablist"
        >
          <Button
            v-for="tab in tabs"
            :key="tab.value"
            variant="ghost"
            role="tab"
            :aria-selected="activeTab === tab.value"
            :title="tab.label"
            :class="cn(
              'h-[24px] justify-center rounded-[var(--radius-xs)] px-2 text-[length:var(--text-xs)]',
              activeTab === tab.value
                ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
                : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg',
            )"
            :data-testid="`archive-summary-tab-${tab.value}`"
            @click="activeTab = tab.value"
          >
            {{ tab.label }}
          </Button>
        </div>
        <Button
          size="sm"
          class="h-6 gap-1.5 px-2.5 text-[length:var(--text-xs)]"
          data-testid="archive-restore-button"
          @click="emit('restore')"
        >
          <RotateCcw class="size-3" />
          {{ t('archive.summary.restore') }}
        </Button>
      </div>
    </header>

    <!-- 内容区：staging 全区占位 / 双 tab 内容（720px content-col 居中） -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- staging：全区「摘要生成中」占位（后台压缩完成事件由挂载方刷新数据驱动重渲染） -->
      <div
        v-if="!isArchived"
        class="flex h-full flex-col items-center justify-center gap-1.5"
        data-testid="archive-summary-staging"
      >
        <span class="text-[length:var(--text-md)] text-neutral-mid">{{ t('archive.summary.generating') }}</span>
        <span class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('archive.summary.generatingHint') }}</span>
      </div>

      <template v-else>
        <!-- 用户摘要 tab：右浮用户气泡 + 左侧 agent 文本块（逐 turn；轮节奏同对话流 gap-[12px] + 轮边界 20px） -->
        <div
          v-if="activeTab === 'user'"
          class="content-col flex flex-col px-5 py-6"
          data-testid="archive-summary-flow"
        >
          <div
            v-for="(turn, i) in turns"
            :key="i"
            class="flex flex-col gap-[12px]"
            :class="i === turns.length - 1 ? '' : 'pb-5'"
            :data-testid="`archive-summary-turn-${i}`"
          >
            <!-- 用户气泡（右浮；纯图片/附件消息空串 → 占位文案） -->
            <div class="flex justify-end" :data-testid="`archive-summary-turn-${i}-user`">
              <div
                class="max-w-[min(72%,64ch)] min-w-0 rounded-lg border border-hairline bg-[var(--bubble-bg)] px-[15px] py-[10px] text-[length:var(--text-md)] leading-[1.7] text-neutral-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
              >{{ turn.user.length > 0 ? turn.user : t('archive.summary.userAttachment') }}</div>
            </div>
            <!-- agent 文本块（左侧；turn 以工具调用结束无文本 → 占位文案） -->
            <div class="flex min-w-0 flex-col gap-1" :data-testid="`archive-summary-turn-${i}-agent`">
              <span class="font-mono text-[length:var(--text-2xs)] text-neutral-dim">{{ t('archive.summary.agentLabel') }}</span>
              <div
                v-if="turn.agent !== null"
                class="min-w-0 text-[length:var(--text-md)] leading-[1.8] text-neutral-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
                :data-testid="`archive-summary-turn-${i}-agent-text`"
              >{{ turn.agent }}</div>
              <div
                v-else
                class="min-w-0 text-[length:var(--text-sm)] leading-[1.8] text-neutral-dim [overflow-wrap:anywhere]"
                :data-testid="`archive-summary-turn-${i}-agent-placeholder`"
              >{{ t('archive.summary.turnNoAgentText') }}</div>
            </div>
          </div>
          <!-- 空摘要（turns 为空数组的合法簿记形态） -->
          <div v-if="turns.length === 0" class="py-6 text-center text-[length:var(--text-sm)] text-neutral-dim" data-testid="archive-summary-empty">
            {{ t('archive.summary.empty') }}
          </div>
        </div>

        <!-- agent 引用视图 tab：mono 呈现 session_read 返回形态（预检 agent 将看到什么） -->
        <pre
          v-else
          class="content-col min-w-0 px-5 py-6 font-mono text-[length:var(--text-sm)] leading-[1.8] text-neutral-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
          data-testid="archive-agent-reference"
        >{{ agentReference }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw } from '@lucide/vue'
import type { ArchiveSummary } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSidebarStore } from '@/stores/sidebar'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { formatArchiveAgentReference } from './agent-reference-format'

const props = defineProps<{
  /** 归档条目（config.archives 元素；status 判别 staging/archived 两态） */
  archive: ArchiveSummary
}>()

const emit = defineEmits<{
  /** [恢复完整会话] accent 钮点击（staging 态恢复合法——统一冲突检测含 staging，设计 V6） */
  restore: []
}>()

const { t } = useI18n()

const sidebar = useSidebarStore()
const { isFullscreen } = usePlatformChrome()

/**
 * 折叠态让位判据（DESIGN.md §11，与 PanelHeader.vue:207 同构）：侧栏折叠 → 主区左缘归零
 * （AsideRegion flexBasis 0），卡头左缘即窗口左缘，须让位 mac 红黄绿（OS 绘制 x=8..68）。
 * 全屏态红黄绿由 OS 隐藏，不让位。
 */
const showChrome = computed(() => sidebar.collapsed)

/** banner 双 tab 定义（D11：用户摘要 / agent 引用视图）。 */
type SummaryTab = 'user' | 'agent'
const tabs = computed<{ value: SummaryTab; label: string }[]>(() => [
  { value: 'user', label: t('archive.summary.tabUserSummary') },
  { value: 'agent', label: t('archive.summary.tabAgentReference') },
])

const activeTab = ref<SummaryTab>('user')

const isArchived = computed(() => props.archive.status === 'archived')
const turns = computed(() => (props.archive.status === 'archived' ? props.archive.summary.turns : []))

/** 会话名（name 空串 = 提取失败的合法簿记形态 → 未命名占位）。 */
const displayName = computed(() =>
  props.archive.name.length > 0 ? props.archive.name : t('archive.summary.unnamed'),
)

/**
 * agent 引用视图正文（session_read 返回形态，纯函数预检）：staging 态内容区由全区
 * 占位接替（模板 v-if），此处不求值——空串仅为类型完整性兜底，不会渲染。
 */
const agentReference = computed(() =>
  props.archive.status === 'archived' ? formatArchiveAgentReference(props.archive) : '',
)
</script>
