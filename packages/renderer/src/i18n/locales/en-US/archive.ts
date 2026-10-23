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
    // Time filter (mutually exclusive buckets + all; mono labels are language-neutral)
    filterAll: 'All',
    filterAllTitle: 'All archives',
    filter1d: '1d',
    filter1dTitle: 'Archived within the last day',
    filter23d: '2-3d',
    filter23dTitle: 'Archived 2-3 days ago',
    filter47d: '4-7d',
    filter47dTitle: 'Archived 4-7 days ago',
    filterOlder: '7d+',
    filterOlderTitle: 'Archived more than 7 days ago',
    filterTablistLabel: 'Filter by archived time',
    totalSizeTitle: 'Disk usage of the current filter result (compressed size; entries still compressing count as original size)',
    filterEmpty: 'No archives in this time range',
    batchPurgeAria: 'Delete {count} filtered entries',
    batchPurgeLabel: '{count}',
    batchPurgeConfirm: 'Delete {count} entries?',
    batchPurging: 'Deleting…',
    batchPurgeSuccess: 'Permanently deleted {count} archived sessions',
    batchPurgeKept: 'Permanently deleted {count} archived sessions; subagent records of {kept} entries were conservatively kept because archive data was unreadable',
    batchPurgePartial: 'Permanently deleted {ok}, failed {failed}; the list has refreshed, retry the remaining entries',
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
