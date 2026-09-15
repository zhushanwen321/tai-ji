/**
 * 升级错误/诊断日志落盘（update-network-resilience D8 + 多源改造诊断面）。
 *
 * JSONL 格式，512KB 轮转 x2。失败登记七个 source 覆盖：
 * test-proxy / download / install / perform / preload /
 * engine-fallback / manual-claim（D8：前者为单引擎失败被另一引擎兜住的
 * 降级点落盘，后者为手动认领校验失败落盘）。
 *
 * 成功路径登记三个 source（多源改造新增，S1-S3 验收的观测面）：
 * source-selection（每轮检查的源顺序 / 胜出源 / auto 探测结果 / 各源 latest
 * tag——tags 是 F5 两源同步缺失形态的唯一客户端观测面；仅在排序/胜出源/
 * 探测结果/tags 变化时写，首条必写）/ source-failover（跨源降级发生点）/
 * download-success（multiPart + engine，S1 多段生效断言的观测面）。三类成功
 * 登记与失败登记共用同一 JSONL 与轮转通道，写入容错语义一致（失败不抛）。
 *
 * 形态豁免说明（data-source-registry C-data-11 口径）：本文件是 append-only 诊断
 * 日志（appendFileSync 单向追加 + rename 轮转，无读-改-写），非 C-data-11 针对的
 * 「每域一 JSON 配置文件」RMW 丢失面，不属于 writeFileSync 直写禁令范围。
 *
 * 落盘失败静默跳过（日志失败不能阻断升级主流程）。
 *
 * 依赖方向：error-log → constants（getUpdateErrorLog 路径）+ node:fs
 *          + @taiji/shared（UpdateSource 类型）。
 */
import { existsSync, mkdirSync, statSync, renameSync, appendFileSync } from 'node:fs'
import { getUpdateDir, getUpdateErrorLog } from './constants.js'
import type { UpdateSource } from '@taiji/shared'

/** auto 探测的单源结果（source-selection.probe.results 元素）。 */
export interface SourceProbeRecord {
  /** 被探测的源 */
  source: UpdateSource
  /** 探测可达性（D4：任何完成 HTTP 响应即可达） */
  reachable: boolean
  /** 排序依据（探测手段/响应形态的自由文本，如 'undici-resolve' / 'curl-200'；不可达时为失败原因） */
  basis: string
}

/** auto 探测结果（source-selection.probe）。 */
export interface SourceProbeOutcome {
  /** 探测是否实际执行；false = 非 auto 偏好或代理短路 */
  executed: boolean
  /** executed=false 时的跳过原因（自由文本，建议值 'explicit-preference' / 'proxy-short-circuit'） */
  reason?: string
  /** executed=true 时的各源探测结果（数组顺序即排序依据线索） */
  results?: SourceProbeRecord[]
}

/** logSourceSelection 入参（供 u-checker 检查段接线）。 */
export interface SourceSelectionLogInput {
  /** 本轮检查的源顺序（优先级从高到低） */
  order: UpdateSource[]
  /** 胜出源；全部源无新版/不可用时为 null */
  winner: UpdateSource | null
  /** auto 探测结果；非 auto 或代理短路时 executed=false + reason */
  probe: SourceProbeOutcome
  /** 各源 latest tag（检查响应顺带携带，零新增请求）；该源无响应则缺 key */
  tags: Partial<Record<UpdateSource, string>>
}

/** logSourceFailover 入参（供 u-checker 检查段 / u-download-failover 下载段接线）。 */
export interface SourceFailoverLogInput {
  /** 降级发生段：check = 检查段逐源尝试，download = 下载段跨源续传 */
  segment: 'check' | 'download'
  /** 失败源 */
  from: UpdateSource
  /** 降级目标源 */
  to: UpdateSource
  /** 触发错误码（可选） */
  errorCode?: string
  /** manifest 获取来源（若适用，如检查段从胜出源 assets 取直链） */
  manifestFrom?: UpdateSource
}

/** logDownloadSuccess 入参（供 u-download-failover 接线）。 */
export interface DownloadSuccessLogInput {
  /** 多段下载是否生效（probe 判定结果）——S1 多段生效断言的观测面 */
  multiPart: boolean
  /** 实际使用的下载引擎（S1 注记：curl 引擎按 update-network-resilience D7 语义放弃多段，multiPart=false 非回归） */
  engine: 'undici' | 'curl'
  /** 下载成功所在源（可选；release.source undefined 的旧落盘文件场景缺省） */
  releaseSource?: UpdateSource
}

/** 单条错误日志条目 */
export interface UpdateErrorEntry {
  /** ISO 8601 时间戳 */
  at: string
  /**
   * 错误来源。失败登记：test-proxy / download / install / perform / preload /
   * engine-fallback（单引擎失败被另一引擎兜住时在降级发生点落盘，D8）/
   * manual-claim（手动认领 size/sha256 校验失败落盘，D2）。
   * 成功路径登记（多源改造）：source-selection / source-failover / download-success。
   */
  source: string
  /**
   * 升级阶段。既有值域 = shared UpdateStage（downloading/replacing/restarting）；
   * 多源成功登记新增 'checking'（检查段诊断值，仅诊断日志使用，不进 shared 值域）。
   */
  stage: string
  /** 错误码（可选） */
  errorCode?: string
  /** 最内层原始 cause（可选，落盘诊断用） */
  rawCause?: string
  /** 代理 URL（可选，脱敏后） */
  proxyUrl?: string
  /**
   * 失败引擎（可选，D8 诊断字段，不入 shared 枚举）：降级落盘时为失败引擎；
   * 双引擎均失败时落 undici——对用户的错误分类以 undici 侧 errno 为准
   * （curl exit code 无 errno 级区分，见 D8）。
   */
  engine?: 'undici' | 'curl'
  /**
   * 多源归因（可选，多源改造诊断字段，对齐 engine 先例不入 shared 枚举）：
   * 事件发生所在源。失败登记 = 失败发生源；download-success = 成功下载源；
   * 缺省 = 源无关事件（install/replacing 等）或单源语境。
   */
  releaseSource?: UpdateSource
  // ── 以下为成功路径登记载荷字段（按 source 分组使用；平铺顶层保持 JSONL 可 grep，
  //    与 S1-S3 验收断言形态「source-selection: order=[...] winner=...」对齐）──
  /** [source-selection] 本轮检查的源顺序 */
  order?: UpdateSource[]
  /** [source-selection] 胜出源；null = 无胜出 */
  winner?: UpdateSource | null
  /** [source-selection] auto 探测结果 */
  probe?: SourceProbeOutcome
  /** [source-selection] 各源 latest tag（F5 同步缺失形态的唯一客户端观测面） */
  tags?: Partial<Record<UpdateSource, string>>
  /** [source-failover] 降级前源 */
  from?: UpdateSource
  /** [source-failover] 降级目标源 */
  to?: UpdateSource
  /** [source-failover] manifest 获取来源（若适用） */
  manifestFrom?: UpdateSource
  /** [download-success] 多段下载是否生效（probe 判定结果） */
  multiPart?: boolean
}

/** 1KB 的字节数。 */
const BYTES_PER_KB = 1024

/** 轮转阈值（KB）。 */
const MAX_LOG_SIZE_KB = 512

/** 轮转阈值：512KB */
const MAX_LOG_SIZE = MAX_LOG_SIZE_KB * BYTES_PER_KB

/**
 * source-selection 降频快照：上次写入条目的序列化形态。
 * undefined = 尚未写过（首条必写）。
 */
let lastSelectionSnapshot: string | undefined

/**
 * 追加一条错误日志到 update-error.log。
 *
 * 轮转策略：超 MAX_LOG_SIZE 时重命名为 .log.1（覆盖旧 .1），最多两份。
 * 落盘失败静默跳过（console.error 兜底，不阻断主流程）。
 *
 * 返回写入是否成功（成功路径登记的降频快照据此决定是否推进：
 * 写失败不推进，下轮同状态仍会补写，不因一次落盘失败永久丢观测）。
 */
export function appendUpdateError(entry: UpdateErrorEntry): boolean {
  try {
    mkdirSync(getUpdateDir(), { recursive: true })

    // 轮转检查（每次调用现取路径：env 可能在模块加载后才注入，见 constants.ts）
    const errorLogPath = getUpdateErrorLog()
    if (existsSync(errorLogPath)) {
      try {
        const stat = statSync(errorLogPath)
        if (stat.size >= MAX_LOG_SIZE) {
          const rotatedPath = `${errorLogPath}.1`
          // 覆盖旧 .1（如果存在）
          renameSync(errorLogPath, rotatedPath)
        }
      } catch (err) {
        // best-effort 降级：轮转失败（rename 被占用/权限）不阻断写入——error-log 本身是
        // 诊断日志通道，宁可继续追加原文件（超出轮转阈值），不可因轮转失败丢错误记录
        console.warn('[update-error-log] rotate failed, keep appending to original file:', err)
      }
    }

    const line = JSON.stringify(entry) + '\n'
    appendFileSync(errorLogPath, line, 'utf-8')
    return true
  } catch (err) {
    // 落盘失败静默跳过，仅 console.error 兜底
    console.error('[update-error-log] failed to write:', err)
    return false
  }
}

/**
 * 登记检查段的源选择结果（source-selection，成功路径登记）。
 *
 * 降频（设计写放量级入账的降频优化）：仅当排序 / 胜出源 / 探测结果 /
 * 各源 latest tag 任一变化时写入，常态恒定不重复写；首条必写。
 * tags 纳入变化检测维度：若不纳入，稳态下 tag 冻结在首条，F5（两源同步
 * 缺失）观测面失效——tag 变化频率受版本发布节流，写放量仍远低于每轮必写上界。
 *
 * 快照以 JSON.stringify(input) 直接比较：依赖调用方以固定构造序生成同构输入
 * （同结构对象字面量），字符串比较仅用于「是否变化」判定，非语义规范化。
 */
export function logSourceSelection(input: SourceSelectionLogInput): void {
  const snapshot = JSON.stringify(input)
  if (snapshot === lastSelectionSnapshot) return

  const ok = appendUpdateError({
    at: new Date().toISOString(),
    source: 'source-selection',
    stage: 'checking',
    order: input.order,
    winner: input.winner,
    probe: input.probe,
    tags: input.tags,
  })
  // 写入失败不推进快照（appendUpdateError 静默容错），下轮同状态仍会补写
  if (ok) lastSelectionSnapshot = snapshot
}

/**
 * 登记跨源降级发生点（source-failover，成功路径登记）。
 *
 * 检查段（segment='check'）由 u-checker 在逐源尝试失败转向次源时调用；
 * 下载段（segment='download'）由 u-download-failover 在下载失败触发跨源
 * 续传时调用。S6 断言「无第二次 source-failover」依赖本登记的存在性判定。
 */
export function logSourceFailover(input: SourceFailoverLogInput): void {
  appendUpdateError({
    at: new Date().toISOString(),
    source: 'source-failover',
    stage: input.segment === 'download' ? 'downloading' : 'checking',
    from: input.from,
    to: input.to,
    errorCode: input.errorCode,
    manifestFrom: input.manifestFrom,
  })
}

/**
 * 登记下载成功（download-success，成功路径登记）。
 *
 * 每次下载成功落一条（量级可忽略）。multiPart = probe 判定结果，是 S1
 * 多段生效断言的观测面（防 probe 改造回归静默退化单段——curl 引擎按
 * update-network-resilience D7 语义放弃多段，multiPart=false 非回归，断言失败先核对 engine 字段）。
 */
export function logDownloadSuccess(input: DownloadSuccessLogInput): void {
  appendUpdateError({
    at: new Date().toISOString(),
    source: 'download-success',
    stage: 'downloading',
    multiPart: input.multiPart,
    engine: input.engine,
    releaseSource: input.releaseSource,
  })
}
