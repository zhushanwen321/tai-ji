/**
 * 导入会话 RPC 契约（runtime ↔ renderer 共享，接口先行；pi / zcode 多源）。
 *
 * 来源设计：docs/design/import-session.md（已删除，git 可追溯）§3.3 D5「RPC 契约（接口先行）」
 * 及同章「错误规格表」（错误码权威清单）；多源扩展（ImportSourceKind / source /
 * sessionId / dbPath / conversion_degraded）见 docs/architecture/session-import-sources.md
 * 「RPC 契约」节。
 *
 * ## 契约形态
 *
 * 两个 WS 命令（ws-client sendCommand 模式，与 session.list 同族）：
 * - `session.importCandidates` — 候选列表（打开对话框 / 搜索 / 切目录时调用，
 *   renderer 侧 debounce 250ms）
 * - `session.import` — 执行导入（点「导入」）
 *
 * 消息类型字符串与 case 分发由 runtime transport 层（u3-rpc-wiring）登记，
 * 本文件只承载 payload/reply 的类型定义，供两端共同 import 防止裁量漂移。
 *
 * ## 语义约定（非类型字段，runtime 与 renderer 共同遵守）
 *
 * - `rootDir` 缺省 = pi 全局 agent 目录下的 sessions，由 runtime 动态推导
 *   （复用/导出 pi-maintenance.ts 的 getPiGlobalAgentDir 逻辑），禁止硬编码
 *   字面量（pre-commit check_path_whitelist 会拦）。
 * - `query` 匹配字段集是**源行为**（source 各自定义，runtime 按 source 路由到
 *   对应实现，契约不规定统一字段集）：
 *   - pi = 现状五字段不变：name ∪ 完整 sessionId ∪ uuid 前 6 位短 ID ∪
 *     sourcePath ∪ dirLabel，全部 case-insensitive includes；query.trim() 以
 *     '/' 或 '~' 开头时 renderer 切换「路径模式」（runtime 无需特殊分支——
 *     sourcePath 的 includes 匹配天然覆盖）。
 *   - zcode = name ∪ sessionId ∪ cwd（directory）∪ dirLabel——sessionId 前缀
 *     自带 `sess_`，短 ID 截断无区分度，用整串 includes 已覆盖；sourcePath 在
 *     zcode 侧是 db 路径结构占位（契约同构），不参与匹配。
 * - `items` 按 lastModified 降序排列，截 `limit`（默认 100）；`total` 是
 *   过滤前总数。扫描深度 = 顶层 + 一层子目录（与太极根同构），更深层静默跳过。
 * - `alreadyImported` 用默认 TTL 读打标（列表展示允许秒级 stale）；真正的
 *   导入幂等校验在 `session.import` 互斥区内 force 读双检（D4）。
 * - `warning` 走成功 reply 的可选字段而非 error envelope（r4-INFO）：
 *   文件已落地不回滚，renderer 降级 toast 引导手动归类。
 */
/**
 * 导入源类型：'pi' = 现状 pi session JSONL 目录扫描源；'zcode' = zcode 宿主库
 * （sqlite 只读）。第三个 coding-agent 源接入时在此登记新字面量（G2 可扩展，
 * 见 docs/architecture/session-import-sources.md「新增一个源」步骤）。
 */
export type ImportSourceKind = 'pi' | 'zcode'

/**
 * 导入成功 reply 的可选警示字面量（走成功通道而非 error envelope，r4-INFO：
 * 文件已落地不回滚，renderer 降级 toast）：
 * - `sidecar_failed`：sidecar 写失败（readback 不符），toast 引导手动归类。
 * - `conversion_degraded`：源转换存在知情降级（zcode→pi 映射的降级决策非空，
 *   如部分 part 形态跳过），toast 知情提示，无需动作。
 */
export type ImportWarning = 'sidecar_failed' | 'conversion_degraded'

/**
 * 结构化降级记录（zcode→pi 转换的信息损失按性质分档，D4 四档显形，
 * zcode-import-message-projection 设计 §7.4；wire 契约只承载类型，全量明细走
 * runtime 日志不入 reply）。档位与 code 对应：
 * - L1 冗余丢弃 → `dropped_redundant`
 * - L2 无语义丢弃 → `dropped_transient`
 * - L3 保真损失 → `truncated_output` / `compaction_unlinked`
 * - L4 未知/漂移 → `unclassified`（升 `conversion_unclassified` warning 码——该字面量
 *   随 runtime 导入链结构化接线登记进 ImportWarning，当前先承载类型定义）
 *
 * 与 `@zhushanwen/session-core` 的 `ImportDegradation` 结构等价（基座零依赖不反向
 * import shared，两侧字段逐一同步，消费点类型检查拦截漂移）。
 */
export interface ImportDegradation {
  /** 降级码（五值闭集，语义见接口块注释） */
  code:
    | 'dropped_redundant'    // L1：内容已由 tool 通道保留的运行时注入（background_* / subagent_* 族），丢弃无损
    | 'dropped_transient'    // L2：无对话语义的瞬态/注入形态（todo 提醒 / system_reminder / timeline 等），非 L1/L3/L4 的丢弃类全量归入
    | 'truncated_output'     // L3：tool part serialization.truncated=true，保留截断版 output（保真损失）
    | 'compaction_unlinked'  // L3：compact_summary 与 compaction part 关联断裂（summaryMessageId 悬空）；摘要宿主降级路径 = 现状通道（宿主 user entry + compaction part 的 custom entry），合并路径悬空指针 part 补发 custom entry（保真损失）
    | 'unclassified'         // L4：semantics.kind / source / origin 超出闭集，丢弃 + 独立告警（G3 未知不静默）
  /** zcode semantics.kind 原值（L4 未分类时必有；L1/L2 聚合档按 (kind, source) 维度携带） */
  kind?: string
  /** metadata.source / source 原值（同上，L4 未分类时必有） */
  source?: string
  /** 该 (code, kind, source) 维度的聚合计数 */
  count: number
  /**
   * 定位样本（unclassified 必带，便于用户反馈/维护者定位；part 级诊断记录可
   * 携带 sample 便于日志定位，明细不入 wire）：messageId + 文本前 80 字。
   */
  sample?: {
    messageId: string
    preview: string
  }
  /** zcode schema_migration.app_version（回归定位锚，按可得性携带） */
  zcodeSchemaVersion?: string
}

/**
 * 降级摘要（`ImportReply.degradationSummary` 的载荷类型，toast 计数/sample 的最小
 * 契约通道，设计 §7.4）：仅在 warning 含 conversion_* 时携带；全量明细（含 L3
 * 截断明细）走 runtime 日志不入 wire。不设 truncatedCount——L3（截断保留）在
 * toast 上无对应分句，避免契约面搭车无消费字段。字段随批 2 runtime 接线挂上
 * ImportReply，当前先承载类型定义。
 */
export interface ImportDegradationSummary {
  /** L1+L2 聚合（dropped_redundant + dropped_transient 的 count 总和）——toast 汇总分句数据源 */
  droppedCount: number
  /** L4 聚合；本次导入无 unclassified 降级时为 null */
  unclassified: {
    count: number
    /** 首条 unclassified 的定位样本 */
    firstSample?: ImportDegradation['sample']
  } | null
}

/** 候选列表请求（`session.importCandidates` payload） */
export interface ImportCandidatesRequest {
  /** 外部扫描根目录。缺省 = pi 全局 agent 目录下的 sessions（runtime 动态推导，禁止硬编码） */
  rootDir?: string
  /** 搜索词（语义见文件头「query 匹配字段集」约定——字段集是源行为，按 source 分列） */
  query?: string
  /** items 截断数（默认 100） */
  limit?: number
  /** 导入源（缺省 'pi'——存量 renderer 调用不传 = 行为不变，向后兼容） */
  source?: ImportSourceKind
}

/** 候选条目（reply.items 元素，按 lastModified 降序） */
export interface ImportCandidate {
  /**
   * 会话 id（两源通用单字段，契约同构使列表行渲染零改动）：pi = header uuid；
   * zcode = **原始** session.id（`sess_` 前缀形态，归一化前的源形态——它是源系统
   * 主键，source 内部打标/导入时才做 T1 归一化，见 ImportRequest.sessionId 注释）。
   */
  sessionId: string
  /** session 名称（header 无 name 时为 null） */
  name: string | null
  /** 原工作目录（header.cwd） */
  cwd: string
  /** 源文件绝对路径（路径模式搜索匹配字段之一） */
  sourcePath: string
  /** 文件 mtime（ms），列表排序键（降序） */
  lastModified: number
  /** 文件大小（bytes） */
  size: number
  /** 所属子目录名（目录 chip 分组用，与 dirs[].label 对应） */
  dirLabel: string
  /** 已在太极扫描集（默认 TTL 读，允许秒级 stale；导入校验另走 force 双检） */
  alreadyImported: boolean
  /** existsSync(header.cwd)；false 时 UI 标注「原目录不存在，续聊将在主目录执行」（MF-2） */
  cwdExists: boolean
}

/** 目录分组条目（reply.dirs 元素，目录 chip 下拉用） */
export interface ImportCandidateDir {
  /** 子目录名（一层深度，与 dirLabel 对应） */
  label: string
  /** 该目录下候选数 */
  count: number
}

/** 候选列表响应（`session.importCandidates` reply） */
export interface ImportCandidatesReply {
  /** 过滤前总数（供 UI 显示「共 N 个」与截断提示） */
  total: number
  /** 按 lastModified 降序、截 limit 的候选条目 */
  items: ImportCandidate[]
  /** 该根下全部一层子目录（chip 下拉；扫描深度=顶层+一层子目录，更深层静默跳过） */
  dirs: ImportCandidateDir[]
}

/** 执行导入请求（`session.import` payload） */
export interface ImportRequest {
  /**
   * 源定位（pi 必填）：源文件绝对路径（对话框路径模式直接传入候选的 sourcePath）。
   * zcode 源不消费（以 sessionId + dbPath 定位；候选的 sourcePath 是 db 路径占位）。
   */
  sourcePath: string
  /** 目标 project id（空串/不存在 → import_project_invalid） */
  projectId: string
  /** 导入源（缺省 'pi'——存量 renderer 调用不传 = 行为不变，向后兼容） */
  source?: ImportSourceKind
  /**
   * 源会话 id：zcode 等以 id 定位会话的源必填，传**原始**源 id（`sess_` 前缀形态，
   * 归一化由 source 内部完成——reply.sessionId 返回归一化 id，与侧边栏/扫描集同域）；
   * pi 源忽略（pi 以 sourcePath 文件定位）。
   */
  sessionId?: string
  /**
   * zcode 源库文件路径：缺省 = 宿主库路径动态推导（UI 不传）。wire 帧上该字段来自
   * 不可信面，runtime transport 层做封闭集合校验：仅接受 `zcodeImportDbAllowlist(dataDir)`
   * 集合（隔离库 / 宿主库），集合外拒绝 `import_db_path_forbidden`。测试 fixture 库注入
   * 走 source deps 进程内通道（构造注入 getHostDbPath），不经 wire。
   */
  dbPath?: string
}

/** 执行导入响应（`session.import` reply；失败走 error envelope，码见 ImportErrorCode） */
export interface ImportReply {
  /**
   * 导入落地 session id：pi = 源 header.id；zcode = 归一化 id（T1 剥 `sess_`
   * 前缀 + `_`→`-`，与侧边栏/扫描集同域，非请求传入的原始 sess_ 形态）。
   */
  sessionId: string
  /** 导入落地路径（= 太极 sessions 下按 header.cwd 编码的子目录 + 原文件名） */
  targetPath: string
  /** 可选警示（字面量语义见 ImportWarning 块注释）：文件已落地不回滚，renderer 降级 toast */
  warning?: ImportWarning
}

/**
 * 导入错误码字面量联合（错误规格表权威清单，与设计文档 D5 同章错误表一一对应）。
 *
 * 新增错误码必须在此登记，编译器强制 runtime/renderer 两端同步（防止改码后
 * renderer switch 静默失效，同 WorktreeErrorCode 守卫模式）。renderer 统一在
 * 对话框内联展示恢复指引，不弹系统对话框。
 *
 * 例外：`import_sidecar_failed` 不是 error envelope 的 code——rename 落地后
 * sidecar 写失败属于「成功但带 warning」，见 ImportReply.warning（r4-INFO）。
 */
export type ImportErrorCode =
  | 'import_source_missing'     // 源文件不存在/不可读
  | 'import_invalid_session'    // 首行无 session header，或字段清单不合法（type!=='session' / id / cwd 非非空字符串，D1 清单）
  | 'import_marker_filename'    // 源文件名含 .tmp-migrate- / .tmp-import- 标记（疑似迁移残留副本，导入会被自家扫描过滤器挡成 limbo）
  | 'import_dir_unreadable'     // rootDir readdir EACCES 等
  | 'import_already_imported'   // sessionId 已在太极扫描集（force 读集合命中）
  | 'import_target_conflict'    // existsSync(targetPath) 命中但 sessionId 不在 force 集合（同目标路径已被另一会话占用）
  | 'import_copy_failed'        // mkdir/copy/rename 抛错（磁盘满/目标权限）；tmp+rename 原子性保证失败无残留
  | 'import_project_invalid'    // projectId 不存在或为空串（空串会使 readback 假阳性——persistProjectBinding 空串语义是「删 sidecar 归默认」）
  | 'import_db_path_forbidden'  // wire 帧 dbPath 不在 zcodeImportDbAllowlist 封闭集合（transport 层校验，防白名单外路径被当会话库读取；缺省不传 = 放行动态推导）
  | 'import_sidecar_failed'     // 仅作 warning 通道字面量（ImportReply.warning），非 error envelope code
