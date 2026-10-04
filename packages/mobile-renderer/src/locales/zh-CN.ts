/**
 * 移动壳自有文案（zh-CN）：仅壳层新增 key（tab/列表/表单/composer 等壳 chrome 文案）。
 * 下沉域（ui 组件消费 key）不经本文件——直接来自 @taiji/ui/locale（i18n.ts 合并装配），
 * 双源副本零存在。双侧结构对齐由 __tests__/mobile-locale.test.ts 机器守卫。
 */
export default {
  mobile: {
    connecting: '连接中…',
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
    },
    mermaid: {
      placeholder: '图表在桌面查看',
    },
    pasteImageFallback: '[图片粘贴：需桌面环境]',
  },
}
