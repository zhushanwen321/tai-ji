/**
 * plan mode i18n (plan-mode redesign u1-banner: M1 banner + review bar).
 * Copy baseline = user-accepted demo (.tmp/plan-mode-demo/index.html M1 banner / bottom action bar).
 */
export default {
  banner: {
    title: 'Plan Mode',
    hint: ' active — the agent reads code and writes docs only, never modifies source',
    skillsLabel: 'Skills',
    skillsUnspecified: '(unspecified)',
    stageExploring: 'Explore',
    stageWriting: 'Write docs',
    stageReviewing: 'Review',
    exit: 'Exit',
    // E9: error message embeds the recovery action, banner stays as-is
    exitError: 'Exit failed: {message}. Fix the issue and retry, or type /plan abort in the conversation',
  },
  reviewBar: {
    commentsCount: '{count} comments',
    requestExplanation: 'Request explanation',
    submitRevise: 'Submit comments for revision',
    confirmExecute: 'Approve and execute',
    revising: 'The agent is revising docs based on your comments; versions update here when done',
    waitingResubmit: 'Waiting for the agent to resubmit for review',
  },
  drawer: {
    // plan tab (plan-mode redesign u1-drawer-tab): drawer "plan artifacts" tab.
    // Keys live in the plan domain file — tab semantics belong to plan mode, not panel.sideDrawer
    tabPlan: 'Plan Artifacts',
    noPlan: 'No plan artifacts yet',
    planHint: 'Documents produced by the agent appear here after entering plan mode',
  },
}
