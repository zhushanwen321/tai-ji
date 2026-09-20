/**
 * plan 模式 i18n：modeBar 状态带 + reviewBar 审阅条 + drawer 计划产物 tab + docs 文档面板
 * + comment 划选评论。
 */
export default {
  reviewBar: {
    commentsCount: '{count} 条评论',
    requestExplanation: '请求进一步解释',
    submitRevise: '提交评论并要求修订',
    confirmExecute: '确认并执行',
    revising: 'agent 正在根据评论修订文档，完成后会在这里更新版本',
    waitingResubmit: '等待 agent 重新提交审批',
    // §3.4 降级三分支（reviewStateSource 两源 + 旧 entry 缺省通用）：共用恢复入口指引 +
    // 退出按钮（无填充描边，不再是死胡同）；耗时显示不做（设计裁决）
    degradedExplain: '已收到你的问题，agent 解答后会重新提交审批',
    degradedResubmit: 'agent 会话已重启，尚未重新提交',
    degradedRecoverHint: '在对话输入框发送任意消息，提醒 agent 重新提交审批',
    degradedExit: '退出',
    // §3.5 守卫与回看：0 评论时「提交评论修订」禁用的 tooltip 说明；评论计数可点（回看草稿）
    reviseEmptyDisabled: '先在文档中划选添加评论，再提交修订',
    viewDrafts: '查看评论草稿',
  },
  // PlanModeBar 左区（plan-mode-ux-refactor u-plan-bar：状态带收敛后自持键族）
  modeBar: {
    title: '计划模式',
    skillsLabel: '技能',
    stageExploring: '需求探索',
    stageWriting: '文档撰写',
    stageReviewing: '审阅确认',
    // 阶段点 tooltip（各阶段含义）
    stageExploringTip: 'agent 正在探索需求，尚未产出计划文档',
    stageWritingTip: 'agent 正在撰写计划文档',
    stageReviewingTip: '计划文档已产出，等待你审阅确认',
    exit: '退出',
    // E9：错误消息内嵌恢复动作（错误 → 恢复闭环），状态带保持原状
    exitError: '退出失败：{message}。修复后重试退出，或手动在对话输入 /plan abort',
    // §3.5 退出确认 Popover（分情境警示）：revising = agent 侧修订将中止（GUI 草稿在
    // revise 提交时已清，警示指 agent 侧）；有评论草稿 = 草稿将丢弃；两警示按序取首个命中
    exitConfirmTitle: '退出计划模式？',
    exitWarnRevising: 'agent 正在修订文档，退出将中止修订',
    exitWarnDrafts: '{count} 条评论草稿将丢弃',
    exitConfirm: '确认退出',
    exitCancel: '取消',
  },
  drawer: {
    // plan tab（plan 模式重设计 u1-drawer-tab）：drawer「计划产物」tab。
    // key 落 plan 域文件——tab 语义属 plan 模式域，不并入 panel.sideDrawer
    tabPlan: '计划产物',
    noPlan: '暂无计划产物',
    planHint: '进入计划模式后，agent 产出的文档会显示在这里',
    // pending 态矩阵（plan-mode-ux-refactor §3.2，u-drawer-gate）：isActive && docs 空期间
    // 计划产物面板的两态。#1 与 derivePlanStage 的 exploring 语义对齐（中性进行时，不断言
    // 具体动作）；#2 空闲等待态（isGenerating 惰性派生存在误显窗口，文案中性不断言
    // 「已暂停」——误显后果轻，显式接受）
    pendingActive: '正在探索与撰写计划文档…',
    pendingIdle: 'agent 暂未推进，可发消息继续',
    // 恢复入口提示：交互语义 = 指引用户发消息（无独立按钮；恢复动作接线归 u-review-source-ui）
    pendingIdleHint: '在对话输入框发送任意消息，提醒 agent 继续推进',
  },
  docs: {
    // 文档面板（plan 模式重设计 u1-docs-panel：L2 文档 tab + meta + 正文）
    sourceLabel: '来源',
    revisingBadge: '修订中',
    // E2：docs 登记的文件不存在（file.read 失败）→ 占位错误态 + agent 可重新产出提示，条目不清
    notFound: '文档不存在或已删除',
    notFoundHint: '该文件可能已被移动或删除。可让 agent 重新产出，或在对话中说明处理方式',
    // 首拉失败（分区 loadError）在面板空态的就近呈现（C-U1）：错误原文 + 恢复指引
    loadErrorHint: '计划状态加载失败，请稍后重试或重开会话',
    // [RD-2#4] tab/修订切换即清正文 + loading 态（请求期间头部已新条目，残留旧正文 = 串内容误读）
    loading: '加载中…',
  },
  comment: {
    // 划选评论（u1-docs-panel：划选文字 → 浮条 → 评论草稿，D6 生命周期）
    trigger: '评论',
    placeholder: '写下你的评论，agent 修订时会逐条消费…',
    cancel: '取消',
    add: '添加评论',
    delete: '删除',
    // 设计 §3.1 失败路径：修订中评论禁用（避免并发修订语义），浮条仍现、按钮不可用
    revisingDisabled: '修订中，暂不能添加评论',
    draftsTitle: '评论草稿（{count}）',
  },
}
