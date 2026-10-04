export default {
  sendFailed: '消息发送失败：{msg}',
  nextTurnSendFailed: '下轮消息发送失败：{msg}',
  stopFailed: '停止失败：{msg}',
  compactFailed: '压缩失败：{msg}',
  bashFailed: 'Bash 执行失败：{msg}',
  // [U5 消息撤回 D8] 撤回编排 toast 文案（D8 错误规格表呈现列为 SSOT，与 core useChat 的
  // REVOKE_ERROR_TOAST_KEYS 六键一一对应）+ 在途 cancel 腿与 RPC 传输失败文案
  revokeFailed: '撤回失败：{msg}',
  revokeCancelFailed: '撤销投递失败：{msg}',
  revokeDeliveredRace: '消息刚已送达，请再次点击撤回',
  revokeRestoreContentMissing: '撤回成功，但原文恢复失败（内容缺失）',
  revokeBusy: '生成中，停止后可撤回',
  revokeNoMapping: '该消息不支持撤回，可尝试刷新对话流后重试',
  revokeExtensionMissing: '撤回组件未就绪，建议重启会话',
  revokeNavFailed: '撤回未完成，请重试',
  revokePiReclaimed: '会话进程已回收，恢复失败请重试',
  revokeWorkflowRunning: '后台任务运行中，完成或停止后再撤回',

  // 回执不可达（断连/超时收不到 reply）：命令可能已执行——不得说「失败」（会诱导重发双执行），
  // 恢复动作 = 先看对话流确认后再决定是否重跑
  bashOutcomeUnknown: '命令状态未知：可能已开始执行，请先查看对话流确认后再决定是否重跑（{msg}）',
  // `@` 定向消息（U2b）：空文本挡 + RPC 失败（错误可读，S8 恢复动作 = 重试 / 重新 @ 选择）
  subagentDirectiveEmpty: '定向消息内容为空，请输入发送给 subagent 的内容',
  subagentDirectiveFailed: '定向消息发送失败：{msg}',
  providerNameRequired: '供应商名称不能为空',
  oauthSwitchNeedsKey: '改用 API Key 需要输入新的 API Key（保存后将替换 OAuth 凭证）',
  duplicateHeaderKey: '存在重复的 header key，将以最后出现的值为准',
  modelNameRequired: '模型名称不能为空',
  modelAlreadyExists: '模型「{name}」已存在',
  discoveredModels: '已发现 {count} 个模型，{merged}',
  newMerged: '新增 {count} 个已合并',
  allExisted: '均已存在',
  discoverFailed: '发现失败',
  dirNotExist: '目录 {dir} 已不存在，已切换到主目录',
  // E7（D10）cwd 两空 toast：landing 未选目录且无 defaultCwd，静默落主目录的显式提示
  cwdFallbackToHome: '未选择目录，已在主目录创建',
  imageMigratePartialFailed: '{count} 张图片迁移失败（临时文件可能已清理），将尝试用原路径发送',
  loadFailed: '加载失败',
  copyLabel: '复制',
  removeLabel: '移除',
  // skill chip tooltip（C5）：告知发送时注入行为与体量上限（50KB = 注入预算上限）
  skillChipTitle: '发送时注入该 skill 全文（最大 50KB）',
  yesterday: '昨天',
  daysAgo: '{days} 天前',
  dateFormat: '{month} 月 {day} 日',
  searchUnavailable: '搜索服务暂时不可用',
  // 思考等级显示（W2）
  thinkingLevel: {
    off: '关',
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高',
    on: '开',
    default: '思考',
  },
  // 思考策略预设（W2）
  thinkingStrategy: {
    allLevels: '全部档位',
    onOff: '开 / 关',
    highMax: '高 / 最高',
  },
}
