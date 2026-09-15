/**
 * SessionApiPort —— domain/session 访问后端的唯一通道（TC2 契约）。
 *
 * 端口注入模式：core 定义接口类型，壳层（renderer）把现 api/domains/session 适配注入
 * （与 PlatformPort 同模式：core 定义接口、壳注入实现）。core 不 import @/api。
 * P1 完成后 api domains 迁 core/transport 时只需换注入实现，domain 侧零改动。
 *
 * 契约边界：getHistory 不在此端口（属 chat 域）——selectSession 的 hydrate
 * 经 ChatApiPort（w3 use-session 的 ChatHydratePort 注入回调）承接。
 */
import type { PanelLeaf, SessionGroup, SessionSummary, BatchDeleteResult, ThinkingLevel } from '@taiji/shared'

/**
 * session 后端操作端口。
 * 壳侧实现：renderer 现 api/domains/session（pending/events/request/domains 原样继承，是好地基不动）。
 */
export interface SessionApiPort {
  /** 拉取 session 分组列表（loadSessions 用，填 store.groups） */
  list(): Promise<SessionGroup[]>
  /** 切换 session（selectSession 用；hydrate 不在此端口） */
  switchSession(id: string): Promise<void>
  /**
   * 新建 session（createSessionFlow 用；返回含 cwd 用于 INV-7 降级比对；projectId = D14 创建时归属）。
   * modelOverride/thinkingOverride：Landing Chip 覆盖值，session 创建即带正确模型（B3）。
   * 优先级：override > preset > 全局默认。消除 config.sessions 广播覆盖的竞态。
   */
  create(
    cwd: string,
    label: string,
    presetId?: string,
    projectId?: string,
    modelOverride?: string,
    thinkingOverride?: ThinkingLevel,
  ): Promise<SessionSummary>
  /** 重命名 session（乐观更新后调） */
  rename(id: string, label: string): Promise<void>
  /** 删除单个 session（deleteSession 用） */
  remove(id: string): Promise<void>
  /** 按 cwd 批量删除（deleteFolder 用；返回 deleted/failed 列表） */
  removeByCwd(cwd: string): Promise<BatchDeleteResult>
  /**
   * 迁移 landing 态 tmpdir 图片到 attachments/<sessionId>/（createSessionFlow 的 migrateImages 用）。
   * 签名对齐 renderer api/domains/session.ts（C-W4-1）：
   * - fromPath：源 tmpdir 路径（segment.path）
   * - fileName：磁盘文件全名（segment.fileName，含 uuid 前缀）
   * - 返回 { path }：迁移后 attachments/<sessionId>/ 新路径
   * needsMigrate 是 Segment 字段（迁移判断条件，见 shared/segments.ts），不在此入参——
   * createSessionFlow 内扫描 segment.needsMigrate 命中才调本方法。
   */
  migrateImage(p: { fromPath: string; sessionId: string; fileName: string }): Promise<{ path: string }>
  /**
   * 订阅 config.sessions 广播（bindSessionListBroadcast 用，w3 追加）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组；
   * 返回退订函数。对齐 ChatApiPort.streamSubscribe 的「域内订阅放 api port」模式。
   * 壳侧实现：@/api/events.onGlobalType('config.sessions') 并在适配层提取 msg.payload.groups。
   */
  onConfigSessions(handler: (groups: SessionGroup[]) => void): () => void
}

/**
 * panel 编排端口（壳注入实现，IF3 / C-SS-3 落点）。
 * 壳侧：focusedSessionId 读 usePanelStore().focusedSessionId、loadSession 调 panel.loadSession、
 * openPanel 调 useSideDrawer().open。
 *
 * [P4 s5 drawer-widget-removal] openPanel 参数收窄：panelId 唯一合法值 'sideDrawer'（tasks 面板
 * 已随 tasks 域删除），panelId 参数移除，仅保留 sid（壳侧按 focusedSessionId 路由，sid 透传无
 * 运行时消费）。w3 追加（additive，w2 语义不变）：activePanelId / findPanelBySession——
 * use-session 的 syncSessionToPanel（loadSession 需 activePanelId）与
 * cleanupSessionState（panel 解绑前需按 session 查绑定 panel）编排需要。
 *
 * 迁移约束：core 不 import renderer 任何 store（D4 零跨域 import），壳层经本端口注入实现。
 */
export interface PanelOrchestrationPort {
  /** 当前焦点 session（UI 高亮真相源；null = 无焦点） */
  focusedSessionId(): string | null
  /** 当前活跃 panel id（syncSessionToPanel 用；null = 无活跃 panel） */
  activePanelId(): string | null
  /** 按 session 查绑定 panel（cleanupSessionState 解绑用；null = 未绑定） */
  findPanelBySession(sid: string): PanelLeaf | null
  /** 让指定 panel 载入 session（syncSessionToPanel / selectSession 用） */
  loadSession(panelId: string, sessionId: string | null): void
  /** 打开 drawer panel 并绑定 sid（side drawer 统一入口） */
  openPanel(sid: string): void
}

/**
 * sessionEntry 端口束（renderer-deepening D3）——selectSession 完整 12 步切入链的跨域
 * 步骤注入口。链本体在 use-session.selectSession 单点编排（唯一载体：改时序只改那一处），
 * 跨域动作（chat 订阅/LRU、new-task flow、壳未读标记/文件树）经本端口注入，core 零跨域
 * import（不开 domain 间直接 import 的先例，包拓扑铁律）。
 *
 * 全部成员可选、缺省 no-op：headless/mobile 等未接线环境零新增步骤执行完整链（时序仍按
 * D4 统一链）。时序不变量由链本体承载（见 selectSession 步骤注释），实现侧无需关心顺序。
 * 壳侧适配映射（u5.2 接线）：cancelActiveFlow←useNewTaskFlow / clearUnread←useSessionMarkers /
 * ensureStreamSubscription←useChat 壳包装 / touchRecency / evictLru←useChatStore()（pinia，
 * touchLru/evictIfNeeded） / preloadFileTree←useFileTree。
 */
export interface SessionEntryPort {
  /**
   * 取消活跃的新建任务流（AC-3.10：flow 活跃（landing/overlay）时切 session → flow 转
   * cancelled，防 overlay 卡死 + landing 残留）。无活跃流时实现侧 no-op。
   */
  cancelActiveFlow?(): void
  /** 清除未读标记（用户主动查看该 session，未读 badge 即消） */
  clearUnread?(sessionId: string): void
  /**
   * 建立 session 流订阅（同步注册 events handler + fire-and-forget subscribeSession）。
   * [C-W3-4 / 2026-07-29 handoff 回复丢失事故] 链保证本步先于 syncSessionToPanel——
   * panel 载入后 MessageStream 挂载，订阅必须先就绪否则 snapshot 回放事件被丢。
   */
  ensureStreamSubscription?(sessionId: string): void
  /** 刷新 LRU recency（切入的 session 在 panel 载入前刷新，确保不被本链末尾的驱逐逐出） */
  touchRecency?(sessionId: string): void
  /**
   * 文件树预加载（切 session 即拉取，侧栏「文件」tab 计数立即更新）。fire-and-forget：
   * 实现可返回 Promise（TS 允许赋给 void 返回签名），链不 await、失败不阻断。
   */
  preloadFileTree?(sessionId: string): void
  /**
   * LRU 驱逐（按 recency 驱逐最久未访问的 chat 分区）。panelSessionId = 当前焦点 panel
   * 绑定的 session（链在调用前已完成其 recency 刷新——[lru-panel-exempt-fix] 前半；
   * 透传仅作实现侧上下文，实现执行驱逐本体即可）。
   */
  evictLru?(panelSessionId: string | null): void
}
