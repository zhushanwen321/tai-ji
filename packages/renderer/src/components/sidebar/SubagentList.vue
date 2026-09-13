<template>
  <!--
    展示组件 · subagent 列表（Agents tab）。
    渲染 SubagentRecord[] 卡片：状态点 + agent 名称 + task 摘要 + turns/tokens/elapsed。
    点击卡片 → emit('select', subagentId)，由父组件切换 Panel sessionId。
    二级筛选（全部活跃 / 只看正在跑 / 已收起）：SubagentFilterBar + subagent-bucket SSOT 派生
    （subagent-sidebar-filter D3/D4/D5/D6 + 永久会话模型 §3.2.8 可见性翻转 U8b）。
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
import { countSubagents, filterSubagents, isDoneProjection } from '@/lib/subagent-bucket'
import { useSubagentBucketFilter } from '@/composables/features/sidebar/useSubagentBucketFilter'
import type { SubagentRecord } from '@xyz-agent/shared'
import { deriveClosedDisplay } from '@xyz-agent/shared'
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

/** 执行态判据（四形态合并为三态展示，权威源 residual-fixes 设计 §5.4 等价公式）：
 *  streaming = 真在跑（进程驱动中，spinner + 取消按钮）；
 *  done = one-shot 轮终（result 有值且 chatMode 显式 false——缺省视为不可确认，
 *    落 waiting 保守兜底：无法确认不是 chat → 不宣告完成）；
 *  waiting = 兜底（chat 轮终等续聊 / 孤儿 IO 兜底 / legacy 轮终），静态圆点无取消。 */
function isStreaming(record: SubagentRecord): boolean {
  return record.status === 'running' && record.result === undefined && record.resumable !== true
}

// done 投影展示判据（D4 SSOT）：引用 subagent-bucket 的 isDoneProjection，禁止本地重复实现
const isDone = isDoneProjection

function isWaiting(record: SubagentRecord): boolean {
  return record.status === 'running' && !isStreaming(record) && !isDone(record)
}

/** 中断类停因（G2「为什么停」展示）：取消 / 各类被打断，落中性灰。 */
const INTERRUPTED_STOP_REASONS = new Set(['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent'])

/** 状态点映射规则：match 谓词 + 语义色 class（design-tokens） */
type StatusDotRule = {
  match: (record: SubagentRecord) => boolean
  cls: string
}

/**
 * 状态点颜色映射（design-tokens 语义色，三态主分类 + 中断细分）——优先级表驱动：
 * 自上而下首个 match 生效，顺序即语义（挪动条目前先核对该条注释）。
 *  U8b 两态：idle 三分支（stopReason 派生——失败红 / 中断灰 / 已收口绿）；running 失败轮
 *  （A-lite stopReason=failed，markRoundIdle 保持 running-resumable）红点优先于 done/waiting
 *  投影，其余沿用 spinner + done 投影绿 + waiting 半透明 accent；legacy 五值（done/failed/
 *  crashed/cancelled/closed）保留只读兼容（旧 session 显示，S8），closed 经 deriveClosedDisplay 派生。
 */
const STATUS_DOT_RULES: StatusDotRule[] = [
  // 失败红（A-lite）：markRoundIdle 失败轮携带 stopReason='failed' 且保持 running-resumable——
  // 红点先于 done/waiting 投影判据（绿点/半透明点都会误导失败轮）；与 idle failed 同判据同色；
  // 红点只表达「上一轮失败」，不改变续聊资格语义。
  { match: (r) => r.status === 'running' && r.stopReason === 'failed', cls: 'bg-danger' },
  { match: (r) => r.status === 'idle' && r.stopReason === 'failed', cls: 'bg-danger' },
  // running：spinner 只给 isStreaming（模板层 v-if 渲染，不落此表）；one-shot 轮终投影 done
  // 用绿点、其余（等续聊/孤儿兜底）用 accent 静态点（进行中的非活跃态，区别于 done 绿/error 红/cancelled 灰）。
  { match: (r) => r.status === 'running' && isDone(r), cls: 'bg-success' },
  { match: (r) => r.status === 'running' && isWaiting(r), cls: 'bg-accent opacity-60' },
  { match: (r) => r.status === 'running', cls: 'bg-accent' },
  // idle：中断类停因（见 INTERRUPTED_STOP_REASONS）落中性灰；已收口（completed/reopened/无停因）绿。
  { match: (r) => r.status === 'idle' && r.stopReason !== undefined && INTERRUPTED_STOP_REASONS.has(r.stopReason), cls: 'bg-neutral-dim opacity-50' },
  { match: (r) => r.status === 'idle', cls: 'bg-success' },
  // legacy 五值只读兼容（旧 session 显示，S8）；crashed（子进程崩溃）与 failed 同为异常终态
  // 共用 danger 色（running 走 spinner 不会到这里，故不混淆）；closed 三分（v4 B-1 统一终态）：
  // cancelled→中性 / gc 失败（error 有值）→红 / 自然完成·级联关闭→绿。
  { match: (r) => r.status === 'done', cls: 'bg-success' },
  { match: (r) => r.status === 'failed' || r.status === 'crashed', cls: 'bg-danger' },
  { match: (r) => r.status === 'cancelled', cls: 'bg-neutral-dim opacity-50' },
  { match: (r) => r.status === 'closed' && deriveClosedDisplay(r) === 'cancelled', cls: 'bg-neutral-dim opacity-50' },
  { match: (r) => r.status === 'closed' && deriveClosedDisplay(r) === 'failed', cls: 'bg-danger' },
  { match: (r) => r.status === 'closed', cls: 'bg-success' },
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
