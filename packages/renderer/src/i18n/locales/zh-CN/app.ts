export default {
  title: '太极',
  waiting: '等待 Runtime 服务…',
  greetingMorning: '上午好呀',
  greetingAfternoon: '下午好呀',
  greetingEvening: '晚上好呀',
  greetingPrompt: '有什么想让我帮忙的吗',
  // T2：renderer 崩溃恢复一次性提示条（文案取设计 T2 原文）
  crashRecovered: '界面已从崩溃中恢复（原因：{reason}），你的会话数据未丢失',
  crashReasonOom: '内存不足',
  crashReasonUnknown: '未知原因',
  crashDismiss: '关闭',
  // RD-3#11 内存压力提示条（useMemoryPressure level 接入 UI 消费方）
  memoryPressureWarn: '内存占用较高，已自动清理部分缓存',
  memoryPressureCritical: '内存严重不足，建议关闭部分会话',
}
