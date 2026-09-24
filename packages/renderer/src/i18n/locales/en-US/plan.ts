/**
 * Plan mode i18n: modeBar status bar + reviewBar + drawer plan-artifacts tab + docs panel
 * + selection comments.
 */
export default {
  reviewBar: {
    commentsCount: '{count} comments',
    submitRevise: 'Submit comments for revision',
    confirmExecute: 'Approve and execute',
    // D3 set aside (protocol-level dismiss decision, replacing "dismiss = kill turn"): non-destructive
    // (no turn kill, no state loss); copy carries the "keep for later" hint (plan progress and drafts kept)
    dismiss: 'Set aside',
    dismissTip: 'Keep for later: skip this review for now; plan progress and comment drafts are kept',
    revising: 'The agent is revising docs based on your comments; versions update here when done',
    // D8 actionable degraded state (reason-by-source copy): resubmit = after an E3 session restart
    // the agent has not resubmitted yet; otherwise the source stays unknown (never guessed)
    degradedResubmit: 'The review prompt was invalidated by a session restart',
    degradedMissing: 'No review prompt is pending',
    // D8 recovery button (reuses the message-send channel to inject a fixed user message;
    // the agent calls submit-review again per prompt discipline)
    resubmit: 'Resubmit for review',
    resubmitNudge: 'Please resubmit the plan for review',
    resubmitError: 'Resubmit failed: {message}. Retry, or exit plan mode via the "Exit" button on the left',
    // D9 agent self-review line (truncated in the ready branch + full text in a popover)
    selfReviewLabel: 'Agent self-review',
    // §3.5 guard & review: tooltip while "Submit comments for revision" is disabled at 0 drafts;
    // comment count is clickable (review drafts)
    reviseEmptyDisabled: 'Select text in the doc to add comments first, then submit for revision',
    viewDrafts: 'Review comment drafts',
  },
  // PlanModeBar left zone (plan-mode-ux-refactor u-plan-bar: the merged bar owns its keys)
  modeBar: {
    title: 'Plan Mode',
    skillsLabel: 'Skills',
    stageExploring: 'Explore',
    stageWriting: 'Write docs',
    stageReviewing: 'Review',
    // Stage-dot tooltips (meaning of each stage)
    stageExploringTip: 'The agent is exploring requirements; no plan document yet',
    stageWritingTip: 'The agent is writing the plan document',
    stageReviewingTip: 'Plan document is ready and awaiting your review',
    exit: 'Exit',
    // E9: error message embeds the recovery action, the bar stays as-is
    exitError: 'Exit failed: {message}. Fix the issue and retry, or type /plan abort in the conversation',
    // §3.5 exit-confirm Popover (context-aware warnings): revising = the agent-side revision will be
    // aborted (GUI drafts were already cleared at revise submit); with drafts = they will be discarded;
    // first matching warning wins
    exitConfirmTitle: 'Exit plan mode?',
    exitWarnRevising: 'The agent is revising docs; exiting will abort the revision',
    exitWarnDrafts: '{count} comment drafts will be discarded',
    exitConfirm: 'Confirm exit',
    exitCancel: 'Cancel',
  },
  drawer: {
    // plan tab (plan-mode redesign u1-drawer-tab): drawer "plan artifacts" tab.
    // Keys live in the plan domain file — tab semantics belong to plan mode, not panel.sideDrawer
    tabPlan: 'Plan Artifacts',
    noPlan: 'No plan artifacts yet',
    // D13⑩ empty-state guidance contains the /plan start hint (S13 copy anchor)
    planHint: 'Type /plan to start planning; documents produced by the agent appear here',
    // Pending-state matrix (plan-mode-ux-refactor §3.2, u-drawer-gate): two states while isActive && docs empty.
    // #1 aligns with derivePlanStage's exploring semantics (neutral progressive, no specific action asserted);
    // #2 idle-waiting (isGenerating lazy derivation has a brief mis-show window; copy stays neutral,
    // never asserts "paused" — accepted explicitly)
    pendingActive: 'Exploring requirements and drafting the plan document…',
    pendingIdle: 'The agent has not made progress yet; send a message to continue',
    // Recovery-entry hint: interaction semantics = guide the user to send a message (no standalone button;
    // recovery entry is copy-only guidance, landed with u-drawer-gate — no programmatic action)
    pendingIdleHint: 'Send any message in the composer to nudge the agent forward',
  },
  docs: {
    // Docs panel (plan-mode redesign u1-docs-panel: L2 doc tabs + meta + body)
    sourceLabel: 'Source',
    revisingBadge: 'Revising',
    // E2: registered doc file missing (file.read failed) → error placeholder + re-produce hint, entry kept
    notFound: 'Document not found or deleted',
    notFoundHint: 'The file may have been moved or deleted. Ask the agent to re-produce it, or mention it in the conversation',
    // First-load failure (partition loadError) surfaced in the panel empty state (C-U1): raw error + recovery hint
    loadErrorHint: 'Failed to load plan state. Retry later or reopen the session',
    // [RD-2#4] tab/revision switch clears the body + loading state (header shows the new entry while the old body lingering = cross-content misread)
    loading: 'Loading…',
  },
  comment: {
    // Selection comments (u1-docs-panel: select text → popover → draft, D6 lifecycle)
    trigger: 'Comment',
    placeholder: 'Write your comment; the agent consumes each one during revision…',
    cancel: 'Cancel',
    add: 'Add comment',
    delete: 'Delete',
    // Design §3.1 failure path: comments disabled while revising (no concurrent-revision semantics);
    // popover still shows, button unavailable
    revisingDisabled: 'Revising in progress; comments are temporarily disabled',
    draftsTitle: 'Comment drafts ({count})',
  },
}
