/**
 * session 存储树纯路径公式模块（零 env 读写、零进程假设）。
 *
 * 本模块是 session 存储树（`<dataDir>/ext-sessions/`）全部路径公式的唯一权威源：
 * 只做「入参 → 路径」的纯字符串推导，不读 process.env、不含任何进程形态判定
 * （getDataDir / C-proc-26 准入检查都在 paths.ts，与本模块物理隔离）。
 *
 * 为什么必须物理拆分（C-ext-31，2026-10-19 打包版 subagent 全灭事故的根因结构）：
 * pi 子树（extension bundle / 引擎子进程）会经 esbuild 内联消费本公式族——同一
 * 模块里只要有任何一个 env 缺省导出引用 getDataDir()，准入检查代码就会整体进入
 * bundle；而打包态 pi 进程恰构成「持有 prod 数据目录值 + TAIJI_AGENT_PACKAGED 被
 * C-proc-09 出站契约剥除」的组合，准入检查在该进程内必抛（session_start 装配
 * 失败 → subagent 全灭）。因此：
 *   - pi 子树（subagent-core 及其下游）只允许 import 本模块，dataDir 必传
 *     （base 解析通道 = subagent-core resolveSessionStoreBase）；
 *   - env 缺省形态（dataDir? 缺省 getDataDir()）只保留在 paths.ts，仅 runtime /
 *     main 进程合法消费（env 对完整：TAIJI_AGENT_PACKAGED + TAIJI_AGENT_DATA_DIR
 *     成对注入，C-proc-26）；
 *   - 机器门禁：scripts/bundle-extensions.mjs 扫 staged bundle，命中禁入标记即构建
 *     失败（标记清单 SSOT = scripts/lib/pi-env-admission-gate.mjs 的
 *     PI_ENV_ADMISSION_GUARD_MARKERS）。标记一律取「只可能出现在可执行代码里」的
 *     字面量形态，因此本文件及全部 pi 子树源码的注释严禁逐字抄写标记——bundler
 *     保留注释（legal-comments）时抄写即让合法 bundle 被误拦。
 */
import { join } from 'node:path'

/** session 存储树根段名（`<dataDir>/<本段>/`）。 */
export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

/**
 * pi 会话 id 同域校验正则（镜像 runtime pi-paths.ts 的 `PI_SESSION_ID_PATTERN`）：
 * 首尾字母数字，中间允许 `[A-Za-z0-9._-]`；真 sid 永不含 `:`，btw 虚拟 id
 * `btw:<sid>` 含冒号必拒。字面量一致性由 scripts/check-artifact-dir-formula-sync.mjs
 * 三方对拍守护。
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/**
 * pi 会话 id 同域校验（布尔判定，不 throw）——本模块是跨进程唯一权威实现，
 * runtime pi-paths.ts 同名函数为 pi 宿主侧权威源，一致性由对拍机检守护。
 */
export function isPiSessionId(sessionId: string): boolean {
  return PI_SESSION_ID_PATTERN.test(sessionId)
}

/**
 * sessionId 入参同域校验（session 存储树全部推导函数的路径穿越防线）。
 *
 * 目录名即 sessionId，非法 id（含 `/` `\` `..` 空格冒号等）会在 join 后逃逸出
 * `<root>/<sessionId>/` 分区写到任意位置——统一在此 throw（fail-fast），各推导函数
 * 不再各自内联正则。paths.ts 的非存储树推导函数（attachments 等）同款消费。
 *
 * @throws Error 当 sessionId 为空串、含路径分隔符/冒号或首尾非字母数字
 */
export function assertPiSessionId(sessionId: string): void {
  if (!isPiSessionId(sessionId)) {
    throw new Error(`invalid sessionId (path traversal blocked): ${sessionId}`)
  }
}

/**
 * 编码 cwd 为 pi session 目录名（pi 布局 SSOT；runtime pi-paths.ts 同名函数已收敛
 * 为本实现的 re-export 源头在 paths.ts 转发——本模块为公式本体）。
 *
 * 规则：'--' + cwd 去掉首斜杠 + 所有 / \\ : 替换为 - + '--'
 * 例：/Users/x/proj → --Users-x-proj--
 *
 * 归并是有损的（目录名里的字面 `-` 与分隔符归并产物无法区分），因此**只保证正向单射**：
 * 已知 cwd 可唯一得目录名，反向解码有歧义——需要「目录名 → cwd」的场景必须走正向对拍。
 */
export function encodeCwd(cwd: string): string {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

/**
 * session 存储树根目录（`<dataDir>/ext-sessions/`）。
 *
 * 全部 session 维度衍生数据的统一落点；与 pi 宿主树（`<dataDir>/agent/`）层级分离、
 * 语义可区分。布局与新域接入规约见 paths.ts 文件头「session 存储树」节注释。
 *
 * @param dataDir 数据根目录（**必传**——本模块零 env 假设；pi 子树经 subagent-core
 *   resolveSessionStoreBase 解析，runtime/main 侧可用 paths.ts 的 env 缺省形态）
 */
export function getSessionStoreDir(dataDir: string): string {
  return join(dataDir, SESSION_STORE_DIR_SEGMENT)
}

/**
 * 插件 KV 文件（`<root>/<sessionId>/plugin-data.json`，域 4）。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionPluginDataPath(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'plugin-data.json')
}

/**
 * 画布目录（`<root>/<sessionId>/canvases/`，域 8，画布 id 1:N 子分区）。
 *
 * 每张画布落 `<root>/<sessionId>/canvases/<canvasId>/`；画布归属创建它的 session，
 * 跨会话访问按归属拒绝。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionCanvasesDir(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'canvases')
}

/**
 * 后台任务登记目录（`<root>/<sessionId>/background-tasks/`，域 5）。
 *
 * base-tool-enhance 后台任务的 registry.json 与任务日志落点；extension 侧公式镜像
 * 与 shared 的一致性由对拍机检守护。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionBackgroundTasksDir(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'background-tasks')
}

/**
 * 会话导出文件（`<root>/<sessionId>/session-view.md`，域 6）。
 *
 * session-reader 导出 md 的落点。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionViewPath(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'session-view.md')
}

/**
 * btw 线会话目录（`<root>/<mainSid>/btw/`，域 7）。
 *
 * 主会话 mainSid 分区（分区键即入参 sessionId，无 encodeCwd 层）；线 jsonl 与
 * .meta.json sidecar 由 pi 写入。线树随主会话删除整树回收。
 *
 * @param sessionId 主会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionBtwDir(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'btw')
}

/**
 * 会话日志目录（`<root>/<sessionId>/logs/`，域 11）。
 *
 * 带 sessionId 的日志（pi stdout tee / crash / signal-forensics）落点；全局日志
 * （无 sessionId）仍在 `<dataDir>/logs/`，不入树。
 *
 * @param sessionId 会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionLogsDir(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'logs')
}

/**
 * subagent 记录目录（`<root>/<sessionId>/subagents/`，域 9）。
 *
 * 分区键 = rootSessionId（record 字段是既有关联权威）；子结构
 * sessions/（子代理会话 jsonl）· records/（ExecutionRecord）· model-switch/（模型
 * 切换交接信箱）· message/（定向消息信箱）见四个具名子函数。
 *
 * @param sessionId 根会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionSubagentsDir(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'subagents')
}

/** 子代理会话 jsonl 目录（`<root>/<sessionId>/subagents/sessions/`）。 */
export function getSessionSubagentSessionsDir(sessionId: string, dataDir: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'sessions')
}

/** ExecutionRecord 目录（`<root>/<sessionId>/subagents/records/`）。 */
export function getSessionSubagentRecordsDir(sessionId: string, dataDir: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'records')
}

/** 模型切换交接信箱目录（`<root>/<sessionId>/subagents/model-switch/`）。 */
export function getSessionSubagentModelSwitchDir(sessionId: string, dataDir: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'model-switch')
}

/** 定向消息请求结果信箱目录（`<root>/<sessionId>/subagents/message/`，写后读、读后即删）。 */
export function getSessionSubagentMessageDir(sessionId: string, dataDir: string): string {
  return join(getSessionSubagentsDir(sessionId, dataDir), 'message')
}

/**
 * workflow 运行状态目录（`<root>/<sessionId>/workflow/`，域 10）。
 *
 * run 状态记录落 `<root>/<sessionId>/workflow/runs/<runId>.record.jsonl`；分区键 =
 * rootSessionId（run 创建记录字段）。
 *
 * @param sessionId 根会话 id（同域校验，非法 throw）
 * @param dataDir   数据根目录（必传，见 getSessionStoreDir）
 */
export function getSessionWorkflowDir(sessionId: string, dataDir: string): string {
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'workflow')
}

/** workflow run 状态记录目录（`<root>/<sessionId>/workflow/runs/`）。 */
export function getSessionWorkflowRunsDir(sessionId: string, dataDir: string): string {
  return join(getSessionWorkflowDir(sessionId, dataDir), 'runs')
}
