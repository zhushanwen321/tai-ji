export default {
  title: '太极',
  waiting: '等待 Runtime 服务…',
  greetingMorning: '上午好呀',
  greetingAfternoon: '下午好呀',
  greetingEvening: '晚上好呀',
  greetingPrompt: '有什么想让我帮忙的吗',
  // 通用关闭 aria-label（内存压力提示条等 dismiss 按钮共用）
  crashDismiss: '关闭',
  // RD-3#11 内存压力提示条（useMemoryPressure level 接入 UI 消费方）
  memoryPressureWarn: '内存占用较高，已自动清理部分缓存',
  memoryPressureCritical: '内存严重不足，建议关闭部分会话',
  // 启动编排失败（useSidebar.initApp catch 面）：恢复动作 = 刷新页面重试
  bootstrapFailed: '应用初始化失败：{msg}，请刷新页面重试',
}
