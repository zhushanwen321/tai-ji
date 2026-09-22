/**
 * btw side-question (btw-question D7, M3-a) i18n:
 * - drawer namespace: btw tab meta and no-content fallback (DrawerPanel TabMeta)
 * - panel namespace: BtwPanel thread-list header / new-thread entry / empty state / error strips
 * - pill namespace: fork pill three-state copy (D3 source branches, creation-time only,
 *   never backfilled across restarts)
 * Both-side key parity guard = locale-sync-check (zh-CN/btw.ts ↔ en-US/btw.ts).
 */
export default {
  drawer: {
    // drawer L1 tab title (DrawerPanel TabMeta.label)
    tabBtw: 'Side Question',
    // empty-state fallback when no content panel is injected for the btw tab
    noThread: 'No side threads yet',
    threadHint: 'Ask alongside the main turn with the btw button in the composer',
  },
  panel: {
    // thread-list header label
    threadsTitle: 'Side threads',
    // new-thread entry (shared by the empty-state primary button and the header button)
    newThread: 'New question',
    creating: 'Creating…',
    // thread-list empty state (explanation line of the empty-state triad; entry = New question)
    emptyList: 'No side threads yet. "New question" forks the current main-conversation progress.',
    // inline error strips (P2 degradation: visible failure + retry, never drags down the panel)
    loadFailed: 'Failed to load thread list',
    createFailed: 'Failed to create a side thread',
  },
  // composer btw entry button (btw-question D7, M3-b): resting title + count title when unread
  button: {
    title: 'Side question',
    unreadTitle: '{count} unread side replies',
  },
  // fork pill three states (D3 source branches; data source = btw.create reply.forkState)
  pill: {
    full: 'Main-conversation snapshot included',
    truncated: 'Truncated snapshot (in-flight turn not fully carried over)',
    none: 'No snapshot (source snapshot unavailable)',
  },
}
