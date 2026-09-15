/**
 * session 状态。
 *
 * 三态（进程级，runtime 维护）：
 * - 'active'：pi 进程存活且正在生成
 * - 'idle'：session 存在但 pi 未在生成（内存 session 默认态 / 磁盘历史 session 扫描态）
 * - 'dead'：pi 进程异常退出（前端收到 session.exited 后标记）。dead session 在侧栏置灰，
 *   panel 显示「进程已退出」占位，点击「重新打开」触发 restore 重新 spawn pi。
 *
 * 终态（W5，ADR 0042，来自 session_end entry）：
 * - 'done'：正常完成
 * - 'error'：LLM 出错
 * - 'stopped'：用户 abort / 进程崩溃
 *
 * 新增态加在末尾以避免破坏现有 active/idle/dead 序列消费方。
 * 历史 session（方案上线前产生，无 session_end entry）一律 idle（渐进迁移）。
 */
export type SessionStatus = 'active' | 'idle' | 'dead' | 'done' | 'error' | 'stopped'

/**
 * 条目/快照数据来源标记（W15 磁盘占位值守卫的判定依据，D1b 按来源分流）。
 *
 * - `'scan'`：磁盘扫描来源（SessionScanner.scannedToSummary 产出）。扫描读不出
 *   modelId / tokenCount 真值，其 `''` / `0` 是**占位值**而非权威空值——core 合并侧
 *   （createSessionStore.mergeViewSnapshot 守卫）据此跳过对已知真值的覆盖
 *   （#2 空串覆盖事故的最后防线）。
 * - 缺省（undefined）：owner 来源——runtime 活跃实例 / 广播 / 乐观更新，D1b 整字段
 *   覆盖的权威语义，显式空值（''/0）按「owner 声明空即空」正常覆盖。
 */
export type SessionDataSource = 'scan'

export interface SessionSummary {
  id: string
  label: string
  cwd: string
  gitBranch?: string
  gitIsWorktree?: boolean
  /**
   * 是否处于 bare repo + worktree 结构（cwd 位于 .bare 目录下某级）。
   * 由 runtime WorkspaceDetector 检测填充（SessionService.toSummary / SessionScanner.scannedToSummary）。
   * 前端 Landing.vue 据此派生 DirSelectPopover「新建 worktree…」动作项显隐
   * （useNewTaskFlow.gitInfo.isBare）。未检测（undefined）→ 前端按 false 兜底。
   */
  isBareWorkspace?: boolean
  status: SessionStatus
  lastActiveAt: number
  modelId: string
  thinkingLevel?: string
  tokenCount: number
  /**
   * session JSONL 文件绝对路径。活跃 session 来自 pi get_state 的 sessionFile
   * （create 时写入 IManagedSessionView.sessionFilePath）；持久化 session 来自磁盘扫描
   * ScannedSessionMeta.filePath。可能为空——pi 延迟写入窗口（首条 assistant 消息前文件
   * 未落盘，规则 #6），此时 header 不展示文件名。前端 PanelHeader 据此渲染短文件名 +
   * 点击复制完整路径。
   */
  sessionFile?: string
  /**
   * 归属 project id（D14 语义修正，2026-08-04）：session 创建时归属当前 activeProject，
   * 与 cwd 无关（project 可跨目录）。无值 = 未归类，展示层归入默认项目（proj-default 兑底）。
   * 持久化在独立 sidecar `<sessionFile>.project.json`（与 preset sidecar 同模式），
   * runtime 扫描时读取填充。fork 继承父归属。
   */
  projectId?: string
  /**
   * 隐藏 session（如公共 session）：不显示在 sidebar session 列表，仅供内部使用（如
   * landing 态命令源）。scanner listAll 过滤掉 hidden:true 的 session。
   */
  hidden?: boolean
  /**
   * 条目数据来源（W15）：'scan' = 磁盘扫描条目（modelId/tokenCount 为占位值，见
   * SessionDataSource）；缺省 = 活跃实例真值（SessionService.toSummary 产出，不标）。
   */
  source?: SessionDataSource
  /**
   * 父 session 文件路径（fork 血缘键）。fork 出的 session 在 header 记录此字段指回源文件，
   * 形成 fork 父子链。源 session 尚未落盘（pi 延迟写入窗口）时用源 sessionId 作 fallback 键
   * （FR-20，避免血缘断裂）。非 fork 产出的顶层 session 无此字段。
   */
  parentSession?: string
  /** fork 锚点 entry id：fork 截断点的 pi entryId，供后续 merge 定位 fork 点。 */
  forkEntryId?: string
  /** handoff 后指向新 session（痛点3 基础层）：源 session 交接给新 session 后记录其 id。 */
  handedOffTo?: string
  /** 上次 merge 时间（占位，痛点2 基础层）。 */
  lastMergedAt?: number
  /**
   * session 创建时锁定的预设 ID。
   *
   * 持久化在独立 sidecar `<sessionFile>.preset.json`（不是 .meta.json——.meta.json 是
   * session 终态 sidecar，session 结束时才写）。见设计文档 §4.1。
   *
   * session 活跃期间通过 IManagedSessionView 内存态保存，create() 成功后立即写 preset sidecar。
   * restoreSession 时从此 sidecar 读取，用此 preset 重新构建 pi args。
   */
  launchPresetId?: string
  /**
   * 发起来源：'user' = 用户手动创建（默认），'agent' = agent 通过 session-manager 创建。
   * 运行期为内存态（handler 注入），重启后从 .agent.json sidecar 恢复。
   * 用于 session-manager list 过滤和前端展示区分。
   */
  spawnSource?: 'user' | 'agent'
  /**
   * 父 agent session id。spawnSource='agent' 时由 handler 服务端注入（interpreter 路由的
   * sessionId），持久化于 .agent.json sidecar，重启后从 sidecar 恢复。
   * 用于 session-manager list 按 parentAgentSessionId 过滤子 session。
   */
  parentAgentSessionId?: string
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
