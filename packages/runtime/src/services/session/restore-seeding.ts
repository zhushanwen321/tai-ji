/**
 * Restore 附着辅助（从 session-lifecycle.ts 提取，行数合规）：
 *
 * ① F2/F3 归一化管线：附着前检测 session_end / cwd 死路径并原地归一化
 *    （restore-fork-attach-fix W1；renameSession 非活跃分支共用同一入口，
 *    两处附着前检测/变换必须同源，否则行为漂移）。
 * ② U2/D1 生效值播种：switchSession 成功后 get_state 读回 pi 生效
 *    model+thinkingLevel，经 registerSession 的 metaOverride 播种
 *    （composer-model-session-isolation 设计 §3.3 D2，r3 校准）。
 *    get_state 解析与 create 路径共用 readEffectiveModelFromState（原两处逐字节重复）。
 *
 * [infra 直引豁免] 本模块 import infra/pi（session-file-utils）与 session-lifecycle.ts
 * 的既有四处同属 R3 ports 依赖倒挂豁免（见 session-lifecycle.ts 头注释登记），R3
 * 阶段随 ISessionStore port 扩展一并收口。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { ISessionStore, SessionJsonlLineTransform } from '../ports/session.js'
import type { ScannedSessionMeta } from '../../infra/pi/session-file-utils.js'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import { cleanupMigrateResidues, normalizeSessionFileInPlace } from '../../infra/pi/session-file-utils.js'
// 逆序分块读工具（u4b 交付物，D5 共享 IO 形态）：⑤档降级形态的「尾部扫 legacy session_end」复用。
import { forEachReversedLineChunk } from '../../utils/history-reverse-read.js'

/**
 * 流式归一化的注入依赖（C-comm-03 分层通道）：session-file-streaming 的 IO 骨架不在
 * services 白名单，经 ISessionStore port 的 normalizeSessionFileStreaming 消费——调用方
 * （session-lifecycle）传 this.sessionStore，测试传 infra 实现的绑定方法（构造注入，
 * 同 seedRestoreMetaOverride 的 client 注入惯例）。
 */
export type StreamingNormalizer = Pick<ISessionStore, 'normalizeSessionFileStreaming'>

/**
 * 匹配 `"type":"session_end"` 或 `'type':'session_end'`（容忍引号/空格差异）。
 * 用单/双引号字符类容忍 JSON.stringify（双引号）与手写（单引号）两种写法。
 *
 * stripSessionEndEntries（变换）与 containsSessionEndLine（F2/F3 分流判定）共用同一正则
 * ——判定与变换必须同源，否则会出现「判进 F3 却剔不干净」或反向的缝隙。
 */
const SESSION_END_RE = /["']type["']\s*:\s*["']session_end["']/

/**
 * 检测 JSONL 文本是否含 session_end 行（W1 restore-fork-attach-fix F2/F3 分流判定）。
 *
 * 与 stripSessionEndEntries 同款正则逐行检测。W1 设计文档明令禁止用
 * `stripSessionEndEntries(原文) === 原文` 字符串全等做本判定——strip 函数有末尾换行
 * 规范化副作用（原文末尾无 `\n` 时即使零剔除也产出不等文本），全等会把几乎所有文件
 * 误判进 F3 归一化路径。
 */
function containsSessionEndLine(jsonlContent: string): boolean {
  for (const line of jsonlContent.split('\n')) {
    if (line !== '' && SESSION_END_RE.test(line)) return true
  }
  return false
}

/**
 * 从 JSONL 文本中剔除 session_end 行。
 *
 * 背景（动机经 restore-fork-attach-fix §2.3 复核改判保留）：B7 sidecar 方案下 runtime
 * 不再往 JSONL 写 session_end（改写 .meta.json sidecar），但历史 session（迁移前写入的）
 * JSONL 仍可能含 `type:"session_end"` 行。pi 侧 `_buildIndex`（pi-mono
 * session-manager.ts）对所有非 session entry 无差别执行 `byId.set(entry.id);
 * leafId = entry.id`——legacy session_end 行无 id 无 parentId，使 leafId=undefined →
 * 后续 appendMessage 的 parentId 断链 → 全部旧历史不进 LLM 上下文（AI 失忆）。
 * 因此 restore 必须在附着前剔除该类行。
 *
 * 实现按行扫描：命中 SESSION_END_RE 的整行丢弃，其余行原样保留（含换行）。纯文本扫描
 * 不解析 JSON，避免格式异常的行被误吞。
 *
 * @param jsonlContent 原始 JSONL 文本
 * @returns 剔除 session_end 行后的文本（行数可能减少；末尾换行统一补一个）
 */
export function stripSessionEndEntries(jsonlContent: string): string {
  const lines = jsonlContent.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (line === '') continue // split 末尾产生的空串（原末尾换行）跳过，末尾统一补回
    if (SESSION_END_RE.test(line)) continue
    kept.push(line)
  }
  // 末尾统一补一个换行（W2/A-06 注释修正：pi 读取侧按行 trim 分行——session-manager.js
  // parseSessionEntries/parseSessionEntryLine 对内容先 trim 再 split("\n")，末尾 \n 非必须；
  // 补 \n 是保守对齐 pi 写出格式，非 pi 期望）
  return kept.length > 0 ? kept.join('\n') + '\n' : ''
}

/**
 * 对 JSONL 文本首行的 session header 应用 cwd fallback（W11 引入，语义随 W1 更新）。
 *
 * 纯字符串变换（不落盘）：restoreSession 的 F3 归一化管线内调用——session 原始 cwd 已被
 * 删除时，把首行 header 的 cwd 改为 fallback 值，使 pi switch_session 不因 cwd 不存在
 * 失败（pi 加载 header cwd 死路径的 session 直接 throw MissingSessionCwdError，pi-mono
 * session-cwd.ts；RPC switch_session 无 cwdOverride 字段，只能由 taiji 在附着前修）。
 * 变换产物经 normalizeSessionFileInPlace 原地 rename-over 落回原文件。
 *
 * 防御语义与原实现一致：首行缺失/非 session 类型/JSON parse 失败 → 原样返回（不抛）。
 *
 * @param jsonlContent stripSessionEndEntries 后的 JSONL 文本
 * @param fallbackCwd  降级 cwd（调用方传 homedir()）
 * @returns 首行 header.cwd 替换为 fallbackCwd 后的文本；无法解析时原样返回
 */
export function applyHeaderCwdFallback(jsonlContent: string, fallbackCwd: string): string {
  const lines = jsonlContent.split('\n')
  if (!lines[0]) return jsonlContent
  try {
    const header = JSON.parse(lines[0])
    if (typeof header !== 'object' || header === null || header.type !== 'session') {
      return jsonlContent
    }
    header.cwd = fallbackCwd
    lines[0] = JSON.stringify(header)
    return lines.join('\n')
  } catch {
    // 首行 JSON parse 失败：原样返回（交 pi switch_session 报错），不阻断 restore 主流程
    return jsonlContent
  }
}

/**
 * 附着前 F2/F3 分流归一化（restore-fork-attach-fix W1 形态；p1p4-closure W1 起
 * renameSession 非活跃分支共用——两处附着前检测/变换必须同源，否则行为漂移）。
 *
 * 判定：containsSessionEndLine(raw) || cwdFellBack。禁止用
 * stripSessionEndEntries(raw) === raw 字符串全等——strip 有末尾换行规范化副作用
 * （原文末尾无 \n 时零剔除也产出不等文本），见 containsSessionEndLine。
 *
 * 变换（F3 一次性归一化，legacy 文件；每文件最多一次，产物收敛到 F2，幂等）：
 * - strip session_end：legacy 行无 id/parentId，pi _buildIndex 对所有非 session
 *   entry 无差别 byId.set(entry.id); leafId = entry.id（pi-mono session-manager.ts），
 *   session_end 使 leafId=undefined → 新 entry parentId 断链 → 历史不进 LLM 上下文
 * - header cwd fallback：仅 cwd 死时应用（cwdFellBack）——pi 0.84.1 switchSession
 *   内 assertSessionCwdExists 对死 cwd 硬拒绝（pi-mono coding-agent/src/core/
 *   agent-session-runtime.ts switchSession，binary strings 实证见 findings §4.1；
 *   抛 MissingSessionCwdError，pi-mono session-cwd.ts；RPC switch_session 不透传
 *   cwdOverride，只能由 taiji 附着前修）
 *
 * 落盘经 normalizeSessionFileInPlace（同目录临时名 rename-over 原子替换，路径
 * 不变，登记表 §4 ⑨ 合法形态）。判定未命中（正常文件）时零变换：不写不拷贝，
 * 调用方直附着原文件。
 *
 * D5⑤ 预检分流（crash-resilience §3.3 D5⑤ + P-restore-skip，u4c）：附着是恢复路径
 *（D7 自动 respawn 把它变成崩溃后 5 秒自动触发的动作），超 READ_PRECHECK_MAX_BYTES
 * 的文件禁全量读（原实现 :140 无条件 readFileSync 是「恢复动作变内存尖峰」的恶性循环）。
 * 超限文件走 normalizeLargeSessionFileMinimal 最小规范化：判定与变换语义与全量路径
 * 等价（strip 全部 session_end 行 + 首行 cwd fallback），仅 IO 形态不同（尾扫判定 +
 * 分块流式变换，驻留 = 单块 + pending 行）。≤ 阈值路径行为逐字节不变。
 *
 * @param filePath    目标 session JSONL 绝对路径（原地归一化，路径不变）
 * @param cwdFellBack 调用方已判定的 session cwd 死路径标记（检测源 = scanner 从
 *                    header 读出的 ScannedSession.cwd）
 * @param streaming   流式归一化 IO 依赖（ISessionStore port 切片，C-comm-03 分层通道；
 *                    生产调用方传 this.sessionStore，测试传 infra 实现切片）
 */
export function normalizeInactiveSessionFileIfNeeded(filePath: string, cwdFellBack: boolean, streaming: StreamingNormalizer): void {
  // 附着前清扫该文件的 .tmp-migrate-* 崩溃/失败残留（差距复审 suggestion 6；F2/F3
  // 两路都过此处——F2 判定未命中会提前 return，清扫必须在其前）。此刻无归一化在途
  //（restore 已销毁同 id 会话），同 basename 残留必然 stale，best-effort 清除。
  // 预检分流两路也都过此处（清扫是 readdir+unlink，零内存压力，不随预检跳过）。
  cleanupMigrateResidues(filePath)
  let size: number
  try {
    size = statSync(filePath).size
  } catch (e) {
    // ENOENT 等：与原实现 readFileSync 的抛错同语义——restoreSession 的 try/catch
    //（safeDestroy + rethrow）承接；renameSession 调用点有 existsSync 前置守卫不经过此。
    throw e
  }
  if (size > READ_PRECHECK_MAX_BYTES) {
    // D5⑤：超阈值 → 最小规范化（不读全文）。warn 含文件大小与原因（失败要出声）。
    console.warn(
      `[restore-seeding] normalizeInactiveSessionFileIfNeeded: session file ${bytesToMbLabel(size)} exceeds ` +
      `${bytesToMbLabel(READ_PRECHECK_MAX_BYTES)} read-precheck cap, streaming minimal normalization ` +
      `(reverse tail scan for legacy session_end + first-line header cwd fix, no full read): ${filePath}`,
    )
    normalizeLargeSessionFileMinimal(filePath, cwdFellBack, streaming)
    return
  }
  const raw = readFileSync(filePath, 'utf-8')
  const needsNormalize = containsSessionEndLine(raw) || cwdFellBack
  if (!needsNormalize) return
  let cleaned = stripSessionEndEntries(raw)
  if (cwdFellBack) {
    cleaned = applyHeaderCwdFallback(cleaned, homedir())
  }
  normalizeSessionFileInPlace(filePath, cleaned)
}

// eslint-disable-next-line no-magic-numbers -- 字节量纲换算基数（1MB = 1024×1024），命名常量自解释
const BYTES_PER_MB = 1024 * 1024

/** 字节数 → MB 展示（保留 1 位小数；warn/文案量纲统一）。 */
function bytesToMbLabel(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}

/**
 * D5⑤ 超阈值文件的最小规范化（P-restore-skip 降级形态）。
 *
 * 为什么不走设计主形态「跳过 normalize 全流程」（P-restore-skip 双分支裁决，u4c 实施期）：
 * 失忆半边不安全——pi 0.84.4 实装 _buildIndex（node_modules dist/core/session-manager.js
 * :673-694）对所有非 session entry 无差别 `byId.set(entry.id); leafId = entry.id`，
 * appendMessage 以 `parentId: this.leafId` 挂链（:768+）：尾部 legacy session_end（无 id）
 * 未 strip 时 leafId=undefined → 新增 entry parentId=undefined → parentId 链断 →
 * 全部旧历史不进 LLM 上下文且无任何错误信号（静默失忆）。A11 构造声明的「尾部含
 * legacy session_end 变体」正是该场景，跳过即触发。cwd 半边（跳过 → switchSession
 * 抛 MissingSessionCwdError 硬拒绝）虽是显式失败、安全，但两个半边须同时安全才可跳过。
 * 故按设计降级路径改「逆序分块最小规范化」：
 * - 判定：尾部逆序扫 session_end（findTailSessionEnd，命中即止，读 ≤ 阈值）|| cwdFellBack
 *   （调用方已判定，零 IO）
 * - 变换：分块流式 strip 全部 session_end 行 + 首行 header cwd fallback（语义与全量
 *   路径 stripSessionEndEntries + applyHeaderCwdFallback 逐字节一致，见
 *   streamNormalizeSessionFile 注释），驻留 = 单块 + pending 行
 * 判定未命中（尾部窗口无 session_end 且 cwd 活）→ 零变换直附着（F2 幂等语义同款）。
 */
function normalizeLargeSessionFileMinimal(filePath: string, cwdFellBack: boolean, streaming: StreamingNormalizer): void {
  const hasTailSessionEnd = findTailSessionEnd(filePath)
  if (!hasTailSessionEnd && !cwdFellBack) return
  streamNormalizeSessionFile(filePath, cwdFellBack, streaming)
}

/**
 * 尾部逆序扫 legacy session_end（forEachReversedLineChunk，命中即止，总读取 ≤ 阈值）。
 *
 * 判定只看尾部窗口的依据：断链仅发生在「session_end 是文件最后一条非 session entry」
 * 时（pi _buildIndex 顺序赋值 leafId，中部 session_end 会被后续 entry 覆盖，无害——
 * 按行窗口外漏判不产生断链）；且 session_end 是 session 结束时最后写入的行（写入后
 * 文件冻结，见 session-file-utils extractSessionOutcome 注释），尾部窗口必中。
 * 行判定与 containsSessionEndLine 同源（SESSION_END_RE + 空行跳过），判定与变换不分叉。
 */
function findTailSessionEnd(filePath: string): boolean {
  let found = false
  forEachReversedLineChunk(filePath, { maxTotalBytes: READ_PRECHECK_MAX_BYTES }, (chunk) => {
    for (let i = chunk.lines.length - 1; i >= 0; i--) {
      const line = chunk.lines[i]
      if (line !== '' && SESSION_END_RE.test(line)) {
        found = true
        return false // 命中即止
      }
    }
  })
  return found
}

/**
 * D5⑤ 变换腿：组装 strip + cwd fallback 的行级纯变换（SessionJsonlLineTransform），
 * 经注入的 StreamingNormalizer（ISessionStore port 切片）完成分块流式落盘——IO 全在
 * infra 实现内（C-comm-03 分层通道），transformLine 是纯字符串变换不触 IO，不进 port。
 *
 * 行变换语义与全量路径（stripSessionEndEntries(全文) + cwdFellBack 时对产物首行
 * applyHeaderCwdFallback）逐字节一致：
 * - 空行剔除 + SESSION_END_RE 命中行剔除（判定与变换共用 SESSION_END_RE 不分叉；
 *   空行剔除对齐 stripSessionEndEntries 的 split('\n') 空串跳过，输出统一补 \n）
 * - cwd fallback 作用于**strip 后的首个保留行**（isFirstKeptLine 游标由流式骨架维护，
 *   首行是 session_end 被剔除时 fallback 落到次行，两形态一致）
 * - 驻留界由流式骨架保证（单块 + pending 行），chunkBytes 透传供测试注入小值
 *
 * @param sessionStore 流式归一化 IO 依赖（生产 = PiSessionStore 实例；测试 = infra
 *                     实现切片，构造注入）
 * @param chunkBytes   读块字节数（默认 1MB；测试注入小值以覆盖跨块/多字节边界分支）
 */
export function streamNormalizeSessionFile(filePath: string, cwdFellBack: boolean, sessionStore: StreamingNormalizer, chunkBytes?: number): void {
  const transformLine: SessionJsonlLineTransform = (line, isFirstKeptLine) => {
    if (line === '') return null
    if (SESSION_END_RE.test(line)) return null
    if (isFirstKeptLine && cwdFellBack) {
      return applyHeaderCwdFallback(line, homedir())
    }
    return line
  }
  sessionStore.normalizeSessionFileStreaming(filePath, transformLine, chunkBytes)
}

/**
 * 从 pi get_state 回执解析生效 model + thinkingLevel（create/restore 共用解析）。
 *
 * pi get_state 返回 `{ model: { id, provider }, thinkingLevel }` 或扁平字段
 * （modelId）。provider+id 齐全时拼 'provider/modelId'，仅 id 时用裸 id。
 * 字段缺失 → 对应键 undefined（调用方各自决定兜底链）。
 *
 * @param stateData client.getState() 回执（结构未建模，运行时守卫收窄）
 */
export function readEffectiveModelFromState(stateData: unknown): { modelId?: string; thinkingLevel?: string } {
  const stateObj = stateData as Record<string, unknown> | null | undefined
  let modelId: string | undefined
  let thinkingLevel: string | undefined
  if (stateObj?.model && typeof stateObj.model === 'object') {
    const m = stateObj.model as Record<string, unknown>
    const provider = typeof m.provider === 'string' ? m.provider : undefined
    const id = typeof m.id === 'string' ? m.id : undefined
    if (provider && id) modelId = `${provider}/${id}`
    else if (id) modelId = id
  }
  if (!modelId && typeof stateObj?.modelId === 'string') {
    modelId = stateObj.modelId
  }
  if (typeof stateObj?.thinkingLevel === 'string') {
    thinkingLevel = stateObj.thinkingLevel
  }
  return { modelId, thinkingLevel }
}

/**
 * restore 路径的生效值播种（U2/D1）：get_state 读回 + metaOverride 组装。
 *
 * r3 校准：metaOverride 恒提供（读回成功/失败两路径同构），每字段独立走
 * 「读回值 → 扫描 meta 值 → ''」兜底链。restore 从不播种全局默认：空串经
 * registerSession 的 ?? 短路阻断 modelOverride/fallbackModelId，composer 按 D3
 * 显示占位而非假值，快照收敛自愈。
 * hydrateBindingMeta restore='none' 不覆写播种值（D1 裁决），所以兜底链在此完成不经过 hydrate。
 *
 * [缓存治理 U8a W3] 播种不再写任何持久层：持久层唯一写方 = pi（model_change 等 entry
 * 落 JSONL）。兜底源 target.modelId/thinkingLevel 来自扫描 meta，U7 起经反向读 JSONL
 * 已是持久层真值，restore 只做内存 metaOverride 播种。
 *
 * @param client    已附着目标文件的 pi client（switchSession 成功后调用）
 * @param sessionId restore 的 session id（仅用于失败日志，与调用方日志同前缀）
 * @param target    findScannedSession 的扫描 meta（兜底值来源，反向读 JSONL 真值）
 * @returns 播种值（恒提供；传给 registerSession 的 metaOverride）
 */
export async function seedRestoreMetaOverride(
  client: IPiEngine,
  sessionId: string,
  target: Pick<ScannedSessionMeta, 'modelId' | 'thinkingLevel'>,
): Promise<{ modelId: string; thinkingLevel: string }> {
  try {
    const stateData = await client.getState()
    const readback = readEffectiveModelFromState(stateData)
    return {
      modelId: readback.modelId ?? target.modelId ?? '',
      thinkingLevel: readback.thinkingLevel ?? target.thinkingLevel ?? '',
    }
  } catch (e) {
    // E2: get_state 读回失败 → 每字段回落扫描 meta 值（target 来自 findScannedSession，
    // 反向读 JSONL 真值），仍缺则 '' 占位。与读回成功路径同构：双无值也播种 ''/''，
    // 不保持 undefined 走 registerSession 全局默认（D2 被否谱系：全局默认播种让 restore
    // 窗口显示他 session 的假值，违 G4「不知道显示占位」）。
    console.warn(`[session-lifecycle] restoreSession(${sessionId}): get_state readback failed, falling back to scanned meta values`, e)
    return {
      modelId: target.modelId ?? '',
      thinkingLevel: target.thinkingLevel ?? '',
    }
  }
}
