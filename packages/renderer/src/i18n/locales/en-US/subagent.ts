/**
 * SubagentTab copy (M3 relay-spawn-transport D6 degraded notice).
 *
 * Namespace shape: default export holds only the `sideDrawer` subtree; the aggregator
 * (locales/en-US.ts) spreads it into the `panel` namespace so runtime keys are
 * `panel.sideDrawer.*`. Kept in the shell (not @taiji/ui locale) because the consumer is a
 * renderer component (SubagentTab), not a ui component. Key set must mirror
 * zh-CN/subagent.ts exactly (guards: .githooks/check_i18n_locale_sync.py +
 * __tests__/i18n/locale-sync-check.test.ts).
 */
export default {
  sideDrawer: {
    /** Live-stream degraded notice (mirror seq gap → runtime stopped publishing; disk is authoritative, reload for full history) */
    subagentStreamDegraded: 'Live stream degraded — content follows the saved transcript; reload for the full history',
  },
}
