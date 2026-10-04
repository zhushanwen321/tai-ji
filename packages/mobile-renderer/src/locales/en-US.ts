/**
 * 移动壳自有文案（en-US）：与 zh-CN.ts 逐 key 镜像（结构对齐由 __tests__/mobile-locale.test.ts 守卫）。
 */
export default {
  mobile: {
    connecting: 'Connecting…',
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
    },
    mermaid: {
      placeholder: 'View chart on desktop',
    },
    pasteImageFallback: '[Image paste: desktop only]',
  },
}
