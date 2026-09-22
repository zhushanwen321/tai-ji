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
  // composer btw entry button (btw-question D7, M3-b): resting title + count hint when unread/pending
  button: {
    title: 'Side question',
    unreadTitle: '{count} unread side replies',
    pendingTitle: '{count} side threads pending',
  },
  // fork pill three states (D3 source branches; data source = btw.create reply.forkState)
  pill: {
    full: 'Main-conversation snapshot included',
    truncated: 'Truncated snapshot (in-flight turn not fully carried over)',
    none: 'No snapshot (source snapshot unavailable)',
  },
  // M3-c interaction loop (D8 degraded path: drawer inline confirm bar + expiry notice + fourth-surface status strip)
  interaction: {
    // Terminal-state expiry notice (teardown + badge clear + this notice, two paths merged)
    expiredNotice: 'Request expired',
    dismissExpired: 'Got it',
    // Runtime error boundary (single-line failure = inline error + retry, never escapes the main panel)
    error: 'Interaction area failed; isolated',
    // Badge pending dot per-line anchor title
    pendingLabel: 'Pending',
    // Plan-review downgrade title + single-line comment placeholder
    planReviewTitle: 'Plan review (simple)',
    revisePlaceholder: 'Revision comment (one line)',
    // Form-downgrade placeholders (choice Other / text / dialog input share)
    otherPlaceholder: 'Other answer…',
    answerPlaceholder: 'Type your answer…',
    // Schedule downgrade: no prefilled draft → one-click confirm unavailable
    scheduleNoDraft: 'This form has no prefilled draft; simple confirm unavailable',
  },
}
