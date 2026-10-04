/**
 * 移动壳自有文案（zh-CN）：仅壳层新增 key（tab/列表/表单/composer 等壳 chrome 文案）。
 * 下沉域（ui 组件消费 key）不经本文件——直接来自 @taiji/ui/locale（i18n.ts 合并装配），
 * 双源副本零存在。双侧结构对齐由 __tests__/mobile-locale.test.ts 机器守卫。
 */
export default {
  mobile: {
    connecting: '连接中…',
    reconnecting: '连接已断开，正在重连…',
    connectionFailed: '连接失败',
    connectionFailedHint: '请刷新页面重试；若持续失败，回主机「设置 → 远程访问」重新扫码',
    tabs: {
      sessions: '会话',
      chat: '聊天',
    },
    sessionList: {
      empty: '暂无会话',
      loadFailed: '加载失败，点击重试',
      newTask: '新建任务',
      status: {
        active: '运行中',
        idle: '空闲',
        dead: '已退出',
        done: '已完成',
        error: '出错',
        stopped: '已停止',
      },
    },
    newTask: {
      title: '新建任务',
      cwdLabel: '项目路径',
      cwdPlaceholder: '输入项目绝对路径',
      messageLabel: '第一条消息',
      messagePlaceholder: '描述任务…',
      submit: '创建并发送',
      cancel: '取消',
      required: '项目路径与第一条消息均为必填',
    },
    chat: {
      empty: '没有进行中的会话',
      start: '新建任务',
    },
    composer: {
      placeholder: '输入消息…',
      send: '发送',
      stop: '停止',
    },
    tokenInput: {
      title: '需要访问凭据',
      hint: '回主机「设置 → 远程访问」重新扫码，或在下方粘贴 token',
      placeholder: '粘贴访问 token',
      submit: '连接',
      invalid: 'Token 无效或已被轮换，请回主机重新扫码获取',
      submitFailed: '连接发起失败，请检查网络后重试',
    },
    mermaid: {
      placeholder: '图表在桌面查看',
    },
    formCard: {
      planReviewTitle: '计划待审批',
      approve: '批准执行',
      dismiss: '搁置',
      scheduleEchoNote: '按预填草稿确认；如需修改请在桌面操作',
      scheduleNotReady: '草稿不完整或时刻已过，请在桌面编辑后确认，或取消本次请求',
      emptyForm: '表单内容为空，仅可取消',
      respondFailed: '未送达，连接恢复后可重试',
    },
    pasteImageFallback: '[图片粘贴：需桌面环境]',
  },
}

/**
 * connection 域（core transport 断连错误经 ports.t 构造，流入列表 loadError 等
 * 用户可见面）：key 集与桌面 renderer locale 同名域对齐，语义取桌面文案。不放
 * default export（mobile-locale 守卫要求壳自有文件顶层仅 mobile 命名空间，core
 * 接线文案不是壳 chrome），由 i18n.ts 装配点展开进 messages 顶层。
 */
export const connectionZh = {
  connection: {
    disconnectedError: '连接已断开',
    runtimeRestarting: 'Runtime 正在重启',
    runtimeUnavailable: 'Runtime 不可用',
  },
}
