/**
 * Import session dialog copy (import-session U5).
 * Error keys map 1:1 to shared ImportErrorCode (+ transport timeout / unknown
 * fallback); new error codes must add copy on both locales and the composable
 * FAILURE_CODES set in sync.
 */
export default {
  title: 'Import Session',
  dialogTitle: 'Import pi Session',
  description: 'Bring in pi session records from disk and continue chatting',
  searchPlaceholder: 'Search by name or Session ID (supports 01a044-style short ID), or paste a .jsonl absolute path',
  allDirs: 'All directories',
  chooseDirBtn: 'Choose other directory',
  chooseDirTitle: 'Choose a sessions directory',
  sessionCount: 'Showing {visible} of {total}',
  dirScanHint: 'Scan scope: top level and first-level subdirectories only; deeper levels are not included',
  group: {
    today: 'Today',
    yesterday: 'Yesterday',
    thisWeek: 'This week',
    earlier: 'Earlier',
  },
  importedBadge: 'Imported',
  cwdMissing: 'Original directory no longer exists; follow-ups will run in home directory',
  importTo: 'Import to',
  cancel: 'Cancel',
  importBtn: 'Import',
  importing: 'Importing…',
  defaultProjectName: 'Default project',
  emptyTitle: 'No matching sessions',
  emptyHint: 'Try a different keyword, or paste the absolute path of a .jsonl file',
  pathImportBtn: 'Import this file',
  pathNoMatch: 'No matching session file found',
  loadFailed: 'Failed to load candidates',
  retry: 'Retry',
  toastImported: 'Imported "{name}" to {project} · continue chatting',
  toastWarnSidecar: 'Project assignment failed: reassign the session to a project manually in the sidebar',
  freshBadge: 'Imported',
  errors: {
    import_source_missing: 'Source file is missing or unreadable: confirm it has not been moved or deleted and retry, or use "Choose other directory" to relocate the sessions directory',
    import_invalid_session: 'Not a valid pi session file (first line lacks a session header): pick a .jsonl session file produced by pi',
    import_marker_filename: 'Filename contains a migration temp marker (.tmp-migrate- / .tmp-import-), likely a migration leftover: pick the original session file',
    import_dir_unreadable: 'Directory is unreadable (insufficient permissions): check directory permissions and retry, or use "Choose other directory" to pick another',
    import_already_imported: 'This session has already been imported: open it directly from the sidebar',
    import_target_conflict: 'The target location is occupied by another session: check whether the source file was renamed or duplicated; import the session file with its original filename instead',
    import_copy_failed: 'Failed to copy the session file (disk space or permission issue): free up disk space or check permissions and retry',
    import_project_invalid: 'Target project is invalid: choose a project again and retry',
    timeout: 'Request timed out: please retry',
    unknown: 'Import failed: please retry',
  },
}
