/**
 * 移动壳自有文案（en-US）：与 zh-CN.ts 逐 key 镜像（结构对齐由 __tests__/mobile-locale.test.ts 守卫）。
 */
export default {
  mobile: {
    connecting: 'Connecting…',
    reconnecting: 'Disconnected, reconnecting…',
    connectionFailed: 'Connection failed',
    connectionFailedHint: 'Refresh this page to retry; if it keeps failing, re-scan the QR code on your desktop',
    tabs: {
      sessions: 'Sessions',
      chat: 'Chat',
    },
    sessionList: {
      empty: 'No sessions yet',
      loadFailed: 'Load failed, tap to retry',
      newTask: 'New task',
      status: {
        active: 'Running',
        idle: 'Idle',
        dead: 'Exited',
        done: 'Done',
        error: 'Error',
        stopped: 'Stopped',
      },
    },
    newTask: {
      title: 'New task',
      cwdLabel: 'Project path',
      cwdPlaceholder: 'Enter absolute project path',
      messageLabel: 'First message',
      messagePlaceholder: 'Describe the task…',
      submit: 'Create and send',
      cancel: 'Cancel',
      required: 'Project path and first message are both required',
    },
    chat: {
      empty: 'No active session',
      start: 'New task',
    },
    composer: {
      placeholder: 'Type a message…',
      send: 'Send',
      stop: 'Stop',
    },
    tokenInput: {
      title: 'Credentials required',
      hint: 'Re-scan the QR code on your desktop (Settings → Remote Access), or paste a token below',
      placeholder: 'Paste access token',
      submit: 'Connect',
      invalid: 'Token is invalid or has been rotated — re-scan on your desktop',
      submitFailed: 'Failed to start connection — check your network and retry',
    },
    mermaid: {
      placeholder: 'View chart on desktop',
    },
    formCard: {
      planReviewTitle: 'Plan awaiting review',
      approve: 'Approve',
      dismiss: 'Dismiss',
      scheduleEchoNote: 'Confirms the prefilled draft; edit on desktop to change details',
      scheduleNotReady: 'Draft incomplete or time has passed — edit on desktop to confirm, or cancel this request',
      emptyForm: 'Empty form — cancel only',
    },
    pasteImageFallback: '[Image paste: desktop only]',
  },
}

/**
 * connection domain (core transport builds disconnect errors via ports.t; keys mirror
 * the desktop renderer locale domain of the same name). Kept out of the default export
 * (the mobile-locale guard requires shell-owned files to be mobile-namespace only);
 * merged into top-level messages by the i18n.ts assembly point.
 */
export const connectionEn = {
  connection: {
    disconnectedError: 'Connection lost',
    runtimeRestarting: 'Runtime is restarting',
    runtimeUnavailable: 'Runtime unavailable',
  },
}
