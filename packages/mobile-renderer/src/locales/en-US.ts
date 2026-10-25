/**
 * 移动壳自有文案（en-US）：与 zh-CN.ts 逐 key 镜像（结构对齐由 __tests__/mobile-locale.test.ts 检查）。
 */
export default {
  mobile: {
    connecting: 'Connecting…',
    reconnecting: 'Disconnected, reconnecting…',
    restarting: 'Server restarting, will be back…',
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
      restore: 'Reopen',
      menuRename: 'Rename',
      menuDelete: 'Delete',
      renameTitle: 'Rename session',
      renamePlaceholder: 'Enter session name',
      renameConfirm: 'Save',
      status: {
        streaming: 'Generating',
        pending: 'Pending',
        compacting: 'Compacting',
        waiting: 'Waiting for input',
        retrying: 'Retrying',
        working: 'Background work',
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
      queueSend: 'Queue message',
      sendHint: 'Type a message to send',
      stop: 'Stop',
      stopCompacting: 'Stop compacting',
      sendFailed: 'Not delivered — check your connection and retry',
    },
    queueStrip: {
      stateQueued: 'Queued',
      stateInFlight: 'Delivering',
      stateFailed: 'Unconfirmed',
      cancel: 'Cancel delivery',
      cancelFailed: 'Cancel failed: {msg}',
      cancelUnavailable: 'Message already delivered — cannot cancel',
      cancelUnavailableWithReason: 'Cannot cancel: {reason}',
      restoreContentMissing: 'Message cancelled, but its original text could not be recovered — please retype it',
      // ✎ edit (chat-flow-consistency D6 mobile minimal form: peek prefill + anchor + banner)
      edit: 'Edit queued message',
      editingBanner: 'Editing queued message · replaces it in place on send',
      editingBannerAbandon: 'Abandon edit',
      editConflict: 'Already editing another message — abandon that edit first',
      editGone: 'Original message is no longer in the queue',
      editPeekFailed: 'Failed to fetch original text: {msg}',
      // Edit-reply four-value toasts (Q3: content always goes out as a new message, only the toast differs)
      editDelivered: 'Original message was delivered; your edit was sent as a new message',
      editCancelled: 'Original message was cancelled; your edit was sent as a new message',
      editNotFound: 'Original message is gone; your edit was sent as a new message',
      editUnconfirmed: 'Delivery status of the original message unconfirmed; your edit was sent as a new message',
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
    errorBar: {
      responseNotDelivered: 'Reply not delivered — retry after the connection is restored',
      dismiss: 'Dismiss',
    },
    subagentStatus: {
      running: 'Subagents running: {slugs}',
    },
    formCard: {
      planReviewTitle: 'Plan awaiting review',
      approve: 'Approve',
      dismiss: 'Dismiss',
      scheduleEchoNote: 'Confirms the prefilled draft; edit on desktop to change details',
      scheduleNotReady: 'Draft incomplete or time has passed — edit on desktop to confirm, or cancel this request',
      emptyForm: 'Empty form — cancel only',
      respondFailed: 'Not delivered — retry after the connection is restored',
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
    sessionRequestFailed: 'Session request failed: {message}',
  },
}
