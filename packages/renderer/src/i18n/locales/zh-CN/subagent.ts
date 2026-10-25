/**
 * SubagentTab 自有文案（M3 relay-spawn-transport D6 降级提示条）。
 *
 * 命名空间形态：本模块 default export 只含 sideDrawer 子树，由 aggregator
 * （locales/zh-CN.ts）展开并入 panel 命名空间——运行时 key = panel.sideDrawer.*。
 * 落本壳而非 @taiji/ui locale：消费方是 renderer 组件（SubagentTab），无 ui 组件消费。
 * en-US/subagent.ts 必须键集合完全一致（守卫 = .githooks/check_i18n_locale_sync.py +
 * __tests__/i18n/locale-sync-check.test.ts）。
 */
export default {
  sideDrawer: {
    /** live 流降级提示（镜像 seq 空洞 → runtime 停止发布；内容以落盘为准，刷新见完整历史） */
    subagentStreamDegraded: '实时流已降级，内容以落盘为准；刷新后可见完整历史',
    /** 停因词悬停提示（SubagentTab 标题栏 subagent-stop-reason；存量缺键补齐） */
    subagentStopReason: '上一轮停因',
    /** 轮收条失败分类悬停提示（subagent-observability §3.4 u8：lastRound.failure 事实） */
    subagentLastRoundFailure: '上一轮失败分类：{cause}',
    /** 被接管标注悬停提示（§3.3.1 P6 第三形态：prompt 未启动 run，无停因与成败） */
    subagentHandledPrompt: '本条任务未启动执行（被扩展接管），无停因与结果',
  },
}
