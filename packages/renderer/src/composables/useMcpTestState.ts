/**
 * useMcpTestState —— MCP 分区连接测试的状态域（McpSection.vue 抽取）。
 *
 * 持有连接测试三组 refs（当前展示徽标 / 上次成功终态徽标 / 进行中任务 testId 登记）与
 * 状态级操作（测试中标记、testId 登记与清退、probe 终态回填、取消与删除时的徽标恢复）。
 * probe 终态广播订阅同域持有（onGlobalType 全局通道 + 作用域注销——u5b 打回接线形态，
 * 订阅随调用方 setup 同步注册，时序与抽取前组件内联等价）。busy 互斥、协议调用编排与
 * toast 反馈留在 McpSection.vue——它们跨状态域与协议域，不属单一测试状态
 *（useMcpServerForm 同款分工）。
 */
import { onScopeDispose, ref } from 'vue'
import { onGlobalType } from '@taiji/core/transport/api'
import type { McpServerStatusBadge } from '@taiji/shared'

export function useMcpTestState() {
  /** 条目当前展示徽标（name → badge；缺省未测试，经 McpServerList 缺省渲染） */
  const badges = ref<Record<string, McpServerStatusBadge>>({})
  /** 最近一次 probe 终态徽标（「测试超时」时保留展示，D3） */
  const lastProbe = ref<Record<string, McpServerStatusBadge>>({})
  /** 进行中的连接测试任务（name → testId；「取消」按钮按 testId 杀 probe 子进程，D3） */
  const activeTestIds = ref<Record<string, string>>({})

  // probe 终态广播订阅（u5b 打回接线）：runtime probe 完成 → mcp:testResult 帧 → 徽标回填。
  // setup 同步订阅 + 作用域销毁注销（组件多实例防泄漏；applyProbeResult 是函数声明提升，
  // 订阅注册早于其定义位置亦可安全引用）。testId 命中即清退进行中任务登记（该任务已收敛）。
  const offTestResult = onGlobalType('mcp:testResult', (msg) => {
    applyProbeResult(msg.payload.name, msg.payload.badge, msg.payload.testId)
  })
  onScopeDispose(offTestResult)

  /** 测试发起：徽标转「测试中」（D8② UI 本地过程态） */
  function markTesting(name: string): void {
    badges.value = { ...badges.value, [name]: { source: 'ui-local', state: 'testing' } }
  }

  /** 任务受理：登记 testId 供「取消」按钮按句柄终止（D3） */
  function registerActiveTest(name: string, testId: string): void {
    activeTestIds.value = { ...activeTestIds.value, [name]: testId }
  }

  /** 任务收敛（主动取消生效）：清退该条目的 testId 登记 */
  function clearActiveTest(name: string): void {
    const next = { ...activeTestIds.value }
    delete next[name]
    activeTestIds.value = next
  }

  /** 分区刷新：全部徽标回落「未测试」（D8② 本次界面会话语义，刷新即重置） */
  function resetTestState(): void {
    badges.value = {}
    lastProbe.value = {}
  }

  /** 删除条目：该条目当前徽标与上次结果一并清退（行已消失，无展示对象） */
  function clearBadgeState(name: string): void {
    const next = { ...badges.value }
    delete next[name]
    badges.value = next
    const last = { ...lastProbe.value }
    delete last[name]
    lastProbe.value = last
  }

  /** 主动取消生效：恢复取消前徽标——上次成功结果保留展示，无则回落「未测试」（D3 取消与超时同源语义） */
  function revertBadge(name: string): void {
    const next = { ...badges.value }
    if (lastProbe.value[name]) next[name] = lastProbe.value[name]
    else delete next[name]
    badges.value = next
  }

  /**
   * probe 终态徽标回填（defineExpose 接缝）：连接测试结果的唯一入口。「测试超时」同样经此
   * 回填（D3 语义 = 整体无本次结果，timeout 态只更新当前展示徽标，lastProbe 保留上次成功
   * 结果）。testId 命中进行中任务登记时同步清退（该任务已收敛）。
   */
  function applyProbeResult(name: string, badge: McpServerStatusBadge, testId?: string): void {
    if (testId !== undefined && activeTestIds.value[name] === testId) {
      clearActiveTest(name)
    }
    if (badge.source === 'probe' || badge.source === 'config') {
      lastProbe.value = { ...lastProbe.value, [name]: badge }
    }
    badges.value = { ...badges.value, [name]: badge }
  }

  return {
    badges,
    lastProbe,
    activeTestIds,
    markTesting,
    registerActiveTest,
    clearActiveTest,
    resetTestState,
    clearBadgeState,
    revertBadge,
    applyProbeResult,
  }
}
