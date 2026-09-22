/**
 * btw 旁路提问（btw-question D7，M3-a）i18n：
 * - drawer 命名空间：btw tab 元信息与无内容 fallback（DrawerPanel TabMeta）
 * - panel 命名空间：BtwPanel 线列表头 / 新建入口 / 空态 / 错误条
 * - pill 命名空间：fork pill 三态口径（D3 源状态三分支，创建期一次性，不跨重启回填）
 * 双侧 key 对齐守卫 = locale-sync-check（zh-CN/btw.ts ↔ en-US/btw.ts 逐键对称）。
 */
export default {
  drawer: {
    // drawer 一级 tab 标题（DrawerPanel TabMeta.label）
    tabBtw: '旁路提问',
    // btw tab 无内容面板时的空态（PanelContainer 未注入 / 无线时 fallback）
    noThread: '还没有旁路线',
    threadHint: '主对话推进中，在 composer 点 btw 按钮发起旁路提问',
  },
  panel: {
    // 线列表头部标签
    threadsTitle: '旁路线',
    // 新建线入口（空态 Primary 按钮与头部按钮共用）
    newThread: '新建提问',
    creating: '正在创建…',
    // 线列表空态（空态三要素的说明句；入口 = 新建提问按钮）
    emptyList: '还没有旁路线。点「新建提问」，带着主对话当前进度开问。',
    // 内联错误条（P2 降级：可见失败 + 可重试，不拖垮面板）
    loadFailed: '线列表加载失败',
    createFailed: '创建旁路线失败',
  },
  // composer btw 入口按钮（btw-question D7，M3-b）：常态 title + 有未读/待处理时的计数提示 title
  button: {
    title: '旁路提问',
    unreadTitle: '{count} 条未读旁路回复',
    pendingTitle: '{count} 条旁路线待处理',
  },
  // fork pill 三态（D3 源状态三分支 → pill 口径；数据源 = btw.create reply.forkState）
  pill: {
    full: '已含主对话快照',
    truncated: '快照截断（进行中 turn 未完整带入）',
    none: '无快照（源快照不可用）',
  },
  // M3-c 交互闭环（D8 降级路径：drawer 内联确认条 + 失效提示 + 第四面状态区）
  interaction: {
    // 终态机失效支行内提示（撤下 + badge 清 + 本提示，两路合并收口）
    expiredNotice: '请求已失效',
    dismissExpired: '知道了',
    // 运行期错误边界（单线失败 = 行内错误 + 可重试，不外溢主面板）
    error: '交互区异常，已隔离',
    // badge 待处理态 per-line 挂点 title
    pendingLabel: '待处理',
    // plan 审批降档标题 + 单行意见占位
    planReviewTitle: '计划审批（简版）',
    revisePlaceholder: '修改意见（单行）',
    // 表单降档占位（choice Other / text / dialog input 共用）
    otherPlaceholder: '其他答案…',
    answerPlaceholder: '输入回答…',
    // schedule 降档：无预填草稿时不可一键确认
    scheduleNoDraft: '该表单缺少预填草稿，无法降级确认',
  },
}
