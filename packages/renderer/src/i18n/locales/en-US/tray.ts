/**
 * Composer task tray (built-in four kinds: bash / subagent / workflow / session) — English copy.
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
      session: 'Child sessions',
    },
    /** Bucket view labels (runningProcess is bash-only, see header note; two-view ruling 2026-09-16: no third bucket) */
    bucket: {
      running: 'In progress',
      runningProcess: 'Running',
      ended: 'Finished',
    },
    loading: 'Loading…',
    loadFailed: 'Failed to load ({error})',
    retry: 'Retry',
    /** Empty-bucket hint ({name} = kind title) */
    empty: {
      running: 'No {name} in progress',
      runningProcess: 'No {name} running',
      ended: 'No finished {name}',
    },
    /** Actionable empty state (D9: explicit bucket switch, never auto-jump) */
    viewEnded: 'View finished ({count})',
    /** Row actions (background commands) */
    kill: 'Stop',
    killConfirm: 'Confirm stop',
    killFailed: 'Failed to stop background command: {msg}',
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
    /** Order-3 overflow entry (`»` ellipsis; a different semantic from the aggregate entry's stacked icons) */
    more: 'More tools',
    /** Order-4 aggregate entry (stacked icons + running count): title / aria-label interpolates the count */
    aggregate: {
      title: 'Task tray · {running} running',
    },
    /**
     * Fourth entry "child sessions" (u7, design .tmp/tech-design/mode-system-composer-density.md §6.7 D7).
     * Row status copy mirrors TraySessionPanel's process-level status map (see DISPLAY_STATUS in
     * composables/logic/sessionStatus.ts).
     */
    session: {
      /** Header summary ({total} total · {running} running) */
      header: '{total} total · {running} running',
      empty: 'No child sessions',
      status: {
        running: 'Running',
        done: 'Done',
        error: 'Failed',
        stopped: 'Stopped',
      },
      stop: 'Stop',
      stopConfirm: 'Confirm stop',
      stopFailed: 'Failed to stop child session: {msg}',
      openFailed: 'Failed to open child session: {msg}',
    },
  },
}
