export default {
  disconnected: '已断开',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重新连接中…',
  restarting: 'runtime 重启中…',
  failed: 'runtime 不可用，重试多次仍失败',
  // 重试按钮 IPC 失败的用户可见反馈（含「重试」恢复动作）
  restartRequestFailed: 'runtime 重启请求失败：{message}，请重试或重启应用',
  // bootstrap 五步自身失败的真因上屏（与 runtime 启动失败台账通道分开）
  bootstrapErrorCause: '应用初始化失败：{message}',
  errorCause: '原因：{message}',
  retry: '重试',
  runtimeExited: '会话进程已退出：{reason}',
  sessionRequestFailed: '会话请求失败：{message}',
  runtimeRestarting: 'Runtime 正在重启',
  runtimeUnavailable: 'Runtime 不可用',
  requestFailed: '请求失败',
  unknownError: '未知错误',
  disconnectedError: '连接已断开',
}
