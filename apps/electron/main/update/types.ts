/**
 * 自动升级后端类型与错误体系。
 *
 * 对应 slice auto-update-and-install w3：定义 UpdateScriptRef 联合类型
 * （platform-updater 返回值，告诉 orchestrator 如何触发替换）+ 升级错误类层级。
 *
 * [HISTORICAL] 设计要点：
 * - UpdateScriptRef 用可辨识联合（kind 区分），orchestrator switch 穷尽分支
 * - 错误类带 stage 字段（downloading/replacing/restarting），便于前端精确展示
 *   （下载与校验合并进 downloading：原先独立的校验态随 update:perform 删除而失去推送点，
 *    批次 5 u5d 已从 UpdateStage 联合类型与全部字面量中清除）
 * - UpdateUnsupportedError 单独成类（带 fallbackUrl），前端走「跳转 release 页」降级而非 retry
 *
 * 依赖方向：types → @taiji/shared（UpdateStage 类型）
 */
import type { UpdateStage } from '@taiji/shared'

/**
 * update-result.json 的合法 status 值（跨进程状态 SSOT）。
 *
 * - replacing：替换阶段进行中（被中断时由 maybeRollbackInterruptedUpdate 回滚）
 * - done：升级成功（终态）
 * - failed：升级失败（终态）
 * - rolled-back：已回滚（终态，self-healer 写入）
 * - no-op：中断但无需回滚（终态，self-healer 写入）
 *
 * cleanupCompletedUpdate 处理除 replacing 外的全部终态，清理残留产物。
 */
export type UpdateResultStatus = 'done' | 'failed' | 'replacing' | 'rolled-back' | 'no-op'

/**
 * 升级错误码枚举。
 *
 * 每个错误码对应一种具体的失败场景，前端可据此展示用户友好的错误提示和解决建议。
 */
export type UpdateErrorCode =
  | 'UPDATE_NETWORK_TIMEOUT'
  | 'UPDATE_NETWORK_FAILED'
  | 'UPDATE_SHA256_MISMATCH'
  | 'UPDATE_DISK_SPACE'
  | 'UPDATE_PERMISSION_DENIED'
  | 'UPDATE_PROXY_ERROR'
  | 'UPDATE_PROXY_UNREACHABLE'
  | 'UPDATE_INTEGRITY_FAILED'
  | 'UPDATE_UNSUPPORTED_PLATFORM'
  | 'UPDATE_STALE_RELEASE'
  | 'UPDATE_FILE_RENAME_FAILED'

/**
 * 错误码对应的用户友好提示信息。
 *
 * 包含错误消息、升级阶段和解决建议，前端可直接展示给用户。
 */
export interface UpdateErrorInfo {
  /** 错误码 */
  code: UpdateErrorCode
  /** 用户友好的错误消息 */
  message: string
  /** 错误发生的升级阶段 */
  stage: UpdateStage
  /** 解决建议 */
  suggestion: string
}

/**
 * 错误码到用户友好提示的映射表。
 */
export const UPDATE_ERROR_MESSAGES: Record<UpdateErrorCode, Omit<UpdateErrorInfo, 'code'>> = {
  UPDATE_NETWORK_TIMEOUT: {
    // 成因多形态（timeout-slow-flow-wallclock D1/G1 + design-code-sync F1）：总墙钟已删、
    // 本码不再由总时长触发，但仍有三个来源——① 传输停滞 30s（主形态，undici 双路径 +
    // curl --speed-time）② curl --connect-timeout 10s 连接未建立（exit 28 双成因之一，
    // 英文诊断串 'curl connection timeout (...)'）③ 泛化探测/abort（如 testProxy 10s
    // 探测超时，诊断串 'timeout (aborted)'）。本条是停滞形态的基准文案（设计 §5.2 样例 5
    // 措辞，30 秒与 IDLE_TIMEOUT_MS 对齐）；用户可见面由 update-handlers.resolveTimeoutUserCopy
    // 按诊断 message 成因分流——connect 形态给连接超时话术（停滞文案会误导排查方向），
    // 泛化形态给中性超时话术（无下载语境，「断点续传」指引不适用）。
    message: '下载停滞（连续 30 秒无数据）已中断',
    stage: 'downloading',
    suggestion: '点「重试」将从断点续传，无需重头下载；若反复停滞，请检查网络连接是否稳定或配置代理',
  },
  UPDATE_NETWORK_FAILED: {
    message: '网络连接失败',
    stage: 'downloading',
    // 多源（update-multi-source §7.3）：不提「GitHub」专名——双源时代下载可能恒走
    // AtomGit，「访问不了 GitHub」与其故障无关；保留网络/防火墙排查指引的可操作性
    suggestion: '请检查网络连接和防火墙设置',
  },
  UPDATE_SHA256_MISMATCH: {
    message: '安装包校验失败',
    stage: 'downloading',
    suggestion: '安装包可能已损坏，请重新下载',
  },
  UPDATE_DISK_SPACE: {
    message: '磁盘空间不足',
    stage: 'downloading',
    suggestion: '请清理磁盘空间后重试',
  },
  UPDATE_PERMISSION_DENIED: {
    message: '权限不足',
    stage: 'replacing',
    suggestion: '请以管理员权限运行应用',
  },
  UPDATE_PROXY_ERROR: {
    message: '代理配置错误',
    stage: 'downloading',
    suggestion: '请检查代理配置或尝试关闭代理',
  },
  UPDATE_PROXY_UNREACHABLE: {
    message: '无法连接代理 (EHOSTUNREACH)',
    stage: 'downloading',
    suggestion: 'macOS 未授予「本地网络」权限（代理在局域网时常见）。恢复指引：系统设置 → 隐私与安全性 → 本地网络 → 允许「太极」，重启应用后重试',
  },
  UPDATE_INTEGRITY_FAILED: {
    message: '安装包完整性校验失败',
    stage: 'downloading',
    suggestion: '安装包可能已损坏，请重新下载',
  },
  UPDATE_UNSUPPORTED_PLATFORM: {
    message: '当前平台不支持自动更新',
    stage: 'replacing',
    suggestion: '请手动下载最新版本',
  },
  UPDATE_STALE_RELEASE: {
    message: '更新信息已过期',
    stage: 'downloading',
    suggestion: '已检测到更新的版本，请重新检查更新后再试',
  },
  UPDATE_FILE_RENAME_FAILED: {
    message: '安装文件写入失败',
    stage: 'replacing',
    suggestion: '请确认应用未被占用或只读运行，然后重新下载安装',
  },
}

/**
 * 平台升级器返回的「替换动作描述」。
 *
 * orchestrator 根据 kind 决定如何触发替换：
 * - detached-script：三平台统一，prepareUpdate 内已 spawn detached（mac/linux 为 bash
 *   脚本，win 为 cmd wrapper），orchestrator 只需返回 triggerRestart
 * - unsupported：平台不支持自更新（如 deb），前端应跳 fallbackUrl
 *
 * [HISTORICAL] spawn-installer variant 随批次 2（u2b 删 orchestrator 延迟 spawn 分支）
 * 成为死类型，批次 5 u5d 删除——保留一个永不可达的分支就是下一次注释漂移的种子。
 */
export type UpdateScriptRef =
  | { kind: 'detached-script'; scriptPath: string }
  | { kind: 'unsupported'; reason: string; fallbackUrl: string }

/**
 * 升级流程错误基类。
 *
 * 携带 stage 字段标记错误发生的阶段（供前端展示「下载失败/校验失败/替换失败」等）。
 */
export class UpdateError extends Error {
  /** 错误发生的阶段 */
  readonly stage: UpdateStage
  /** 错误码（可选，供前端精确分支） */
  readonly errorCode: UpdateErrorCode | undefined
  /** 最内层原始 cause 的 message（落盘诊断用，D7） */
  readonly rawCause?: string

  constructor(message: string, stage: UpdateStage, errorCode?: UpdateErrorCode, rawCause?: string) {
    super(message)
    this.name = 'UpdateError'
    this.stage = stage
    this.errorCode = errorCode
    this.rawCause = rawCause
  }

  /**
   * 获取用户友好的错误信息。
   *
   * 根据 errorCode 从 UPDATE_ERROR_MESSAGES 映射表中获取错误描述和解决建议，
   * 但 stage 始终以构造时传入的 this.stage 为准——映射表里的 stage 只是「该错误码
   * 的典型阶段」，并不一定等于实际发生阶段（例如 rename 失败发生在 replacing 阶段，
   * 而它现在归类为 UPDATE_FILE_RENAME_FAILED，映射表里记的典型阶段也是 replacing）。
   * 如果 errorCode 未定义或不在映射表中，返回基础错误信息。
   */
  toUserFriendly(): UpdateErrorInfo {
    if (this.errorCode && this.errorCode in UPDATE_ERROR_MESSAGES) {
      const info = UPDATE_ERROR_MESSAGES[this.errorCode]
      // classifyNetError 构造的 message 常含 errno 码（如 'network connection failed
      // (ETIMEDOUT)'），映射表转中文后码会丢——补回 (CODE) 后缀，让用户可见文案保留
      // 具体网络故障类型（排障定位线索）。映射表条目自身已含该码时
      // （UPDATE_PROXY_UNREACHABLE 的「无法连接代理 (EHOSTUNREACH)」）不重复拼接。
      let message = info.message
      const netCode = /\(([A-Z][A-Z0-9]+)\)/.exec(this.message)?.[1]
      if (netCode && !info.message.includes(netCode)) {
        message = `${message} (${netCode})`
      }
      return {
        code: this.errorCode,
        message,
        stage: this.stage,
        suggestion: info.suggestion,
      }
    }
    return {
      code: this.errorCode ?? 'UPDATE_INTEGRITY_FAILED',
      message: this.message,
      stage: this.stage,
      suggestion: '请重试或联系技术支持',
    }
  }
}

/**
 * 完整性校验失败（sha256 不匹配 / size 不匹配）。
 *
 * 前端应提示「安装包已损坏」并允许重新下载，而非 retry 同一 asset。
 */
export class UpdateIntegrityError extends UpdateError {
  constructor(message: string, errorCode?: UpdateErrorCode) {
    super(message, 'downloading', errorCode ?? 'UPDATE_INTEGRITY_FAILED')
    this.name = 'UpdateIntegrityError'
  }
}

/**
 * 平台不支持自更新（如 deb 包 / dev 模式）。
 *
 * 携带 fallbackUrl，前端走「跳转 GitHub release 页手动下载」降级。
 */
export class UpdateUnsupportedError extends UpdateError {
  /** 备用跳转 URL（通常是 release 页面） */
  readonly fallbackUrl: string

  constructor(message: string, fallbackUrl: string) {
    super(message, 'replacing', 'UPDATE_UNSUPPORTED_PLATFORM')
    this.name = 'UpdateUnsupportedError'
    this.fallbackUrl = fallbackUrl
  }
}
