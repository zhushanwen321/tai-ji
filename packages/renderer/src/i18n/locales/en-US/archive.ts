/**
 * session archive domain messages (session-archive design D10/D11, renderer side).
 * English counterpart of zh-CN/archive.ts — keys must stay 1:1 (i18n locale sync check).
 */
export default {
  summary: {
    archivedPill: 'Archived',
    restore: 'Restore full session',
    tabUserSummary: 'User summary',
    tabAgentReference: 'Agent reference view',
    tablistLabel: 'Archive summary view',
    agentLabel: 'Assistant · Summary',
    originalProject: 'Project: {name}',
    compressing: 'Compressing',
    generating: 'Generating summary',
    generatingHint: 'Refreshes automatically when background compression completes',
    turnNoAgentText: '(This turn ended with tool calls and has no text reply — skipped in summary)',
    userAttachment: '[Image/attachment message]',
    unnamed: 'Untitled session',
    empty: '(No conversation records)',
  },
  // Archive list view (D10, ArchiveListView)
  entry: {
    header: 'Archived',
    back: 'Back to sessions',
    empty: 'No archived sessions',
    loadFailed: 'Failed to load archive list ({error})',
    purge: 'Delete permanently',
    purgeConfirm: 'Confirm permanent deletion?',
    restoreSuccess: 'Restored "{name}" to its original project group',
    restoreFailed: 'Restore failed: {msg}',
    purgeSuccess: 'Permanently deleted "{name}"',
    purgeFailed: 'Permanent deletion failed: {msg}',
    purgeKeptSubagents: 'Permanently deleted "{name}"; subagent records were conservatively kept because archive data was unreadable ({dir})',
    rowAria: 'Archived session {name}',
  },
  // Main-area summary view host (ArchiveMainView)
  main: {
    noSelection: 'Select a session in the sidebar archive list to view its summary',
  },
}
