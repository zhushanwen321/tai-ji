// Rolling restart banner namespace (crash-forensics-and-watchdog §3.3 D5 / D3, u7d + deviation #27).
// Four states + reattach high-water deferral; copy mirrors design scenario 2 (defer limit
// 30 min / restart takes about 30-60s / terminal sessions terminate with the restart).
export default {
  // Deferred: waiting for in-flight tasks (bounded: 30-min defer limit)
  deferred: 'Memory is near its limit: the app will restart automatically once background tasks finish (up to 30 minutes); the restart takes about 30-60s. Terminal sessions will terminate with the restart; sessions restore automatically afterwards',
  // Deferred (errs shape reason=absent-report: injected but never reported, count unknown)
  deferredUnknown: 'Memory is near its limit: confirming background task status before restarting automatically (up to 30 minutes); the restart takes about 30-60s. Terminal sessions will terminate with the restart',
  // T-30s second notice (precise countdown from the broadcast; falls back to countdownSoon on status pull)
  countdown: 'Restarting automatically in about {seconds} seconds: terminal sessions will terminate with the restart; sessions restore automatically afterwards',
  countdownSoon: 'Restarting automatically soon: terminal sessions will terminate with the restart; sessions restore automatically afterwards',
  // Red banner (hard threshold 92% / defer limit reached / executing) — immediate, no second notice
  rolling: 'Restarting the runtime: terminal sessions have terminated, sessions are being restored automatically (about 30-60s)',
  // Recovered green (auto-clears after 30s; data source and clearing semantics in useRollingRestartStatus header)
  recovered: 'Restart complete: memory pressure has cleared and sessions have been restored automatically',
  // Reattach high-water deferral (#27: post-crash session restore postponed, no overall time limit, polled per tick)
  reattachDeferred: 'System memory pressure is high; automatic restore of sessions after the crash is postponed (re-checked every {pollSec} seconds and resumes automatically once pressure clears; you can also open sessions manually)',
  dismiss: 'Dismiss',
}
