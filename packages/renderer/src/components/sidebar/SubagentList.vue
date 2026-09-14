<template>
  <!--
    展示组件 · subagent 列表（Agents tab）。
    渲染 SubagentRecord[] 卡片：状态点 + agent 名称 + task 摘要 + turns/tokens/elapsed。
    点击卡片 → emit('select', subagentId)，由父组件切换 Panel sessionId。
    二级筛选（全部活跃 / 只看正在跑 / 已收起）：SubagentFilterBar + subagent-bucket SSOT 派生
    （subagent-sidebar-filter D3/D4/D5/D6 + 永久会话模型 §3.2.8 可见性翻转 U8b；原设计文档已删除，git 可追溯）。
    默认视图 = running + idle(active) 全显（legacy 终态投影 idle 同显）；intent=archived
    默认隐藏、「已收起」视图寻回（场景 3：message 隐含翻回 active 由宿主侧承担）。
    空态展示提示文案。
  -->
  <div class="flex h-full min-h-0 flex-col" data-testid="subagent-list">
    <!-- 加载态（M1：loadSubagents 在途） -->
    <div
      v-if="isLoading"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-loading"
    >
      <Loader2 class="size-4 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-60">{{ t('sidebar.subagentList.loading') }}</p>
    </div>
    <!-- 错误态（M1：loadSubagents 失败，可重试） -->
    <div
      v-else-if="loadError"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('sidebar.subagentList.loadFailed', { error: loadError }) }}</p>
      <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent" data-testid="subagent-list-retry" @click="emit('retry')">{{ t('sidebar.subagentList.retry') }}</Button>
    </div>
    <!-- 全量空态（D6：无数据时不渲染筛选条，沿用既有空态） -->
    <div
      v-else-if="subagents.length === 0"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      data-testid="subagent-list-empty"
    >
      <Bot class="size-7 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.subagentList.empty') }}</p>
      <p class="text-[length:var(--text-3xs)] text-neutral-dim opacity-40">{{ t('sidebar.subagentList.emptyHint') }}</p>
    </div>
    <!-- 有数据列表态：二级筛选槽 + 按视图过滤的列表 / 视图空态 -->
    <template v-else>
      <SubagentFilterBar
        :counts="subagentCounts"
        :model-value="filter"
        @update:model-value="setFilter"
      />
      <!-- 列表（当前视图非空） -->
      <ScrollArea v-if="visibleSubagents.length > 0" class="min-h-0 flex-1">
        <div class="flex flex-col px-1.5">
          <div
            v-for="record in visibleSubagents"
            :key="record.subagentId"
            class="group relative cursor-pointer rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
            data-testid="subagent-card"
            :title="record.slug ? record.agent + ' · ' + record.slug : record.agent"
            @click="emit('select', record.subagentId)"
            @mouseleave="cancellingId = null"
          >
            <!-- 状态指示（引擎 icon 最左，D9；尺寸与 spinner 同级 13px） -->
            <div class="flex items-center gap-2">
              <component
                :is="resolveEngineIcon(record.engine).icon"
                class="size-[13px] shrink-0 text-neutral-dim"
                :title="resolveEngineIcon(record.engine).label"
                data-testid="subagent-engine-icon"
              />
              <Loader2
                v-if="isStreaming(record)"
                class="size-[13px] shrink-0 animate-spin text-accent"
                data-testid="subagent-card-spinner"
              />
              <span
                v-else
                class="size-2 shrink-0 rounded-full"
                :class="statusDotClass(record)"
              />
              <span class="min-w-0 flex-1 truncate text-[length:var(--text-xs)] font-medium leading-[1.35] text-neutral-fg">
                {{ record.agent }}
              </span>
              <!-- slug 短标签（与 WorkflowList 第一行对齐：名称右侧 mono 小字；旧 session 兜底空串不渲染） -->
              <span
                v-if="record.slug"
                class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-mid"
                data-testid="subagent-card-slug"
              >
                {{ record.slug }}
              </span>
              <!-- cancel 按钮（streaming 态显示，inline 两段式确认；waiting/done 投影无进程可取消，不显示）。
                   [GUI 快修③] 确认窗口期保留按钮：第一击进入确认态后，迟到 isStreaming=false 广播
                   （轮终/settle）不得把确认按钮藏掉——第二击可达性优先于态过滤。 -->
              <Button
                v-if="isStreaming(record) || cancellingId === record.subagentId"
                variant="ghost"
                size="icon"
                :data-testid="cancellingId === record.subagentId ? 'subagent-action-cancel-confirm' : 'subagent-action-cancel'"
                :class="cancellingId === record.subagentId
                  ? 'size-5 rounded-sm border border-danger bg-danger text-neutral-fg'
                  : 'size-5 text-neutral-dim hover:text-danger'"
                :title="cancellingId === record.subagentId ? t('sidebar.subagentList.cancelConfirm') : t('sidebar.subagentList.cancel')"
                @click.stop="onCancelClick(record)"
              >
                <Check v-if="cancellingId === record.subagentId" class="size-3" />
                <X v-else class="size-3" />
              </Button>
            </div>

            <!-- 摘要 -->
            <div class="mt-1 flex items-center gap-2 pl-[42px] font-mono text-[length:var(--text-3xs)] text-neutral-dim">
              <span v-if="record.turns !== undefined">{{ record.turns }} {{ t('sidebar.subagentList.turnsUnit') }}</span>
              <span v-if="record.totalTokens !== undefined">· {{ formatTokens(record.totalTokens, t('sidebar.subagentList.tokUnit')) }}</span>
              <span v-if="record.elapsedSeconds !== undefined">· {{ formatElapsed(record.elapsedSeconds) }}</span>
            </div>

            <!-- 任务描述 -->
            <div class="mt-0.5 truncate pl-[42px] text-[length:var(--text-2xs)] leading-[1.3] text-neutral-mid">
              {{ record.task }}
            </div>
          </div>
        </div>
      </ScrollArea>

      <!-- 「全部」视图空态：自适应空态 + 一键查看已收起（场景 3 寻回入口） -->
      <div
        v-else-if="filter === 'active'"
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="subagent-list-empty-active"
      >
        <Bot class="size-7 text-neutral-dim opacity-40" />
        <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.subagentFilter.emptyActive') }}</p>
        <p class="text-[length:var(--text-3xs)] text-neutral-dim opacity-40">{{ t('sidebar.subagentFilter.emptyActiveHint') }}</p>
        <Button
          v-if="subagentCounts.archived > 0"
          variant="ghost"
          class="h-6 text-[length:var(--text-2xs)] text-accent"
          data-testid="subagent-filter-jump-archived"
          @click="setFilter('archived')"
        >{{ t('sidebar.subagentFilter.viewArchived', { count: subagentCounts.archived }) }}</Button>
      </div>
      <!-- 「正在跑」空桶：文案 + 一键回默认视图 -->
      <div
        v-else-if="filter === 'running'"
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="subagent-list-empty-running"
      >
        <Bot class="size-7 text-neutral-dim opacity-40" />
        <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.subagentFilter.emptyRunning') }}</p>
        <p class="text-[length:var(--text-3xs)] text-neutral-dim opacity-40">{{ t('sidebar.subagentFilter.emptyRunningHint') }}</p>
        <Button
          variant="ghost"
          class="h-6 text-[length:var(--text-2xs)] text-accent"
          data-testid="subagent-filter-jump-all"
          @click="setFilter('active')"
        >{{ t('sidebar.subagentFilter.viewAll', { count: subagentCounts.active }) }}</Button>
      </div>
      <!-- 「已收起」空桶：仅文案 -->
      <div
        v-else
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="subagent-list-empty-archived"
      >
        <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t('sidebar.subagentFilter.emptyArchived') }}</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Loader2, Bot, AlertCircle, X, Check } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import SubagentFilterBar from '@/components/sidebar/SubagentFilterBar.vue'
import { countSubagents, filterSubagents, isRunningProjection } from '@/lib/subagent-bucket'
import { useSubagentBucketFilter } from '@/composables/features/sidebar/useSubagentBucketFilter'
import type { SubagentRecord } from '@xyz-agent/shared'
import { resolveEngineIcon } from '@/constants/engine-icons'

/** token 数超过此阈值显示 k 单位 */
const TOKEN_K_THRESHOLD = 1000
/** 秒数超过此阈值显示分秒组合 */
const SECONDS_PER_MINUTE = 60

const { t } = useI18n()

const props = withDefaults(defineProps<{
  subagents: SubagentRecord[]
  /** 焦点 session id（null = Overview 态既有空态路径）；per-session 筛选分区 key（D5） */
  sessionId: string | null
  isLoading?: boolean
  loadError?: string | null
}>(), {
  isLoading: false,
  loadError: null,
})

// per-session 筛选分区（D5）：组件纯读，无 watch 无实例级 filter ref——分区语义由
// useSubagentBucketFilter / useSessionScopedState 工厂承担（ADR-0049）
const { filter, setFilter } = useSubagentBucketFilter(computed(() => props.sessionId))

/** 当前视图下的可见记录（纯内存派生，subagent-bucket SSOT） */
const visibleSubagents = computed(() => filterSubagents(props.subagents, filter.value))

/** 三视图计数（computed 缓存，D6 #6——模板直调会在无关重渲染时反复重算全量分桶） */
const subagentCounts = computed(() => countSubagents(props.subagents))

const emit = defineEmits<{
  select: [subagentId: string]
  cancel: [subagentId: string]
  retry: []
}>()

/** 当前进入取消确认态的 subagentId（两段式：首次点击进入，再次点击执行） */
const cancellingId = ref<string | null>(null)

/**
 * cancel 两段式：首次点击进入确认态，二次点击 emit cancel。第二击时任务可能已收口
 * （迟到 isStreaming=false 窗口）——组件保持纯展示不判业务，统一上抛；「任务已结束」
 * 反馈在 action 层（useSidebarSubagentActions：非 streaming 不发 RPC，toast 提示）。
 */
function onCancelClick(record: SubagentRecord): void {
  if (cancellingId.value === record.subagentId) {
    cancellingId.value = null
    emit('cancel', record.subagentId)
    return
  }
  cancellingId.value = record.subagentId
}

/** 执行态判据（[two-state-convergence] 两态终态）：streaming = 真在跑（进程驱动中，
 *  spinner + 取消按钮）；非 streaming = 静态圆点（done 绿 / waiting accent-60 / 失败红 /
 *  中断灰），细分由下方 STATUS_DOT_RULES 全表表驱动（[U6] 坍缩后组件不再单独引用
 *  isDone/isWaiting 判据——两判据保留在 subagent-bucket SSOT 作展示公式与测试面）。
 *  [two-state-convergence D2/U2] streaming 判据 = subagent-bucket SSOT 的 import
 *  wrapper（isRunningProjection 终态判据 `running && stopReason === undefined`）——
 *  badge 计数 / hasRunning / isStreamingSubagent 与本组件同源，不漂移。runtime 归一层
 *  保证 renderer 永不见 legacy 值（U6/D5 边界归一），状态点全表只需两态词表。 */
const isStreaming = isRunningProjection

/** 中断类停因（G2「为什么停」展示）：取消 / 各类被打断，落中性灰。 */
const INTERRUPTED_STOP_REASONS = new Set(['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent'])

/** 状态点映射规则：match 谓词 + 语义色 class（design-tokens） */
type StatusDotRule = {
  match: (record: SubagentRecord) => boolean
  cls: string
}

/**
 * 状态点颜色映射（design-tokens 语义色）——优先级表驱动：自上而下首个 match 生效，
 * 顺序即语义（挪动条目前先核对该条注释）。
 * [two-state-convergence U6/D5] 全表坍缩终态（五行）：四行 idle-gated + 第五行
 * running+failed 红。U4 前移的最小 accent 分支、running 三分空转分支、legacy 五值
 * 分支（done/failed/crashed/cancelled/closed）全部吸收删除——legacy 值经 runtime
 * 归一层映射为 idle + stopReason/closedReason/chatMode 展示位（closed 经
 * deriveClosedDisplay 派生 stopReason，「deriveClosedDisplay 改 stopReason 派生」），
 * 与收窄前三分显示等价（A4 门）：cancelled→灰（interrupted 族）/ failed→红 /
 * done→绿（one-shot 形态位合成保证落 idle 兜底行而非 accent 行）。
 * 顺序语义：失败红 / 中断灰先于等续聊 accent-60 先于完成绿兜底。
 */
const STATUS_DOT_RULES: StatusDotRule[] = [
  // running 失败红（W4 死亡纳管态，[U5/D4] adoptEngineDeath 写 stopReason='failed'；
  // R5 补行）：红点兜住引擎死亡失败态展示，否则落 accent 兜底丢失失败信息。红点只
  // 表达「上一轮失败」，不改变续聊资格语义。
  { match: (r) => r.status === 'running' && r.stopReason === 'failed', cls: 'bg-danger' },
  // idle 失败红：轮终失败 / 归一后的 legacy failed|crashed / closed-failed 派生。
  { match: (r) => r.status === 'idle' && r.stopReason === 'failed', cls: 'bg-danger' },
  // idle 中断灰：中断类停因（见 INTERRUPTED_STOP_REASONS）——中断语义先于等续聊展示。
  // 归一后的 legacy cancelled 与 closed-cancelled 派生（'cancelled'）同落此行。
  { match: (r) => r.status === 'idle' && r.stopReason !== undefined && INTERRUPTED_STOP_REASONS.has(r.stopReason), cls: 'bg-neutral-dim opacity-50' },
  // idle chat 等续聊 → 半透明 accent 点：chat 轮终（idle + chatMode true/缺省）。
  // chatMode !== false 对 legacy 缺省保守归 chat；「非 interrupted 族」由上一行灰分支
  // 顺序保证，显式条件防未来顺序挪动破坏语义。failed 由上方红分支先行承接。
  { match: (r) => r.status === 'idle' && r.chatMode !== false && !(r.stopReason !== undefined && INTERRUPTED_STOP_REASONS.has(r.stopReason)), cls: 'bg-accent opacity-60' },
  // idle 兜底绿：已收口（one-shot 完成——completed/reopened/无停因且 chatMode=false）。
  // legacy done 与 closed-done 经归一的 one-shot 形态位合成（chatMode=false）落此行。
  { match: (r) => r.status === 'idle', cls: 'bg-success' },
]

/** 状态点颜色查表（映射语义 SSOT 见上方规则表；未知 status 兜底 accent 防无色） */
function statusDotClass(record: SubagentRecord): string {
  const hit = STATUS_DOT_RULES.find((entry) => entry.match(record))
  return hit ? hit.cls : 'bg-accent'
}

/** 格式化 token 数（超过阈值显示 k） */
function formatTokens(tokens: number, unit: string): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k ${unit}`
  return `${tokens} ${unit}`
}

/** 格式化耗时（秒 → 可读） */
function formatElapsed(seconds: number): string {
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  return `${seconds}s`
}
</script>
