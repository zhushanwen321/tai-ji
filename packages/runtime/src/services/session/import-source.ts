/**
 * SessionImportSource SPI —— 导入源接口（session-import-unified 设计 §3.3，多源 G2）。
 *
 * 分层原则：源特有知识（去哪找会话、怎么读、怎么转）全部下沉到 source 实现
 *（如 import-source-external-file.ts / import-source-zcode.ts）；源无关流程（互斥、去重双检、
 * 落盘原子性、sidecar、tombstone、缓存失效）收在编排层（import-service.ts）单点。
 * 第三个 coding-agent 源接入 = 组合根 source 表加一项 + 新实现模块，编排层与
 * RPC 契约零改动（ImportSourceKind 在 @taiji/shared 登记）。
 *
 * 本文件只承载类型与领域错误（无运行时逻辑）：payload/reply 类型 SSOT =
 * @taiji/shared 的 import-session 模块，SPI 定义 SSOT = 设计 §3.3 代码块。
 */

import type {
  ImportCandidatesReply,
  ImportCandidatesRequest,
  ImportErrorCode,
  ImportRequest,
  ImportSourceKind,
} from '@taiji/shared'

/**
 * 导入领域错误：source 实现与编排层共用（source 校验失败、去重拒绝、落盘失败等），
 * handler（u3）按 code 转 error envelope（同 GitError 模式）。错误码权威清单 =
 * ImportErrorCode（shared import-session.ts，与设计 §3.6 错误规格表一一对应，零新增）。
 */
export class ImportServiceError extends Error {
  readonly code: ImportErrorCode
  constructor(code: ImportErrorCode, message: string) {
    super(message)
    this.name = 'ImportServiceError'
    this.code = code
  }
}

/** source 实现的候选列表/导入定位依赖（结构化注入：组合根装配，测试可 stub）。 */
export interface ImportSourceDeps {
  /**
   * 默认外部根求值（C-comm-03 构造注入）：listCandidates 的 rootDir 参数缺省时每次调用
   * 惰性求值。组合根（index.ts 合法 import infra）经 getPiGlobalAgentDir 装配——services
   * 层禁止 value import pi-maintenance，source 只感知「默认根怎么取」不感知目录推导。
   */
  getRootDir: () => string
}

/**
 * 导入产物（prepareImport 返回值）：源校验通过后的落地产物描述。不落正式位、不做
 * 去重判定——那是编排层职责（D2：源只懂源，落盘/去重/注册收编排层单点）。
 */
export interface ImportArtifact {
  /** 目标 pi header——id 即幂等键（D3，zcode 源为归一化 id），cwd 决定落地子目录（encodeCwd） */
  header: { id: string; timestamp: string; cwd: string }
  /** 目标文件名（pi 命名惯例 <ISO>_<id>.jsonl；zcode 源经 T1 归一化维持「尾段 == header.id」不变量） */
  fileName: string
  /** 把产物写到 tmpPath（编排层负责 mkdir/校验/rename/失败清理——原子性单点） */
  write(tmpPath: string): Promise<void>
  /**
   * 保真度降级明细（artifact 级收集，设计 §3.5 D6/D7——如 zcode file part 丢弃、running
   * tool 整对丢弃）：非空 → 编排层聚合 reply.warning='conversion_degraded' 并日志留痕。
   * pi 源恒空数组（字节级复制无转换）。
   */
  degradations: string[]
}

/**
 * 导入源 SPI（G2 可扩展抽象）：一个源 = 一个实现模块 + 组合根注册表一项。
 * - listCandidates：候选列表（各源自定义匹配字段集，reply 结构统一 ImportCandidatesReply）
 * - prepareImport：校验源可达 + 产出落地产物（失败抛 ImportServiceError，code 见错误规格表）
 */
export interface SessionImportSource {
  /** 源种类（与 @taiji/shared 的 ImportSourceKind 字面量一一对应，注册表键） */
  readonly kind: ImportSourceKind
  /** 候选列表（对话框打开/搜索/切目录；alreadyImported 打标语义见 shared 契约注释） */
  listCandidates(request: ImportCandidatesRequest): Promise<ImportCandidatesReply>
  /** 校验源可达 + 产出落地产物（不落正式位、不做去重判定——编排层职责） */
  prepareImport(request: ImportRequest): Promise<ImportArtifact>
}
