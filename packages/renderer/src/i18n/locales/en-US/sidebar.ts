export default {
  newTask: 'New task',
  search: 'Search',
  developer: 'Developer',
  settingsTitle: 'Settings',
  selectSessionHint: 'Select a session to view files',
  sessionListLoadFailed: 'Failed to load sessions ({error})',
  switchSessionFailed: 'Failed to switch session: {msg}',
  newTaskFailed: 'Failed to create task: {msg}',
  deleteSessionFailed: 'Failed to delete session: {msg}',
  deleteFolderFailed: 'Failed to delete folder sessions: {msg}',
  // S7：用 vue-i18n 复数（'|' 分隔单/复数，调用方 t(key, count, { count, error })），
  // 替换原 '(s)' hack；带 error 占位符让用户感知首个失败原因（S3）。
  deleteFolderPartialFailed: '{count} session failed to delete: {error} | {count} sessions failed to delete: {error}',
  renameFailed: 'Rename failed: {msg}',
  retry: 'Retry',
  update: {
    newVersion: 'New version available',
    newVersionWithVersion: 'New version v{version} available',
    versionTransition: 'Current v{from} → v{to}',
    downloading: 'Downloading {percent}%',
    replacing: 'Replacing',
    restarting: 'Restarting',
    error: 'Update failed',
    goToDownload: 'Go to download',
    downloaded: 'Downloaded, restart to install',
    restartInstall: 'Restart and install update',
    confirmInstall: 'Version v{version} is downloaded. Restarting now will interrupt all current tasks (including AI sessions). Continue?',
    installLater: 'Later',
    installNow: 'Restart and install now',
    retry: 'Retry',
    // Launch result toasts (D5: upgrade success/failure/rollback notifications)
    upgradedToast: 'Upgraded to v{version}',
    upgradeFailed: 'Last upgrade did not complete',
    rolledBack: 'Last upgrade did not complete, reverted to v{version}',
    // A-D1: failure-reason messages (error-code→key mapping in useAppUpdate LAUNCH_FAILURE_ERROR_KEYS)
    upgradeFailedReadOnly: 'App is in a read-only location (e.g. DMG). Move it to Applications and retry',
    upgradeFailedBackup: 'Failed to back up the old version. Check disk space and retry',
    upgradeFailedExtract: 'Failed to extract the new version. Check disk space and retry',
    upgradeFailedInternal: 'An internal error occurred. Check for updates and retry',
    upgradeFailedMove: 'Failed to replace files. Check disk space and retry',
    upgradeFailedSha: 'New version failed verification. Please download the update again',
    upgradeFailedSwap: 'Failed to replace the app. Check disk space and retry',
    upgradeFailedAppRunning: 'Update interrupted because the app did not quit. Restart and retry',
    upgradeFailedInstaller: 'The installer failed. Please download the update again',
    // RM2.3: non-intrusive hint while rate-limit backoff is active (not an error state; generalized to all-source rate limiting with multi-source)
    rateLimited: 'Update check service is rate limited; auto-check paused for about 2 hours',
    staleRelease: 'A newer version was detected; update info refreshed',
    // update-network-resilience D9: manual-download escape hint appended to network/proxy error suggestions
    manualDownloadHint: 'You can also download the installer from the releases page, put it into the manual update folder, then retry (folder path: Settings → Update → Manual update channel)',
  },
  sessionItem: {
    rename: 'Rename',
    delete: 'Delete',
    deleteConfirm: 'Confirm delete?',
    forkFrom: 'forked from',
    markDone: 'Mark done',
    unmarkDone: 'Unmark done',
    archived: 'Archived',
    assignToProject: 'Assign to project',
    quoteToComposer: 'Quote to composer',
    // agent-managed-session U8：agent 创建的 session 标记 badge（语言无关 token，两侧同文案）
    agentBadge: 'AI',
    viewParent: 'View parent session',
    // 强制退出（右键两段确认）：卡死 session 无停止按钮时的逃生入口
    forceQuit: 'Force quit',
    forceQuitConfirm: 'Confirm force quit?',
    // 软停止（右键两段确认，ForkGroup 退役后迁入通用行）：运行中菜单项「停止」
    stop: 'Stop',
    stopConfirm: 'Confirm stop?',
    // Child-session count chip (D9): tooltip of the neutral chip on the parent row. The number
    // counts unfinished children (non-green: active / error / stopped / dead), hence "unfinished"
    // rather than "running".
    childCount: '{n} child session unfinished | {n} child sessions unfinished',
  },
  sessionList: {
    empty: 'No sessions',
    newSession: 'New session',
    newSessionInFolder: 'New session in this folder',
    deleteFolderConfirm: 'Delete all sessions in this folder?',
  },
  assignProjectFailed: 'Failed to assign to project',
  forceQuitFailed: 'Failed to force quit: {msg}',
  // [session-dead structural fix D3] explicit toast after forceQuit recovers the defer queue into the Composer draft
  forceQuitQueueRecovered: '{count} queued message moved back to draft | {count} queued messages moved back to draft',
  segmentedTab: {
    session: 'Session',
    file: 'File',
    plugin: 'Plugins',
  },
  projectSwitcher: {
    defaultName: 'Default project',
    newProject: 'New project',
    namePlaceholder: 'Project name',
    deleteProject: 'Delete project',
    deleteTitle: 'Delete project',
    deleteDesc: 'Delete project "{name}"? This cannot be undone.',
    deleteConfirm: 'Delete',
    cancel: 'Cancel',
  },
  fileTree: {
    loading: 'Loading…',
    loadFailed: 'Load failed (click to retry)',
    emptyDir: '(empty directory)',
  },
  fileView: {
    hideIgnored: 'Hide ignored files',
    showIgnored: 'Show ignored files',
    ignoredItem: 'Ignored',
    filterPlaceholder: 'Filter files…',
    loadingTree: 'Loading file tree…',
    loadFailed: 'Load failed ({reason})',
    retry: 'Retry',
    noMatch: 'No matching files',
    noFile: 'No files',
  },
  renameDialog: {
    title: 'Rename session',
    desc: 'Change the display name of the session',
    nameLabel: 'Name',
    namePlaceholder: 'Enter session name',
    cancel: 'Cancel',
    confirm: 'Confirm',
    validationRequired: 'Name is required',
    validationMaxLength: 'Name cannot exceed {max} characters',
    validationPattern: 'Newlines not allowed, max {max} characters',
  },
  // [HISTORICAL] 2026-09-16 sidebar task tabs retired: the four dead-key groups (subagent
  // list / subagent filter bar / workflow list / "background commands" L2 view) are deleted —
  // their consumer components were retired in the same batch; task copy now lives in the
  // composer tray namespace `panel.tray.*` (locales/en-US/tray.ts).
  // [C7 word-choice note, migrated] The former deliberate split between "Running" (task-scoped:
  // subagent sessions with a round in flight) and "Running" (process-scoped: background commands)
  // is now registered in two places: tray.ts file header [term ruling]
  // (`panel.tray.bucket.running` task scope / `panel.tray.bucket.runningProcess` process scope)
  // and the turnProgress section of this file. A true conceptual difference — do not unify.
  workflowDetail: {
    terminate: 'Terminate',
    terminateConfirm: 'Confirm terminate?',
    pendingHint: 'Waiting to start',
    agentsLabel: '{count} agents',
    turnsUnit: 'turns',
  },
}
