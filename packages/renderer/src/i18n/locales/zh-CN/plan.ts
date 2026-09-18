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
}
