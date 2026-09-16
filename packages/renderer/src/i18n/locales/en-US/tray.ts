/**
 * Composer task tray (built-in three kinds) — English copy.
 * Design: docs/design/composer-task-tray.md §3.3 D2/D9 + §3.5 error spec.
 *
 * Namespace shape: default export holds only the `tray` subtree; the aggregator
 * (locales/en-US.ts) spreads it into the `panel` namespace
 * (`panel: { ...panel, ...tray }`) so runtime keys are `panel.tray.*`.
 * Key set must mirror zh-CN/tray.ts exactly (guards: .githooks/check_i18n_locale_sync.py
 * + __tests__/i18n/locale-sync-check.test.ts).
 *
 * Vocabulary note: all three kinds share one bucket label set, except bash — the
 * process-domain kind keeps "Running" while the task-domain kinds (subagent/workflow)
 * use "In progress" (mirrors the domain split registered in sidebar.ts).
 */
export default {
  tray: {
    /** Tray row aria-label (the icon row as one landmark; each icon carries title.<kind>) */
    trayLabel: 'Task tray',
    /** Kind titles (panel aria-label; the shell reuses them for icon title/aria) */
    title: {
      bash: 'Background commands',
      subagent: 'Subagents',
      workflow: 'Workflows',
    },
    /** Bucket view labels (runningProcess is bash-only, see header note) */
    bucket: {
      running: 'In progress',
      runningProcess: 'Running',
      ended: 'Finished',
      archived: 'Archived',
    },
    loading: 'Loading…',
    loadFailed: 'Failed to load ({error})',
    retry: 'Retry',
    /** Empty-bucket hint ({name} = kind title) */
    empty: {
      running: 'No {name} in progress',
      runningProcess: 'No {name} running',
      ended: 'No finished {name}',
      archived: 'No archived {name}',
    },
    /** Actionable empty state (D9: explicit bucket switch, never auto-jump) */
    viewEnded: 'View finished ({count})',
    viewArchived: 'View archived ({count})',
    /** Row actions (background commands) */
    kill: 'Stop',
    killConfirm: 'Confirm stop',
    /** Row actions (subagents) */
    cancel: 'Cancel',
    cancelConfirm: 'Confirm cancel?',
    alreadyEnded: 'Task already finished',
    cancelFailed: 'Failed to cancel subagent: {msg}',
    /** Row actions (workflows) */
    abort: 'Stop',
    abortConfirm: 'Confirm stop?',
    workflowOpFailed: 'Workflow action failed: {msg}',
    /** Row summary units and labels */
    agentsLabel: '{done}/{total}',
    turnsUnit: 'turns',
    tokUnit: 'tok',
    pidLabel: 'pid',
    exitLabel: 'exit',
    /** Background-command status text fallback (aria-label / icon title; judging lives in background-task-bucket SSOT) */
    status: {
      running: 'Running',
      killing: 'Stopping',
      orphaned: 'Orphaned',
      killed: 'Stopped',
      succeeded: 'Succeeded',
      failed: 'Failed',
    },
    /** Panel top banners (bash) */
    corruptBanner: 'Task data corrupted; ignored (.corrupt snapshot kept)',
    disconnectBanner: 'Disconnected; refreshes automatically after reconnect',
  },
}
