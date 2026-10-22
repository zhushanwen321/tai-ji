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
  // Rendered form of design §5.2 failure-path table ("UI presentation + recovery guidance"
  // columns): branches on the error envelope code; unknown codes fall back to the
  // operation-level generic template with the runtime message.
  error: {
    generating: 'Archive failed: the session is still generating (archive_generating). Wait for generation to finish, then archive again',
    alreadyArchived: 'Archive failed: this session already has an archive record (archive_already_archived). Restore or permanently delete it in the archive list first',
    restoreConflict: 'Restore failed: a session file with the same name already exists at the original path (archive_restore_conflict). Handle that session (delete or archive it) before restoring this one',
    corrupted: 'Restore failed: archive data checksum mismatch (archive_corrupted). The archive is corrupted and cannot be restored; the original archive is kept, please report the issue',
    notFound: 'Permanent deletion failed: archive record not found (archive_not_found). The archive list may be stale; reopen the archive list and try again',
    ioError: 'Operation failed: {msg} (archive_io_error). Session state follows the disk, startup self-healing will settle it; retry or check the disk',
  },
}
