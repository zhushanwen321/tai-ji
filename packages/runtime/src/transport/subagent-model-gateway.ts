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
} from '@zhushanwen/subagent-core'

import type { SubagentModelSwitchGateway } from '../interfaces.js'
import type { ScannedSessionMeta } from '../services/ports/session.js'
import { getPiAgentDir } from '../infra/pi/pi-paths.js'
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
 * core types.ts；「两处漂移由 U1 接线测试对账」的映射点即此处）。
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

/**
 * record 事件文件的 rootSessionId 读取（会话归属精确判定锚，D3-A4 缺陷修复）。
 * 文件首行 = `{"type":"record-events","id":...}` 信封帧（无 rootSessionId），
 * `record-created` 帧在其后（实测恒为第 2 行）——按 type 过滤多行扫描取值，不假设
 * 固定行号。只读文件头 4KB 窗口（信封 + created 帧 KB 级）；窗口内无 created 帧或
 * 解析失败返回 undefined（= 未命中，调用方归 false）。
 */
function readRecordEventsRootSessionId(eventsFile: string): string | undefined {
  // eslint-disable-next-line no-magic-numbers -- 首帧读窗常数 4KB（信封 + created 帧 KB 级，语义见上注）
  const HEAD_BYTES = 4096
  const fd = openSync(eventsFile, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    for (const line of buf.toString('utf-8', 0, n).split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // 半写行（尾部截断）跳过，继续扫后续行
      }
      if (!isObject(parsed) || (parsed as { type?: unknown }).type !== 'record-created') continue
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
   * 定位锚与覆盖查询（model-override-query）同源：recordId = records 目录事件文件存在性
   * （manifest 对偶，D3 落点；recordEventsPath 自带 id 白名单防穿越）；runId = 该 session
   * workflow-state journal 存在性。
   */
  function resolveSessionMeta(target: { recordId?: string; runId?: string }): ScannedSessionMeta | undefined {
    const sessions = deps.scanSessions({ force: true })
    if (target.runId !== undefined) {
      if (!TARGET_ID_PATTERN.test(target.runId)) return undefined
      return sessions.find((s) =>
        existsSync(join(dirname(s.filePath), 'workflow-state', `${target.runId}${RUN_EVENTS_SUFFIX}`)),
      )
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
          return readRecordEventsRootSessionId(eventsFile) === s.id
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
