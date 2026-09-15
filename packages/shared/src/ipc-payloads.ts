/**
 * Electron IPC payload 类型 SSOT（renderer → main 方向，与 ipc-channels.ts 通道名配对）。
 *
 * 现状归属：既有 IPC payload 类型按领域散落（update.ts 的 UpdateErrorPayload、panel.ts
 * 的 WindowState 等）；renderer-log 是跨领域诊断通道，无既有领域文件可归，独立成文件
 * 防止并行单元共改漂移（crash-resilience u-foundation 同型考量）。
 *
 * 信任边界：本类型只约束 renderer 的组装形态；main 侧 handler（renderer-log-handler.ts）
 * 对进站 payload 做运行时再校验（renderer 在崩溃/中毒状态下可能发出畸形 payload），
 * 类型不作为信任依据。
 */

/**
 * performance.memory 快照（Chromium 专属非标准 API）[crash-resilience §3.3 D6-③]。
 *
 * 字段与 Chrome 官方非标准 memory 形态一致；renderer 侧读取前做运行时 guard，
 * API 不可用时整字段省略（探针 P-mem-api 留 u6/阶段 5 验证，不可用不阻塞上报）。
 */
export interface RendererMemorySnapshot {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

/**
 * 三件套捕获面标识 [crash-resilience §3.3 D2-①]：
 * - 'vue-error-handler'：app.config.errorHandler（组件 render/setup/生命周期错误）
 * - 'window-onerror'：window 层 error 事件（Vue 体系外的全局 JS 错误）
 * - 'unhandledrejection'：未接住的 Promise rejection
 *
 * 结构化标记（非三件套捕获面）[crash-forensics §3.3 D8 / u10a]：
 * - 'inbound-frame-dropped'：ws-client 入站帧大小守卫命中（超界帧丢弃）经本通道上报——
 *   main 侧 handler 识别该标记后额外写崩溃台账行（main.jsonl
 *   `layer=renderer, event=inbound-frame-dropped`，D1 写入点矩阵），复用既有通道不新建。
 */
export type RendererErrorSource =
  | 'vue-error-handler'
  | 'window-onerror'
  | 'unhandledrejection'
  | 'inbound-frame-dropped'

/**
 * renderer → main 错误上报 payload（RENDERER_LOG = 'renderer-log' invoke 通道）
 * [crash-resilience §3.3 D2-② / D6-③]。
 *
 * windowId 有意不在 payload 内：main 侧从 `event.sender.id`（webContents id）权威
 * 读取并用作限流键与落盘字段，不信任 renderer 自报（u2 验收条款）。
 */
export interface RendererLogPayload {
  /** 捕获面（三件套哪一环捕获） */
  source: RendererErrorSource
  /** 错误消息（Error.message / 事件 message / rejection reason 字符串化） */
  message: string
  /** 错误栈（Error.stack；抛出值非 Error 时省略） */
  stack?: string
  /** renderer 捕获时刻毫秒 epoch（跨端排序参考；落盘行的权威时间戳取 main 侧） */
  timestamp: number
  /** 捕获时活跃 session（panel focusedSessionId；pinia 未激活或无活跃 session 时省略） */
  sessionId?: string
  /** performance.memory 快照（Chromium 专属；API 不可用时省略——探针 P-mem-api） */
  memory?: RendererMemorySnapshot
}

// ── toolResult 图片落盘（IMAGE_CACHE_WRITE = 'image-cache:write' invoke 通道）
//    [crash-resilience §3.3 D6-⑨，u7-memory-governance] ──────────────────────────

/** 待落盘的 toolResult 图片（pi ImageContent 形态：base64 data + mimeType）。 */
export interface ImageCacheWriteImage {
  /** base64 编码图片数据（不带 data: 前缀，对齐 pi ImageContent.data） */
  data: string
  /** MIME 类型（如 image/png；扩展名映射与降级判定用） */
  mimeType: string
}

/**
 * renderer → main 图片落盘请求（IMAGE_CACHE_WRITE invoke 通道）。
 *
 * **images 数组序 = 落盘序（新→旧）**：hydrate 批量场景由 core 编排层按消息序反转后
 * 组装（设计 D6-⑨ v8 显式声明「新→旧有序落盘、超帽即停、更旧的图占位」），live 单图
 * 场景数组长度为 1。main 按数组序逐张处理，命中单 session size 帽即停（后续更旧图
 * 返回 quota-full），顺序语义由两侧契约共同保证。
 */
export interface ImageCacheWritePayload {
  sessionId: string
  images: ImageCacheWriteImage[]
}

/** 单图落盘结果（与请求 images 数组按序一一对应）。 */
export interface ImageCacheWriteImageResult {
  /**
   * - written：本次落盘成功
   * - cached：内容 hash 命中已有文件，幂等跳过写（返回已有 path）
   * - quota-full：该 session 目录已达 size 帽，未落盘（渲染占位）
   * - invalid：payload 字段畸形（data/mimeType 非字符串或全空），不落盘
   */
  status: 'written' | 'cached' | 'quota-full' | 'invalid'
  /** 落盘/命中的文件绝对路径（quota-full / invalid 时省略） */
  path?: string
  /** 文件字节数（quota-full / invalid 时省略） */
  bytes?: number
}

/** 图片落盘批量结果。 */
export interface ImageCacheWriteResult {
  /** 与请求 images 按序一一对应 */
  results: ImageCacheWriteImageResult[]
  /** 本批存在因 size 帽未落盘的图（true ⇒ 后续更旧图也必然未写——超帽即停语义） */
  quotaFull: boolean
}

// ── logs 保留期清理手动触发（DEBUG_RUN_LOG_RETENTION = 'debug:run-log-retention'
//    invoke 通道）[crash-resilience A9② 验收调试口] ──────────────────────────

/**
 * 一次 logs/ 清理扫描的统计（DEBUG_RUN_LOG_RETENTION invoke 返回值）。
 *
 * 无请求 payload（空参 invoke）；字段语义对齐 main 侧 log-retention.ts 的
 * LogRetentionResult（该类型住 main 领地不进 shared，此处在通道契约层镜像声明，
 * preload 签名与 main handler 返回共用，防两端漂移）。
 */
export interface DebugRunLogRetentionResult {
  /** 匹配清理前缀且为文件（非目录）的条目数。 */
  scanned: number
  /** 实际删除（mtime 超龄）的文件数。 */
  removed: number
}

// ── 诊断包导出（DIAGNOSTICS_EXPORT_BUNDLE = 'diagnostics:export-bundle' invoke 通道）
//    [crash-forensics-and-watchdog §3.3 D6，u3a] ──────────────────────────────

/**
 * 导出确认对话框知情提示文案 SSOT [D6 隐私判定补偿]。
 *
 * D6 隐私裁决：诊断包**不脱敏**（本机路径与会话标识正是归因线索，脱敏摧毁诊断价值），
 * 补偿 = 导出动作前的知情提示。常量住 shared：u3a main 侧把它写进导出结果 summary
 * （payload 携带）与 summary.md；u3b renderer 确认对话框展示同一常量——两端共用防文案
 * 分叉。修改文案时必须保留「本机路径」「会话标识」两个知情要素（D6 原文锚点）。
 */
export const DIAGNOSTIC_EXPORT_PRIVACY_NOTICE =
  '诊断包将收集应用日志与崩溃台账，其中可能包含本机路径与会话标识信息，仅用于问题排查，请勿公开分享。'

/** 诊断包导出请求 payload（renderer → main；字段全部可选，空参 invoke 合法）。 */
export interface DiagnosticExportBundlePayload {
  /** 保存对话框初始目录（如上次导出位置）；省略由 OS 记忆决定 */
  defaultPath?: string
}

/** 导出包摘要元数据（渲染侧展示 + 归因首屏；知情文案随包携带）。 */
export interface DiagnosticExportSummary {
  /** 导出时刻（ISO 8601 UTC，main 侧权威） */
  exportedAt: string
  appVersion: string
  /** pi 版本（从台账事件提取最近值；无记录为 'unknown'） */
  piVersion: string
  platform: string
  /** 本次评估越线的触发条件 id（D2 状态表；空数组 = 常态无越线） */
  trippedConditionIds: number[]
  /** 状态表总条数（20，附录 A SSOT） */
  evaluatedConditionCount: number
  /** zip 内条目数（含 summary.md） */
  entryCount: number
  /** 降级跳过的清单项（「archivePath（原因）」人读串——缺失显式非静默） */
  missingEntries: string[]
  /** 知情提示文案（DIAGNOSTIC_EXPORT_PRIVACY_NOTICE，随包携带供消费方直接展示） */
  privacyNotice: string
}

/** 打包失败明细（具体 errno，不吞成布尔——磁盘满/权限可判定可重试）。 */
export interface DiagnosticExportError {
  /** fs errno（如 ENOSPC / EACCES / ENOENT）；非 fs 错误归一为 EUNKNOWN */
  code: string
  message: string
}

/**
 * 诊断包导出结果（DIAGNOSTICS_EXPORT_BUNDLE invoke 返回值）。
 *
 * **零 rejection 面**（对齐 DEBUG_RUN_LOG_RETENTION 先例）：用户取消保存对话框返回
 * canceled；打包/写盘失败返回 error（含具体 errno）——handler 全路径不向 renderer 抛
 * invoke rejection，调用方按 status 三态分支。
 */
export type DiagnosticExportBundleResult =
  | {
    status: 'exported'
    /** 产物 zip 绝对路径（用户自选保存位置） */
    path: string
    /** zip 字节数 */
    bytes: number
    entryCount: number
    /** zip 内条目名清单（与清单收集顺序一致） */
    entryNames: string[]
    summary: DiagnosticExportSummary
  }
  | { status: 'canceled' }
  | { status: 'error'; error: DiagnosticExportError }
