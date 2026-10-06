<script lang="ts">
// SubagentStatusLine —— 移动壳 subagent 运行状态行（remote-use A9 / U15；D5 去留表 onSubagents 行）。
//
// 写分区语义 = 桌面 stores/subagent.ts applyRecords 的最小子集（D5 去留表口径）：per-session
// Map 分区（ADR-0049 派）+ 不可变整 Map 替换触发响应性（范式同源 renderer partitioned-session-records
// 四件套——移动壳不依赖 renderer 包，且无 loading/error/oversize/strike/streaming 面板族面，
// 只消费 apply + 读两件）。接线位在壳扩展层非 factory 内：onSubagents 由 bootstrap effects
// 直挂本模块导出的 applySubagentRecords（factory 不含 subagent 语义，D5 去留表）。
//
// 状态内聚本文件（单读方 = 本组件；唯一写方 = bootstrap 直挂）——与 ErrorBar「shell 持状态」
// 先例的差异：ErrorBar 状态被三条链共享须收口 companion-bridge，本分区单组件消费，内聚即收口。
import { shallowRef } from 'vue'
import type { SubagentRecord } from '@taiji/shared'

/**
 * per-session subagent 记录分区（shallowRef + 不可变替换，同 partitioned-session-records 范式）。
 * @data-owner #8 —— #8 subagent 列表/状态的移动壳消费副本（权威源 / 写读口 / 清理语义见登记表 #8 行）
 */
const recordsBySession = shallowRef<Map<string, SubagentRecord[]>>(new Map())

/**
 * onSubagents 直挂写入口（bootstrap effects.onSubagents）。
 * 推送是权威数据：整体替换该 sid 分区（空数组照写——对齐桌面推送路径不经 strike 守卫）。
 */
export function applySubagentRecords(sessionId: string, subagents: SubagentRecord[]): void {
  recordsBySession.value = new Map(recordsBySession.value).set(sessionId, subagents)
}

/**
 * 该 session 是否有真在跑的 subagent（remote-use U20/A14：移动列表状态点 working 态的
 * hasBackgroundWork 输入源）。占用判据与 runningSubagents 同式（running 且无 stopReason，
 * 镜像桌面 isRunningProjection SSOT 口径——core deriveSessionStatus 下沉后本读口只负责
 * 收集该布尔输入，判据本体归状态派生谓词的输入契约，不在此重复成第二判定）。
 * 读口在调用方 computed 体内调用即建立对 recordsBySession 的响应式依赖（分区变化自动重算）。
 */
export function hasRunningSubagents(sessionId: string): boolean {
  return (recordsBySession.value.get(sessionId) ?? []).some(
    (r) => r.status === 'running' && r.stopReason === undefined,
  )
}

/** 测试重置（模块级分区单例跨用例残留清零；生产代码禁止消费，对齐 __testing 先例） */
export function resetSubagentPartitionsForTest(): void {
  recordsBySession.value = new Map()
}
</script>

<script setup lang="ts">
// 状态行呈现：props.sessionId（活跃会话）→ 读分区 → running 汇总细行（无 running 不渲染不占位）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()

// 占用判据：running 且无 stopReason——镜像桌面 lib/subagent-bucket isRunningProjection SSOT
// 口径（移动壳不依赖 renderer 包；U20 状态派生谓词下沉 core 后双壳同源）。
// stopReason 子句排除 W4 死亡纳管态（running + stopReason='failed' 非后台真在跑）。
const runningSubagents = computed(() => {
  const records = recordsBySession.value.get(props.sessionId) ?? []
  return records.filter((r) => r.status === 'running' && r.stopReason === undefined)
})

// 展示名：slug 优先，空串兜底 agent 名（旧 session 数据 slug 缺省形态文案不空）；
// 分隔符对齐壳内既有「 · 」形态（MobileChatHeader modelLine）。
const runningLabel = computed(() =>
  runningSubagents.value.map((r) => r.slug || r.agent).join(' · '),
)
</script>

<template>
  <p
    v-if="runningSubagents.length > 0"
    class="shrink-0 px-3 py-1.5 text-xs text-neutral-mid"
    role="status"
    data-testid="mobile-subagent-status-line"
  >
    {{ t('mobile.subagentStatus.running', { slugs: runningLabel }) }}
  </p>
</template>
