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
  },
}
