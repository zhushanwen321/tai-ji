/**
 * SubagentModelSwitchGateway 生产适配器（subagent-model-switch §7.1.1 通道，U6）。
 *
 * runtime → pi extension 的宿主触达：出站点 `client.prompt("/subagent-model <单行JSON>")`
 * 短路 extension 命令 handler（不经 LLM，pi 主路径对 / 前缀先行执行扩展命令），结构化
 * 应答经请求作用域结果文件回收（`<subagent 数据根>/model-switch/<requestId>.json`，
 * extension 写入 / 本侧写后读一次并删除——无轮询无监视）。
 *
 * 职责边界：载荷组装 + 出站点 prompt（显式墙钟超时）+ 结果文件读删 + wire 应答映射；
 * 覆盖状态查询不经过本网关（model-override-query 是唯一查询入口，详情载荷组装路径
 * 直接装配，M1-3 收敛——本端口只保留 setModel + resolveSessionId）。
 *
 * 通道级失败分型（§7.5「runtime→extension 通道」行）：生效状态未知如实报，恢复动作
 * = 重试切换，当前生效状态以面板与记录链/journal 为准——不虚构「未生效」。
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  SubagentSetModelAggregateReply,
  SubagentSetModelReply,
} from '@taiji/shared'
import {
  getSubagentModelSwitchResultsDir,
  getSubagentRecordsDir,
  recordEventsPath,
  RUN_EVENTS_SUFFIX,
  STATE_DIR_NAME,
} from '@zhushanwen/subagent-core'

import type { SubagentModelSwitchGateway } from '../interfaces.js'
import type { ScannedSessionMeta } from '../services/ports/session.js'
import { getPiAgentDir } from './pi/pi-paths.js'
import { toErrorMessage } from '../utils/errors.js'

/**
 * 出站点显式墙钟超时（§7.1.1 要素 4：60s < 前端 backstop RPC_BACKSTOP_TIMEOUT_MS = 65s
 * （packages/core/src/transport/api/pending.ts:37）——保证前端 backstop 窗口内必有 WS
 * 应答。量级依据：逐成员转发为控制面单请求（秒级收敛窗），聚合并发扇出常态远低于 60s；
 * 极端大 run 触发超时按通道行语义如实应答。超时到点先做一次结果文件 best-effort 检查
 * ——命中迟到真值按真实结果应答（略超时不吞真值）。
 */
export const MODEL_SWITCH_PROMPT_TIMEOUT_MS = 60_000

/** 结果文件读取的单次预算（uuid 命名 + 请求作用域，文件体 = 单条 JSON 应答，KB 级）。 */
// eslint-disable-next-line no-magic-numbers -- 预算常数 256KB（256 × 1024，语义见上注）
const RESULT_FILE_MAX_BYTES = 256 * 1024

/** 通道级失败统一 code（§7.5 通道行：出站点超时 / 结果文件缺失 / 发送失败同分型）。 */
const CHANNEL_ERROR_CODE = 'subagent_model_switch_channel_failed'

/**
 * 目标 id 白名单：`[\w-]{1,128}`（与 core record id 白名单同式——runId/recordId 来自
 * wire payload，进文件系统路径前防穿越；生产源（sa-uuid / wf-id）字符集 ⊆ 白名单）。
 */
const TARGET_ID_PATTERN = /^[\w-]{1,128}$/

/** 出站点 prompt 能力窄口（IPiEngine.prompt 的单参子集，测试可注入桩）。 */
export interface SubagentModelPromptClient { // oe-exempt:20261006:framework:出站点能力窄口（prompt 单参子集，DI 端口先立单实现常态）
  prompt(content: string): Promise<unknown>
}

export interface SubagentModelGatewayDeps { // oe-exempt:20261006:framework:网关适配器依赖注入面（组合根构造，单实现常态）
  /** session pi 客户端提供者（workflowAction 同款 deps.pm.getClient 形态的窄口）。 */
  getClient(sessionId: string): SubagentModelPromptClient | undefined
  /** session 扫描（resolveSessionId 定位 + 结果目录数据根 cwd 解析的唯一来源）。 */
  scanSessions(opts?: { force?: boolean }): ScannedSessionMeta[]
  /** pi agent 目录锚（记录域 subagents/ 布局根；缺省 getPiAgentDir()，测试注入 tmp）。 */
  agentDir?: string
}

/** 通道/校验分型错误（code 经 message handler 透传进 error envelope）。 */
class SubagentModelSwitchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SubagentModelSwitchError'
  }
}

/** 出站点竞速结局（prompt 正常回 / prompt 失败 / 超时三态）。 */
type PromptOutcome =
  | { kind: 'prompt' }
  | { kind: 'prompt-error'; error: unknown }
  | { kind: 'timeout' }

/**
 * 结果文件读取（读一次，ENOENT/IO 失败 → undefined——缺失即通道级失败，不重试不轮询）。
 */
function readResultFileOnce(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    return readFileSync(filePath, 'utf8').slice(0, RESULT_FILE_MAX_BYTES)
  } catch (e) {
    console.warn(`[subagent-model-gateway] result file read failed (${toErrorMessage(e)}): ${filePath}`)
    return undefined
  }
}

/** 读后即删（请求作用域生命周期收尾；残留无害——requestId 一次性、零消费方，§7.1.1）。 */
function deleteResultFile(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[subagent-model-gateway] result file cleanup failed (${toErrorMessage(e)}): ${filePath}`)
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 通道形状损坏统一报错（写读两侧同仓演化，畸形即集成损坏——不猜，如实报未知）。 */
function corruptReplyError(detail: string): SubagentModelSwitchError {
  return channelError(`模型切换结果回执形状损坏（${detail}）`)
}

/** 通道失败错误构造（§7.5 通道行统一恢复动作文案：不虚构「未生效」）。 */
function channelError(message: string): SubagentModelSwitchError {
  return new SubagentModelSwitchError(
    CHANNEL_ERROR_CODE,
    `${message}——是否已生效未知；恢复：重试切换（覆盖替换幂等），当前生效状态以面板与记录链为准`,
  )
}

/** chat 域错误应答 → 分型 reject（code 透传给 handler 的 error envelope）。 */
function rejectFromChatError(reply: Record<string, unknown>): never {
  const message = typeof reply.message === 'string' ? reply.message : 'model switch failed (no message)'
  const code = typeof reply.errorCode === 'string' ? reply.errorCode : 'subagent_model_switch_failed'
  throw new SubagentModelSwitchError(code, message)
}

/**
 * scope:error 信封 → 分型 reject（真实 code/message 透传）。
 */
function rejectFromErrorScope(file: { error?: unknown; message?: unknown }): never {
  // 校验型失败（ref 非法 / 目录无此模型 / 凭据预检 / thinking 档位 / run 已终局）+
  // handler 域内失败（D3-A4 缺陷修复：信封带 scope:error，真实 code/message 透传——
  // 不再笼统折算 subagent_model_switch_failed）。message 携带宿主编排的恢复指引。
  const err = isObject(file.error) ? (file.error as { code?: unknown; message?: unknown }) : undefined
  const code = typeof err?.code === 'string' && err.code !== '' ? err.code : 'subagent_model_switch_failed'
  const message =
    (typeof err?.message === 'string' && err.message !== '' && err.message) ||
    (typeof file.message === 'string' && file.message !== '' && file.message) ||
    'model switch rejected (no message)'
  throw new SubagentModelSwitchError(code, message)
}

/**
 * chat 域 reply → wire 应答映射（kind 三态分派；recorded.notice → wire note 是唯一改名位；
 * 未知 kind = 形状损坏）。
 */
function mapChatReplyToWireReply(reply: Record<string, unknown>): SubagentSetModelReply {
  if (reply.kind === 'effective') {
    return {
      kind: 'effective',
      effectiveModel: reply.effectiveModel as { provider: string; modelId: string },
      effectiveThinkingLevel: reply.effectiveThinkingLevel as string,
    }
  }
  if (reply.kind === 'recorded') {
    // 唯一改名位：core notice → wire note（§7.1 应答两型定形时的字段名分歧）。
    return { kind: 'recorded', note: reply.notice as string }
  }
  if (reply.kind === 'error') {
    rejectFromChatError(reply)
  }
  throw corruptReplyError(`chat reply.kind 未知（${String(reply.kind)}）`)
}

/**
 * scope:workflow-run aggregate → wire 聚合应答（结构等价投影：core
 * RunSwitchAggregateResult ≡ wire SubagentSetModelAggregateReply，形状 SSOT 注释在
 * core types.ts；「两处漂移由 U1 接线测试对账」的映射点即此处）。failures[].reason
 * 两侧同为开放值域（已知三型 ∪ 词表外透传码——透传不筛选不归一，对账锚 =
 * subagent-model-gateway.test.ts「core ↔ shared setModel 对账」段）。
 */
function mapAggregateToWireReply(aggregate: Record<string, unknown>): SubagentSetModelAggregateReply {
  return {
    members: aggregate.members as SubagentSetModelAggregateReply['members'],
    failures: aggregate.failures as SubagentSetModelAggregateReply['failures'],
    summary: aggregate.summary as string,
  }
}

/**
 * 结果文件内容 → wire 应答三形态映射（§7.1.1：extension 落 core SetModelReply 形状，
 * 本侧是 core → shared 的唯一映射点）。
 */
function mapResultFileToWireReply(raw: string): SubagentSetModelReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw corruptReplyError(`JSON 解析失败：${toErrorMessage(e)}`)
  }
  if (!isObject(parsed)) throw corruptReplyError('根非对象')
  const file = parsed as {
    scope?: unknown
    error?: unknown
    reply?: unknown
    aggregate?: unknown
    message?: unknown
    errorCode?: unknown
  }

  if (file.scope === 'error') {
    rejectFromErrorScope(file)
  }

  if (file.scope === 'chat') {
    const reply = file.reply
    if (!isObject(reply)) throw corruptReplyError('chat 域缺 reply')
    return mapChatReplyToWireReply(reply)
  }

  if (file.scope === 'workflow-run') {
    const aggregate = file.aggregate
    if (!isObject(aggregate)) throw corruptReplyError('run 级缺 aggregate')
    return mapAggregateToWireReply(aggregate)
  }

  throw corruptReplyError(`scope 未知（${String(file.scope)}）`)
}

/** 首帧读窗常数：4KB（信封 + created 帧头部 KB 级）。created 帧自身超窗时经行尾
 * 补读延伸（dmg-r3-1，见 readEventsRootSessionId 内注），窗口不为此调大——常态
 * 小帧零额外 IO。 */
const HEAD_BYTES = 4096

/** 行尾补读上界（dmg-r3-1）：run-created 帧 scriptSource 全文 / record-created 帧
 * task 全文可达数十 KB，上界给足余量又防异常巨行失控读盘（与 RESULT_FILE_MAX_BYTES
 * 同量级）；超界按坏行 warn 留痕。 */
// eslint-disable-next-line no-magic-numbers -- 上界常数 256KB（256 × 1024，语义见上注）
const ANCHOR_LINE_MAX_BYTES = 256 * 1024

/** 行尾补读的分块缓冲（8KB 步进，直到行尾 `\n` 或上界）。 */
const READ_TAIL_CHUNK_BYTES = 8192

const NEWLINE_BYTE = 0x0a

/**
 * 截断行的行尾补读（dmg-r3-1）：从窗口已读终点继续读至行尾 `\n`（含），有界；
 * EOF / 超上界无行尾返回 undefined（真坏行，调用方 warn 留痕）。UTF-8 自同步性
 * 保证 0x0A 不出现在多字节序列内部字节中，indexOf 命中即真换行；分块切点多字节
 * 字符产生的 U+FFFD 只影响大载荷值文本的显示保真度、不影响 JSON.parse 与锚字段
 * 读取（锚字段在帧头部，不落分块边界损坏面；本读取器只消费 rootSessionId）。
 */
function readLineTail(fd: number, fromOffset: number, maxBytes: number): string | undefined {
  const chunks: string[] = []
  let pos = fromOffset
  let consumed = 0
  const buf = Buffer.alloc(READ_TAIL_CHUNK_BYTES)
  while (consumed < maxBytes) {
    const want = Math.min(buf.length, maxBytes - consumed)
    let n: number
    try {
      n = readSync(fd, buf, 0, want, pos)
    } catch {
      return undefined
    }
    if (n <= 0) return undefined // EOF：行尾不存在（半写行）
    // 行尾判定只认本次实读字节 [0, n)——不扫残留区（上轮旧字节），不依赖
    // 「上轮无换行则残留区亦无」的归纳不变量
    const nl = buf.subarray(0, n).indexOf(NEWLINE_BYTE)
    if (nl !== -1) {
      chunks.push(buf.toString('utf-8', 0, nl))
      return chunks.join('')
    }
    chunks.push(buf.toString('utf-8', 0, n))
    consumed += n
    pos += n
  }
  return undefined // 行超上界
}

/**
 * record / run 事件文件首帧的 rootSessionId 读取（会话归属精确判定锚；recordId 侧
 * = D3-A4 缺陷修复，runId 侧 = dmg-r2-5 缺陷修复，同一形态）。按 createdType 过滤
 *（'record-created' / 'run-created'）多行扫描取值，不假设固定行号。只读文件头 4KB
 * 窗口；created 帧行自身超窗时（run-created 帧 scriptSource 全文 / record-created 帧
 * task 全文可达数十 KB——rootSessionId 不保证在载荷前部：record-created 帧字段序
 * task 在锚之前，buildCreatedEventPayload 实装）按行尾补读延伸该行后正常 parse。
 * 窗口内无 created 帧或解析失败返回 undefined（缺失语义归调用方裁决——recordId 侧
 * 归未命中，runId 侧回落目录存在性）；坏行（半写 / 超上界巨行）warn 留痕后同判
 * 无锚——不再静默 continue（dmg-r3-1：锚失败与旧格式行不可区分时，runId 侧弱锚
 * 放行 / recordId 侧误报 not_found 均无诊断入口）。
 */
function readEventsRootSessionId(eventsFile: string, createdType: string): string | undefined {
  const fd = openSync(eventsFile, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    const lines = buf.toString('utf-8', 0, n).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // 尾段被窗口切断（i = 末段且窗口被填满 = 文件更长）=「行未读完」而非
        // 「行损坏」：补读行尾重 parse。created 帧恒在文件头部（信封 + created
        // 前两行），本行即末段，无后续行可扫。补读失败 = 真坏行。
        const tail = i === lines.length - 1 && n === HEAD_BYTES
          ? readLineTail(fd, n, ANCHOR_LINE_MAX_BYTES - HEAD_BYTES)
          : undefined
        if (tail === undefined) {
          console.warn(`[subagent-model-gateway] ${createdType} anchor line unreadable (truncated past limit or partial write), treated as anchor-less: ${eventsFile}`)
          continue
        }
        try {
          parsed = JSON.parse(line + tail)
        } catch {
          console.warn(`[subagent-model-gateway] ${createdType} anchor line malformed after tail read, treated as anchor-less: ${eventsFile}`)
          continue
        }
      }
      if (!isObject(parsed) || (parsed as { type?: unknown }).type !== createdType) continue
      const root = (parsed as { rootSessionId?: unknown }).rootSessionId
      return typeof root === 'string' && root !== '' ? root : undefined
    }
    return undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * 网关生产实装工厂（组合根构造注入 server.optional.subagentModelSwitchGateway）。
 */
export function createSubagentModelSwitchGateway(deps: SubagentModelGatewayDeps): SubagentModelSwitchGateway {
  /**
   * 目标 → session 元数据（id + cwd 数据根）解析；解析不到 undefined（信封缺省语义）。
   * 定位锚与覆盖查询（model-override-query）同源：recordId = records 目录事件文件存在
   * 性（manifest 对偶，D3 落点；recordEventsPath 自带 id 白名单防穿越）+ created 帧
   * rootSessionId 精确归属；runId = 该 session workflow-state journal 存在性 + 首帧
   * rootSessionId 精确归属（dmg-r2-5——同 cwd 多会话共享同一 workflow-state 目录，
   * 仅凭存在性会把请求路由到非归属会话的 pi 进程）。
   */
  function resolveSessionMeta(target: { recordId?: string; runId?: string }): ScannedSessionMeta | undefined {
    const sessions = deps.scanSessions({ force: true })
    if (target.runId !== undefined) {
      if (!TARGET_ID_PATTERN.test(target.runId)) return undefined
      return sessions.find((s) => {
        const journalFile = join(dirname(s.filePath), STATE_DIR_NAME, `${target.runId}${RUN_EVENTS_SUFFIX}`)
        if (!existsSync(journalFile)) return false
        // 归属判定 = run-created 首帧 rootSessionId 精确匹配（对齐 recordId 侧
        // D3-A4 形态：目录由 cwd 派生、同 cwd 多会话共享——存在性只作快速过滤，
        // 首个命中会把请求路由到非归属会话的 pi 进程，宿主归属校验拒绝，成员端口
        // 解析落空而覆盖意图已写共享 journal，显示与实况不符）。旧格式首帧（本字段
        // 落地前的流，含 resume 复活的存量 run）无该字段 → undefined → 回落目录
        // 存在性命中（「旧格式行放行」同 scriptSource 先例——严格拒绝会让存量 run
        // 的模型切换整体失效，行为劣化）。
        const anchored = readEventsRootSessionId(journalFile, 'run-created')
        return anchored === undefined || anchored === s.id
      })
    }
    if (target.recordId !== undefined) {
      const agentDir = deps.agentDir ?? getPiAgentDir()
      const recordId = target.recordId
      return sessions.find((s) => {
        try {
          const eventsFile = recordEventsPath(getSubagentRecordsDir(agentDir, s.cwd), recordId)
          if (!existsSync(eventsFile)) return false
          // 归属判定 = record-created 帧 rootSessionId 精确匹配（D3-A4 缺陷修复：
          // recordsDir 由 cwd 派生、多会话共享同一目录——目录存在性只作快速过滤，
          // 首个命中会把请求路由到非归属会话的 pi 进程，宿主归属校验拒绝）。
          return readEventsRootSessionId(eventsFile, 'record-created') === s.id
        } catch {
          return false // 非法 record id = 白名单拒绝 = 未命中（守卫读面不抛）
        }
      })
    }
    return undefined
  }

  return {
    async setModel(params) {
      const target = { recordId: params.recordId, runId: params.runId }
      const meta = resolveSessionMeta(target)
      if (!meta) {
        const targetDesc = params.recordId ?? params.runId ?? '(missing)'
        throw new SubagentModelSwitchError(
          'subagent_target_not_found',
          `未找到目标 ${targetDesc} 所属的会话——目标可能已被清理；恢复：刷新 subagent 面板后重试，或确认目标仍存在`,
        )
      }
      const client = deps.getClient(meta.id)
      if (!client) {
        throw new SubagentModelSwitchError(
          'session_not_active',
          `Session ${meta.id} not active——模型切换的宿主编排运行在该会话的 pi 进程内，进程不在场无法执行（含记账写入）；恢复：激活该会话后重试切换`,
        )
      }

      const requestId = randomUUID()
      // 载荷单行 JSON（§7.1.1 要素 1：JSON 承载结构化载荷，避开定位参数文法转义负担）。
      const payload = JSON.stringify({
        requestId,
        ...(params.recordId !== undefined ? { recordId: params.recordId } : {}),
        ...(params.runId !== undefined ? { runId: params.runId } : {}),
        provider: params.provider,
        modelId: params.modelId,
        ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
      })
      const resultsFile = join(
        getSubagentModelSwitchResultsDir(deps.agentDir ?? getPiAgentDir(), meta.cwd),
        `${requestId}.json`,
      )

      // 出站点竞速：prompt 正常回（handler 返回后才解析——preflight「handled」于
      // handler 完成后发出，写后读成立）/ prompt 失败 / 超时三态。promptPromise 双分支
      // 归一为结局对象——竞速败者（迟到 resolve / 迟到 reject）零 unhandled 风险。
      let timer: ReturnType<typeof setTimeout> | undefined
      const promptPromise: Promise<PromptOutcome> = client.prompt(`/subagent-model ${payload}`).then(
        () => ({ kind: 'prompt' }) as PromptOutcome,
        (error: unknown) => ({ kind: 'prompt-error', error }) as PromptOutcome,
      )
      const timeoutPromise = new Promise<PromptOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), MODEL_SWITCH_PROMPT_TIMEOUT_MS)
      })
      let outcome: PromptOutcome
      try {
        outcome = await Promise.race([promptPromise, timeoutPromise])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }

      // 写后读一次 + 读后即删（超时路径同样先读——best-effort 迟到真值检查，命中按
      // 真实结果应答，§7.1.1 要素 4）。
      const raw = readResultFileOnce(resultsFile)
      deleteResultFile(resultsFile)
      if (raw === undefined) {
        if (outcome.kind === 'timeout') {
          throw channelError(`模型切换命令超时（${MODEL_SWITCH_PROMPT_TIMEOUT_MS}ms 内宿主未回执）`)
        }
        if (outcome.kind === 'prompt-error') {
          throw channelError(`模型切换命令发送失败（${toErrorMessage(outcome.error)}）`)
        }
        throw channelError('模型切换命令已执行但结果回执缺失（宿主 handler 未落结果文件）')
      }
      return mapResultFileToWireReply(raw)
    },

    resolveSessionId: (target) => resolveSessionMeta(target)?.id,
  }
}
