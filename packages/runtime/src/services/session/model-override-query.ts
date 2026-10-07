/**
 * model-override-query — 覆盖记账的 runtime 侧磁盘投影查询（subagent-model-switch
 * §9 transport 行「详情载荷组装时经覆盖查询端口读取」的生产后端）。
 *
 * 权威源（shared SubagentModelOverrideStatus 注释锚定）：
 * - chat 域：record 事件文件（`<recordsDir>/<recordId><RECORD_EVENTS_SUFFIX>`）的
 *   `record-model-override` 帧（core RecordEventFoldState.modelOverride 槽位的盘上源）；
 * - run 域：run journal（`<sessionDir>/workflow-state/<runId><RUN_EVENTS_SUFFIX>`）的
 *   `model-override` 帧（core latestModelOverride 的盘上源）。
 *
 * 读取语义 = 尾向扫描首条命中即权威值：两域 fold 对覆盖帧都是「后写整替、无清除帧」
 * （record-events.ts applyRecordEvent 的 modelOverride case / run-events.ts
 * latestModelOverride 单点注释）——最新一条覆盖帧 ≡ fold 槽位终值，构造性等价。
 *
 * 读取形态 = 尾块倒序（subagent-model-switch U1 确立的成本口径：详情载荷
 * 组装路径的同步尾读；live 帧发布受水位 diff 门控非高频）。pi session 侧的同款
 * 尾读已下沉 infra/pi 单点（extractLatestModelChangeFromJsonl 骨架）；本文件读
 * record 域独立文件（覆盖帧文件 / run journal，非 pi session `.jsonl`，无树结构
 * 无活跃路径需求）且定位链需 sessionStore 注入，保留 services 层手写尾读形态
 * （runtime-layering §3④ 基线债登记）。登记限制：覆盖帧小载荷
 * （~200B），尾部被海量 worker-log 堆积淹没且覆盖帧早于窗口起点时漏读 = 载荷按无覆盖
 * 显示（字段缺席 = 无覆盖语义，不虚报）。
 *
 * 定位链（与 SessionRecords.ensureProjection 同源约定）：
 * - chat：sessionId → scanSessions cwd → getSubagentRecordsDir(getPiAgentDir(), cwd)
 *   → recordEventsPath（core 单源，含 recordId 白名单防穿越）；
 * - run：sessionId → scanSessions filePath → `dirname/workflow-state`（ensureProjection
 *   runJournalDir 同式派生）→ `<runId><RUN_EVENTS_SUFFIX>`。已知限制同族：cwd 含
 *   `:`/`\` 时写侧探测落 agentDir 根、本侧推导落 session 文件目录（ensureProjection
 *   头注已登记，根治属 core 布局单源）——run 域查询同受此限。
 *
 * 错误形态：查询是详情载荷组装路径的内嵌步骤，IO/解析失败降级返回 undefined
 * （best-effort 语义，与同族尾读派生一致）——ENOENT = 合法缺省（覆盖从未下达 /
 * journal 未创建）静默返回，其余故障 warn 留痕后 undefined；载荷查询故障不得炸掉
 * 面板列表读 RPC；undefined = 字段缺席 = 无覆盖语义，不虚构。
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SubagentModelOverrideStatus } from '@taiji/shared'
import {
  getSubagentRecordsDir,
  parseRecordEventFileLine,
  recordEventsPath,
  RUN_EVENTS_SUFFIX,
  STATE_DIR_NAME,
  type RecordEvent,
  type WorkflowRunEvent,
} from '@zhushanwen/subagent-core'
import type { ISessionStore } from '../ports/session.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { toErrorMessage } from '../../utils/errors.js'
import { parseWorkflowRunEventFileLine } from './events-projection.js'

/** 覆盖帧尾读窗口（subagent-model-switch U1 尾读窗口成本口径）。 */
const OVERRIDE_TAIL_WINDOW_KB = 256
const BYTES_PER_KB = 1024
const OVERRIDE_TAIL_WINDOW_BYTES = OVERRIDE_TAIL_WINDOW_KB * BYTES_PER_KB

/**
 * run id 白名单：`[\w-]{1,128}`（与 core record id 白名单 RECORD_ID_PATTERN /
 * gateway TARGET_ID_PATTERN 同式，同式漂移由各处注释锚定）。run journal 文件名
 * = runId + RUN_EVENTS_SUFFIX 直拼（core runEventJournalPathIn 读面刻意不夹带
 * 校验），防穿越校验归本查询读入口，与 getRecordOverride 经 recordEventsPath
 * 白名单防御对称；runId 生产源 = 投影内 core 生成 runId，字符集 ⊆ 白名单。
 */
const RUN_ID_PATTERN = /^[\w-]{1,128}$/

/** modelOverrideQuery 窄口（session-records deps / workflow-record-projection 入参同形；
 *  覆盖状态查询的唯一入口——切换网关不承载查询，M1-3 收敛）。 */
export interface ModelOverrideQuery {
  getRecordOverride(sessionId: string, recordId: string): SubagentModelOverrideStatus | undefined
  getRunOverride(sessionId: string, runId: string): SubagentModelOverrideStatus | undefined
}

export interface ModelOverrideQueryDeps { // oe-exempt:20261006:framework:查询工厂依赖注入面（SessionService 装配注入，单实现常态）
  /** session 存储端口（sessionId → cwd / session 文件路径解析，scanSessions force 语义）。 */
  sessionStore: ISessionStore
  /** pi agent 目录锚（记录域 subagents/ 布局根；缺省 getPiAgentDir()，测试注入 tmp）。 */
  agentDir?: string
}

/**
 * 尾块倒序读出首条命中帧：
 * 窗口起点切在行中间时残行不可解析，解析器按坏行跳过（两域 parse 均宽容语义）。
 */
function readTailFrame<T>(
  filePath: string,
  parseLine: (line: string) => T | undefined,
  isTarget: (frame: T) => boolean,
  warnTag: string,
): T | undefined {
  let size: number
  try {
    size = statSync(filePath).size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined // 文件不存在（覆盖从未下达 / journal 未创建）= 合法缺省 = 无覆盖
    }
    console.warn(`[model-override-query] ${warnTag} stat failed (${toErrorMessage(e)}): ${filePath}`)
    return undefined
  }
  const readLen = Math.min(size, OVERRIDE_TAIL_WINDOW_BYTES)
  const start = size - readLen
  let text: string
  try {
    const buf = Buffer.alloc(readLen)
    const fd = openSync(filePath, 'r')
    try {
      readSync(fd, buf, 0, readLen, start)
    } finally {
      closeSync(fd)
    }
    text = buf.toString('utf8')
  } catch (e) {
    console.warn(`[model-override-query] ${warnTag} tail read failed (${toErrorMessage(e)}): ${filePath}`)
    return undefined
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const frame = parseLine(lines[i] ?? '')
    if (frame !== undefined && isTarget(frame)) return frame
  }
  return undefined
}

/** 覆盖帧 → wire 状态形状（canonical ref 串 'provider/id'；shared SubagentModelOverrideStatus）。 */
function toOverrideStatus(model: { provider: string; modelId: string }, thinkingLevel?: string): SubagentModelOverrideStatus {
  return { model: `${model.provider}/${model.modelId}`, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }
}

/** 定位 session 的 cwd（scanSessions force——刚落盘 session 的单 session 路径解析语义，wave:perf-w26 plan M-3）。 */
function resolveSessionMeta(
  sessionStore: ISessionStore,
  sessionId: string,
): { cwd?: string; filePath?: string } {
  const target = sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
  if (!target) return {}
  return { cwd: target.cwd, filePath: target.filePath }
}

/**
 * 覆盖查询生产实装（session 域装配点构造注入；测试经 deps.modelOverrideQuery 显式
 * 传 mock 覆盖——U1「端口缺席 = 载荷不造键」测试语义不受本实装影响）。
 */
export function createModelOverrideQuery(deps: ModelOverrideQueryDeps): ModelOverrideQuery {
  return {
    getRecordOverride(sessionId, recordId) {
      const { cwd } = resolveSessionMeta(deps.sessionStore, sessionId)
      if (typeof cwd !== 'string') return undefined
      let filePath: string
      try {
        // core recordEventsPath 单源（含 record id 白名单防穿越校验——非法 id 上抛，
        // 调用方 id 源 = 投影注册条目，throw 即编程错误，不静默吞）。
        filePath = recordEventsPath(getSubagentRecordsDir(deps.agentDir ?? getPiAgentDir(), cwd), recordId)
      } catch (e) {
        console.warn(`[model-override-query] record id rejected (${toErrorMessage(e)}): ${recordId}`)
        return undefined
      }
      const frame = readTailFrame<RecordEvent>(
        filePath,
        parseRecordEventFileLine,
        (event) => event.type === 'record-model-override',
        'record override',
      )
      if (frame === undefined || frame.type !== 'record-model-override') return undefined
      return toOverrideStatus(frame.ref, frame.thinkingLevel)
    },

    getRunOverride(sessionId, runId) {
      const { filePath } = resolveSessionMeta(deps.sessionStore, sessionId)
      if (typeof filePath !== 'string') return undefined
      // 非法 runId：warn 留痕后按无覆盖降级（对齐 record id rejected 先例）；
      // wire 入口侧的输入校验归 gateway TARGET_ID_PATTERN，本处为路径直拼前的
      // 读侧防穿越（同 id 三处防御对称）。
      if (!RUN_ID_PATTERN.test(runId)) {
        console.warn(`[model-override-query] run id rejected: ${runId}`)
        return undefined
      }
      const journalPath = join(dirname(filePath), STATE_DIR_NAME, `${runId}${RUN_EVENTS_SUFFIX}`)
      const frame = readTailFrame<WorkflowRunEvent>(
        journalPath,
        parseWorkflowRunEventFileLine,
        (event) => event.type === 'model-override',
        'run override',
      )
      if (frame === undefined || frame.type !== 'model-override') return undefined
      return toOverrideStatus(frame.model, frame.thinkingLevel)
    },
  }
}
