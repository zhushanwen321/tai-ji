export default {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  restarting: 'Runtime restarting…',
  failed: 'Runtime unavailable after multiple retries',
  // Visible failure feedback when the retry IPC fails (with a "retry" recovery action)
  restartRequestFailed: 'Failed to request runtime restart: {message}. Please retry or restart the app',
  // Root cause of a bootstrap-step failure on the failed screen (separate from the runtime-start ledger)
  bootstrapErrorCause: 'App initialization failed: {message}',
  errorCause: 'Cause: {message}',
  retry: 'Retry',
  runtimeExited: 'Session process exited: {reason}',
  sessionRequestFailed: 'Session request failed: {message}',
  runtimeRestarting: 'Runtime is restarting',
  runtimeUnavailable: 'Runtime is unavailable',
  requestFailed: 'Request failed',
  unknownError: 'Unknown error',
  disconnectedError: 'Connection lost',
}
