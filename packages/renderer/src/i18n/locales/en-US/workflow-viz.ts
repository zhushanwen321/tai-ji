/**
 * workflow-viz overlay / DAG canvas / Gantt user-facing copy (workflow-visualization
 * U4). en-US mirror of zh-CN/workflow-viz.ts — key sets must match exactly
 * (guards: .githooks/check_i18n_locale_sync.py + locale-sync-check.test.ts).
 */
export default {
  workflowViz: {
    // overlay shell
    overlayTitle: 'Workflow live view',
    overlayClose: 'Close',
    runStatusRunning: 'Running',
    runStatusDone: 'Completed',
    // DAG canvas
    dagCanvasLabel: 'Workflow structure diagram (DAG)',
    dagZoomHint: 'Scroll to zoom · Drag to pan',
    dagLoading: 'Parsing workflow structure…',
    dagRetryParse: 'Retry parse',
    dagErrorParseFailed: 'DAG parse failed, switched to list view',
    dagErrorNoScriptSource: 'This run was created in a legacy format without a script blueprint',
    dagErrorRecordNotFound: 'No run record found (it may have been cleaned up)',
    dagErrorPathRejected: 'Run record path is not accessible',
    dagErrorChannel: 'Failed to fetch workflow structure',
    noAgentCalls: 'This script has no agent call sites',
    noAgentCallsHint: 'The script only contains script steps with no call sites to show',
    nodeRenderFailed: 'Node render failed',
    // Unmatched instance groups (D2⑥: zero-hit/ambiguous instances are never dropped
    // silently; shown in a dedicated group below the canvas)
    unmatchedGroupTitle: 'Unmatched instances',
    unmatchedPhaseUnknown: 'No phase',
    unmatchedAmbiguous: 'Ambiguous (matched {n} call sites)',
    unmatchedZeroHit: 'No call site matched',
    // Gantt
    ganttEmpty: 'No timeline data yet',
    ganttBackoffTitle: 'Backoff before retry: {ms}ms',
    ganttAttempt: 'Attempt {n}',
    ganttStateRunning: 'Running',
    ganttStateDone: 'Done',
    ganttStateFailed: 'Failed',
    ganttStateCancelled: 'Cancelled',
    // ── Live panel (workflow-visualization U5: multi-level tabs / trace table / event
    // stream / Gantt subpages) ──
    subpage_trace: 'Calls',
    subpage_events: 'Events',
    subpage_gantt: 'Timeline',
    traceColAgent: 'Agent',
    traceColPhase: 'Phase',
    traceColAttempt: 'Attempt',
    traceColStatus: 'Status',
    traceColStarted: 'Started',
    traceColDuration: 'Duration',
    traceColTokens: 'Token',
    traceColResult: 'Result',
    traceEmpty: 'No agent calls in this run yet',
    statusRetrying: 'Retrying',
    chipRunning: 'In progress',
    chipSettled: 'Settled',
    statusDone: 'Done',
    statusFailed: 'Failed',
    attemptLabel: 'attempt',
    elapsedLabel: 'Elapsed {duration}',
    eventsEmpty: 'No event records yet',
    eventsNotFound: 'No event stream record for this run',
    eventsNotFoundHint: 'Legacy-format run or the record has been cleaned up; the event stream is unavailable',
    eventsLoadFailed: 'Failed to load event stream',
    retry: 'Retry',
    truncatedHint: 'Fields truncated (2KB per-field cap): {fields}. Truncated content is display-only; view the full text via the run state file',
    ganttUnavailable: 'Timeline view unavailable; segment summary shown below',
    ganttAttemptSegments: 'Attempt segments',
    ganttPhaseBands: 'Phase bands',
    ganttPhaseTurns: 'Phase turns',
    scriptOnly: 'Script-only',
    scriptOnlyHint: 'This phase dispatched no agent calls (script execution only)',
    phaseSettled: 'Settled',
    turnCount: '{count} turns',
    phaseEventsTitle: 'Phase events',
    phaseEventsUnavailable: 'Event stream unavailable (retry from the Events subpage)',
    phaseEventsEmpty: 'No events belong to this phase',
  },
}
