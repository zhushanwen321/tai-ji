/**
 * plan 模式 i18n（plan 模式重设计 u1-banner：M1 横幅 + 审批条）。
 * 文案基线 = 用户验收 demo（.tmp/plan-mode-demo/index.html M1 横幅 / 底部审批条）。
 */
export default {
  banner: {
    title: '计划模式',
    hint: '已激活，agent 只读取代码、产出文档，不修改源码',
    skillsLabel: '技能',
    skillsUnspecified: '（未指定）',
    stageExploring: '需求探索',
    stageWriting: '文档撰写',
    stageReviewing: '审阅确认',
    exit: '退出',
    // E9：错误消息内嵌恢复动作（错误 → 恢复闭环），横幅保持原状
    exitError: '退出失败：{message}。修复后重试退出，或手动在对话输入 /plan abort',
  },
  reviewBar: {
    commentsCount: '{count} 条评论',
    requestExplanation: '请求进一步解释',
    submitRevise: '提交评论并要求修订',
    confirmExecute: '确认，开始执行',
    revising: 'agent 正在根据评论修订文档，完成后会在这里更新版本',
    waitingResubmit: '等待 agent 重新提交审批',
  },
  drawer: {
    // plan tab（plan 模式重设计 u1-drawer-tab）：drawer「计划产物」tab。
    // key 落 plan 域文件——tab 语义属 plan 模式域，不并入 panel.sideDrawer
    tabPlan: '计划产物',
    noPlan: '暂无计划产物',
    planHint: '进入计划模式后，agent 产出的文档会显示在这里',
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
