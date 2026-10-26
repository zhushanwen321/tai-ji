export default {
  newTask: 'New task',
  search: 'Search',
  developer: 'Developer',
  settingsTitle: 'Settings',
  remoteConnect: 'Remote connect',
  quickAppearance: 'Appearance quick settings',
  quickThemeTitle: 'Theme',
  selectSessionHint: 'Select a session to view files',
  sessionListLoadFailed: 'Failed to load sessions ({error})',
  switchSessionFailed: 'Failed to switch session: {msg}',
  newTaskFailed: 'Failed to create task: {msg}',
  // Archive action toasts (session-archive §5.1 success path; compression runs in
  // background — wording does not claim completion)
  archiveSessionDone: 'Archived "{name}"',
  archiveSessionFailed: 'Archive failed: {msg}',
  // Toolbar archive entry (D10: Archive icon + count badge, hidden at 0)
  archiveEntry: {
    title: 'Archived sessions ({count})',
  },
  deleteFolderFailed: 'Failed to delete folder sessions: {msg}',
  // S7：用 vue-i18n 复数（'|' 分隔单/复数，调用方 t(key, count, { count, error })），
  // 替换原 '(s)' hack；带 error 占位符让用户感知首个失败原因（S3）。
  deleteFolderPartialFailed: '{count} session failed to delete: {error} | {count} sessions failed to delete: {error}',
  // Localized phrase for failed[].code='delete_generating' (runtime delete generating-state
  // gate), interpolated into deleteFolderPartialFailed's {error} slot in place of the raw
  // runtime message (which is compiled Chinese, unreadable to en users). Closed enum: add
  // the entry + useSidebarSessionActions mapping in the same commit for new codes.
  deleteFolderGenerating: 'session is generating, delete skipped',
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
    // downloaded = full semantics (title / confirm dialog context); restart = inline short label in sidebar (single-line width contract)
    downloaded: 'Downloaded, restart to install',
    restart: 'Restart',
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
    // Archive (session-archive D6/D12/D13, u-renderer-entry): hover archive button
    // two-step confirm + generating-state disabled title
    archive: 'Archive',
    archiveConfirm: 'Click again to confirm archive',
    archiveGenerating: 'Cannot archive while generating',
    forkFrom: 'forked from',
    markDone: 'Mark done',
    unmarkDone: 'Unmark done',
    archived: 'Archived',
    // Session detail hover card message count:
    // last row "time · N msgs" two segments, tone aligned with the demo msgs segment
    msgCount: '{count} msgs',
    // Export JSONL: context-menu item; unavailable =
    // disabled-state title shown when sessionFile is missing (pi lazy-write window)
    exportJsonl: 'Export JSONL',
    exportJsonlUnavailable: 'No session file yet (available after the first message is written)',
    assignToProject: 'Assign to project',
    // Context-menu "Move to project" group label (demo .ctx-label authoritative copy; kept
    // separate from the ghost button title "Assign to project")
    moveToProject: 'Move to project',
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
    // Handed-off badge (chat-flow-consistency U9 / S8): persistent small badge on the source
    // session after a completed handoff (badge body) + hover title ({target} = target session
    // display name, falling back to the target id prefix when the target is deleted).
    handoffBadge: 'Handed off',
    handedOffTo: 'Handed off to {target}',
  },
  sessionList: {
    // R6.2 anchored groups (2026-10-11): section header + in-group empty hint; the old
    // "Recent" header and global empty state (empty/newSession) retired with the grouped form
    header: 'Projects & sessions',
    groupEmpty: 'No sessions yet — use the group header "+" to start one here',
    newSessionInProject: 'New task in this project',
    // DefaultProjectHead lightweight row "+": anchor the default project, then create
    newSessionInDefault: 'New task in default project',
    newSessionInFolder: 'New session in this folder',
    deleteFolderConfirm: 'Delete all sessions in this folder?',
    // N8 A/C dual mode (ui-optimize-unified decision 9): mode names of the two-segment
    // icon toggle (hover tooltip)
    modeFlat: 'Flat list',
    modeGroup: 'Group by folder',
  },
  assignProjectFailed: 'Failed to assign to project: {msg}',
  // "Move to project" success feedback (sessions spec §3.3: move + toast on click)
  movedToProject: 'Moved to project "{name}"',
  // Export JSONL feedback (canceled is silent — no toast)
  exportJsonlSuccess: 'Session exported to {path}',
  exportJsonlFailed: 'Export failed ({code}): {message}',
  forceQuitFailed: 'Failed to force quit: {msg}',
  // [delivery-ownership kernel u3c / D10] explicit toast after forceQuit drains undelivered kernel entries into the Composer draft
  forceQuitQueueRecovered: '{count} queued message moved back to draft | {count} queued messages moved back to draft',
  // drain RPC failure (pi already dead / transport error) — recovered text is not reproducible, must surface
  forceQuitQueueRecoverFailed: 'Failed to recover queued messages: {msg}',
  // entries with empty content (cannot be restored to draft; kernel entries already drained, not reproducible) — surface as failure, success toast reports recovered count only
  forceQuitQueueRecoverEmpty: '{count} queued entry could not be restored (empty content) | {count} queued entries could not be restored (empty content)',
  segmentedTab: {
    session: 'Session',
    file: 'File',
    plugin: 'Plugins',
    // tablist container aria-label (sidebar spec §3.1)
    viewLabel: 'Sidebar views',
  },
  // R6.2 anchored groups (the projectSwitcher.* section retired with the card grid:
  // project management now lives inside the sessions view as project groups)
  projectGroup: {
    defaultName: 'Default project',
    currentChip: 'Current',
    newProject: 'New project',
    namePlaceholder: 'Project name, Enter to confirm',
    renameProject: 'Rename project',
    deleteProject: 'Delete project',
    deleteTitle: 'Delete project',
    // Confirm copy states the consequence (sidebar spec §3.7: sessions return to the default project)
    deleteDesc: 'Delete project "{name}"? Its {count} session(s) will return to the default project, and the project itself will be deleted.',
    deleteConfirm: 'Delete',
    cancel: 'Cancel',
  },
  fileTree: {
    loading: 'Loading…',
    loadFailed: 'Load failed (click to retry)',
    emptyDir: '(empty directory)',
  },
  fileView: {
    filterPlaceholder: 'Filter files…',
    loadingTree: 'Loading file tree…',
    loadFailed: 'Load failed ({reason})',
    retry: 'Retry',
    noMatch: 'No matching files',
    noFile: 'No files',
    clearFilter: 'Clear filter',
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
  workflowDetail: {
    terminate: 'Terminate',
    terminateConfirm: 'Confirm terminate?',
    pendingHint: 'Waiting to start',
    agentsLabel: '{count} agents',
    turnsUnit: 'turns',
  },
}
