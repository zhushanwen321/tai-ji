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
  // fork pill 三态（D3 源状态三分支 → pill 口径；数据源 = btw.create reply.forkState）
  pill: {
    full: '已含主对话快照',
    truncated: '快照截断（进行中 turn 未完整带入）',
    none: '无快照（源快照不可用）',
  },
}
