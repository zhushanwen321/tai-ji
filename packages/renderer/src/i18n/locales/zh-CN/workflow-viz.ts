/**
 * workflow-viz overlay / DAG 画布 / Gantt 的用户文案（workflow-visualization U4）。
 *
 * 命名空间形态：本模块 default export 只含 workflowViz 子树，由 aggregator
 * （locales/zh-CN.ts）展开并入 panel 命名空间（`panel: { ...panel, ...tray,
 * ...workflowViz }`）——运行时 key 前缀 = `panel.workflowViz.*`。en-US/workflow-viz.ts
 * 必须键集合完全一致（守卫 = .githooks/check_i18n_locale_sync.py +
 * __tests__/i18n/locale-sync-check.test.ts）。
 *
 * 文案单源注记：interrupted 态「已中断（可续跑）」复用 `panel.tray.workflowInterrupted`
 * （state-tone-lock 登记词源，不另立副本）；终态四值文案 = shared
 * WORKFLOW_RUN_OUTCOME_LABELS 单源（成功/失败/已取消/已超时），本模块只补 running
 * 与 done+outcome 缺省两个投影词。
 */
export default {
  workflowViz: {
    // overlay 壳
    overlayTitle: '工作流实况',
    overlayClose: '关闭',
    runStatusRunning: '运行中',
    runStatusDone: '已完成',
    // DAG 画布
    dagCanvasLabel: '工作流结构图（DAG）',
    dagZoomHint: '滚轮缩放 · 拖拽平移',
    dagLoading: '解析 workflow 结构…',
    dagRetryParse: '重试解析',
    dagErrorParseFailed: 'DAG 解析失败，已切换为列表视图',
    dagErrorNoScriptSource: '该 run 由旧格式创建，无脚本蓝图可解析',
    dagErrorRecordNotFound: '该 run 无运行记录（可能已被清理）',
    dagErrorPathRejected: '运行记录路径不可访问',
    dagErrorChannel: '获取 workflow 结构失败',
    noAgentCalls: '本脚本无 agent 调用点',
    noAgentCallsHint: '脚本仅包含脚本步骤，没有可展示的调用点',
    nodeRenderFailed: '节点渲染失败',
    // Gantt
    ganttEmpty: '暂无时间线数据',
    ganttBackoffTitle: '退避重试等待 {ms}ms',
    ganttAttempt: '第 {n} 次尝试',
    ganttStateRunning: '进行中',
    ganttStateDone: '完成',
    ganttStateFailed: '失败',
    ganttStateCancelled: '已取消',
    // ── 实况面板（workflow-visualization U5：多级 tab / trace 表 / 事件流 / Gantt 子页）──
    subpage_trace: '实例',
    subpage_events: '事件流',
    subpage_gantt: '时间线',
    traceColAgent: 'Agent',
    traceColPhase: 'Phase',
    traceColAttempt: '尝试',
    traceColStatus: '状态',
    traceColStarted: '开始',
    traceColDuration: '耗时',
    traceColTokens: 'Token',
    traceColResult: '结果',
    traceEmpty: '本 run 暂无 agent 调用',
    statusRetrying: '重试中',
    chipRunning: '进行中',
    chipSettled: '已收束',
    statusDone: '完成',
    statusFailed: '失败',
    attemptLabel: '尝试',
    elapsedLabel: '已用 {duration}',
    eventsEmpty: '暂无事件记录',
    eventsNotFound: '该 run 无事件流记录',
    eventsNotFoundHint: '旧格式 run 或记录已被清理，无法查看事件流',
    eventsLoadFailed: '事件流加载失败',
    retry: '重试',
    truncatedHint: '字段已截断（单字段 2KB 上限）：{fields}。截断内容仅供展示，全文查看经 run 关联持久化文件',
    ganttUnavailable: '时间线视图暂不可用，以下为分段统计',
    ganttAttemptSegments: '执行分段数',
    ganttPhaseBands: 'Phase 色带段数',
    ganttPhaseTurns: 'Phase 轮次',
    scriptOnly: '纯脚本',
    scriptOnlyHint: '该 phase 全程无 agent 调用（脚本执行段）',
    phaseSettled: '已收束',
    turnCount: '{count} 轮',
    phaseEventsTitle: '本 phase 事件',
    phaseEventsUnavailable: '事件流不可用（可在「事件流」子页重试加载）',
    phaseEventsEmpty: '本 phase 暂无归属事件',
  },
}
