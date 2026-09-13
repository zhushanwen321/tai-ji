/**
 * 导入 pi 会话 RPC 契约（runtime ↔ renderer 共享，接口先行）。
 *
 * 来源设计：docs/design/import-session.md（已删除，git 可追溯）§3.3 D5「RPC 契约（接口先行）」
 * 及同章「错误规格表」（错误码权威清单）。
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
 * - `query` 匹配字段集 = name ∪ 完整 sessionId ∪ uuid 前 6 位短 ID ∪
 *   sourcePath ∪ dirLabel，全部 case-insensitive includes；query.trim() 以
 *   '/' 或 '~' 开头时 renderer 切换「路径模式」（runtime 无需特殊分支——
 *   sourcePath 的 includes 匹配天然覆盖）。
 * - `items` 按 lastModified 降序排列，截 `limit`（默认 100）；`total` 是
 *   过滤前总数。扫描深度 = 顶层 + 一层子目录（与太极根同构），更深层静默跳过。
 * - `alreadyImported` 用默认 TTL 读打标（列表展示允许秒级 stale）；真正的
 *   导入幂等校验在 `session.import` 互斥区内 force 读双检（D4）。
 * - `warning` 走成功 reply 的可选字段而非 error envelope（r4-INFO）：
 *   文件已落地不回滚，renderer 降级 toast 引导手动归类。
 */
export type ImportWarning = 'sidecar_failed'

/** 候选列表请求（`session.importCandidates` payload） */
export interface ImportCandidatesRequest {
  /** 外部扫描根目录。缺省 = pi 全局 agent 目录下的 sessions（runtime 动态推导，禁止硬编码） */
  rootDir?: string
  /** 搜索词（语义见文件头「query 匹配字段集」约定） */
  query?: string
  /** items 截断数（默认 100） */
  limit?: number
}

/** 候选条目（reply.items 元素，按 lastModified 降序） */
export interface ImportCandidate {
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
  /** 源文件绝对路径（对话框路径模式直接传入候选的 sourcePath） */
  sourcePath: string
  /** 目标 project id（空串/不存在 → import_project_invalid） */
  projectId: string
}

/** 执行导入响应（`session.import` reply；失败走 error envelope，码见 ImportErrorCode） */
export interface ImportReply {
  sessionId: string
  /** 导入落地路径（= 太极 sessions 下按 header.cwd 编码的子目录 + 原文件名） */
  targetPath: string
  /** sidecar 写失败（readback 不符）：文件已落地不回滚，renderer 降级 toast 引导手动归类 */
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
  | 'import_sidecar_failed'     // 仅作 warning 通道字面量（ImportReply.warning），非 error envelope code
