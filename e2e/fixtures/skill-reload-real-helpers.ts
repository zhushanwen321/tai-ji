/**
 * skill-reload real 轨共享 helper（skill-reload-survival / -askuser / -spawn-race /
 * workflow-disconnect-recovery 四 spec 共用）。
 * 来源设计：.tmp/tech-design/skill-reload-nondestructive.md §4（S1/S1b/S2）+
 * .tmp/tech-design/reload-closeout-reliability.md §4（A1 断言升级 / A2）；faux LLM 轨
 * 装配复用 launch-app-real（L2.5，凭证无关零 token——选型理由见 e2e-map.json E2E-SKILLRELOAD-* note）。
 *
 * ── 各断言的「样本来源」（全部 grep/读源码核实，非推断）──
 * - workflowUpdate 增量信号帧：payload = { sessionId, update: { runId, status, reason? } }
 *   （session-records.ts publishRecordChanges）；status ∈ 'running'|'done' 两态
 *   （WorkflowRunStatus；failed 是 reason 维度，非 status）。run 启动即广播 running。
 * - D8-a 归因行 `[skill-reload] dir=<global|project:<cwd>> event=<chokidar 原生枚举>
 *   affectedSessions=[...]`：packages/runtime/src/services/skill-registry.ts:762
 *   （console.log → infra/logger.ts:434 console 补丁 → <dataDir>/logs/runtime-<date>.log，
 *   logger.ts:346）。
 * - D8-b 决策行 `[reload-orchestrator] sessionId=<sid> decision=immediate|queued|
 *   queued-consumed|skipped-deleted`：services/session/reload-orchestrator.ts:70/89/100/108/113。
 * - preserved 行 `[workflow-events] session_shutdown reason=reload preserved={runs:N,
 *   records:M, stores:K}`：extensions/universal/subagent-workflow/src/workflow-events.ts:486，
 *   走 extension-logger logger.debug——**仅在 TAIJI_AGENT_DEBUG=1 时落文件**
 *   （extensions/shared/extension-logger/src/index.ts:411-434：`<agentDir>/logs/<extName>-<date>.log`，
 *   extName="subagents"；agentDir = PI_CODING_AGENT_DIR = <dataDir>/agent，rpc-client.ts:283 注入）。
 *   因此消费本 helper 的 spec 必须在 launchRealApp 前设 process.env.TAIJI_AGENT_DEBUG='1'。
 * - preserved 计数语义：runs = workflow run 聚合根数；records = Σ run.state.calls.size
 *   （每 call 对应一条 subagent record）；stores = sessionState 条目数（workflow-events.ts:477-487）。
 * - run 存活反证串：`[relay] connection lost, killing child (kill-on-disconnect)` 与
 *   `[relay] child exited recordId=... code=143`（infra/relay/relay-registry.ts:465/459）。
 * - workflow-record 权威 entry：主 session JSONL `{"customType":"workflow-record","data":
 *   {v:1,snapshot}}`，snapshot.state.status ∈ 'running'|'done'（orchestration/models/types.ts:34
 *   两态；终态 flush 永不节流），读取形态同 workflow-thinkinglevel-real.spec.ts findWorkflowRecord。
 * - composer skill 浮层候选行：CommandPopover.vue:95 `.cmd-row`（portal 到 body，00-overview §6.4），
 *   skill 项 displayName = 裸名（command-popover-skill-candidates.ts:68，`/skill:` 前缀已去）。
 *   触发 = 行中空白后 `/`（非换行空白 + `/`，空 query 合法——dom-core skill-trigger.test.ts 锁定语义）。
 * - 托盘：`[data-testid="tray-builtin-button"][data-kind="workflow"]` +
 *   `[data-testid="tray-builtin-count"]`（ComposerTray.vue:81/106-110；data-state running|idle）。
 * - 引擎 CLI 进程 marker：`pi-subagent-cli.mjs`（faux 轨 seedFauxDataDir 的 subagents/config.json
 *   command/args，launch-app-real.ts:185-193）；relay 代理 marker `relay.mjs`（内嵌镜像脚本文件名，
 *   subagent-core/src/execution/relay-env.ts:12）；真实 pi 子进程 marker：bundled pi 二进制
 *   `resources/pi/`（findPiExecutable 缺省）。
 * - 项目 skill 目录 `<cwd>/.pi/skills` 进扫描集与 watch 集：services/skill-dirs.ts:39/95
 *   （A1 扫描集对账）；skill name = 目录名（scanners/skill-scanner.ts loadSkillFromDir）。
 * - 全局 skill 目录：`<dataDir>/agent/skills`（skill-dirs.ts:72 resolveGlobalSkillDirs 首项）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRuntimeLogs, type FauxStep } from './launch-app-real'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 把一个 staged builtin extension bundle 种进 `<dataDir>/agent/extensions/<name>/`
 * （subagent pi 孙进程的唯一扩展发现通道——TAIJI_EXTENSION_PATHS 只注入主 pi）。
 * 用 staged 形态而非源码：bundle 自包含（esbuild noExternal，零外部 require），源码形态
 * 的 workspace 依赖（@zhushanwen/extension-protocol 等）在 mkdtemp 目录解析不到。
 * staged package.json 的 main 指向 index.ts（builtin 装载链不走 main），此处改指 index.js。
 */
export function seedSubagentExtension(dataDir: string, stagedName: string): string {
  const staged = path.join(REPO_ROOT, 'apps', 'electron', 'resources', 'extensions', '@zhushanwen', stagedName)
  const bundle = path.join(staged, 'index.js')
  if (!fs.existsSync(bundle)) {
    throw new Error(`seedSubagentExtension: staged bundle 缺失 ${bundle}——先跑 node scripts/bundle-extensions.mjs`)
  }
  const dest = path.join(dataDir, 'agent', 'extensions', stagedName)
  fs.mkdirSync(dest, { recursive: true })
  fs.copyFileSync(bundle, path.join(dest, 'index.js'))
  const pkg = JSON.parse(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'))
  pkg.main = 'index.js'
  // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，staged package.json 与源格式保持一致（auth-storage 同款豁免）
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkg, null, 2))
  return dest
}

/** faux 流控（tokens/s，pi-ai faux 按 chars/4 估 token）：长文本 2400 chars ≈ 60s 单响应 */
export const FAUX_TPS = 10
/** subagent 长响应文本长度（chars）。duration ≈ chars / (4 × FAUX_TPS) */
export const SUBAGENT_STREAM_CHARS = 2400

/** faux 槽位演员（launch-app-real seedFauxDataDir 四演员清单内的两个 slot actor） */
export const SUB_MODEL_A = 'faux/faux-1-b'
export const SUB_MODEL_B = 'faux/faux-1-c'

/** mkdtemp 前缀统一走 os.tmpdir()（测试红线：写删目标自建自删） */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** SKILL.md 最小内容（skill-scanner：description 取正文首个非标题行；name 取目录名） */
export function makeSkillMd(description: string): string {
  return ['# skill', '', description, '', 'Instructions: reply with a short confirmation.', ''].join('\n')
}

/** 写项目 skill `<projectDir>/.pi/skills/<name>/SKILL.md`（存在即覆盖 = 模拟编辑） */
export function writeProjectSkill(projectDir: string, name: string, description: string): string {
  const dir = path.join(projectDir, '.pi', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  fs.writeFileSync(file, makeSkillMd(description))
  return file
}

/**
 * 写全局 skill `<dataDir>/agent/skills/<name>/SKILL.md`（resolveGlobalSkillDirs 首项目录）。
 * 返回 skill 目录路径——调用方 finally 里必须 rmSync（全局目录写入红线：唯一临时名 + 清理；
 * dataDir 本身是 mkdtemp，整树删除是兜底，显式删是纪律）。
 */
export function writeGlobalSkill(dataDir: string, name: string, description: string): string {
  const dir = path.join(dataDir, 'agent', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), makeSkillMd(description))
  return dir
}

/**
 * workflow 探针脚本源码（单 agent() 调用，faux 槽位演员长响应保持 run 在飞）。
 * lintScript 约束：含 agent() 入口 / 无 bare IIFE / 不用 result 作变量名。
 */
export function makeSurvivalProbeSource(scriptName: string, model: string, description: string): string {
  return [
    `// ${scriptName} — skill-reload real 轨探针（e2e 运行期生成，非 repo fixture）`,
    '/* @pi-meta',
    `name: ${scriptName}`,
    `description: ${description}`,
    'phases: ["probe"]',
    '*/',
    '',
    'phase("probe");',
    '',
    `const outcome = await agent({`,
    '  prompt: "Reply with the verification text and nothing else.",',
    `  model: "${model}",`,
    `  description: "${description}",`,
    '});',
    '',
    'return outcome;',
    '',
  ].join('\n')
}

/** 写 user 级 workflow 脚本（<dataDir>/agent/workflows/，00-overview §5.4 唯一可靠发现路径） */
export function writeUserWorkflowScripts(dataDir: string, scripts: Array<{ name: string; source: string }>): string[] {
  const dir = path.join(dataDir, 'agent', 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  return scripts.map(({ name, source }) => {
    const file = path.join(dir, `${name}.js`)
    fs.writeFileSync(file, source)
    return file
  })
}

/** 主对话 faux 队列：逐轮 toolCall workflow run → 收尾文本（run 后台启动，turn 随即结束） */
export function mainDispatchSteps(runPaths: string[], closingText: string): FauxStep[] {
  const steps: FauxStep[] = runPaths.map((p) => ({
    toolCalls: [{ name: 'workflow', args: { action: 'run', name: p } }],
  }))
  steps.push({ text: closingText })
  return steps
}

/** subagent faux 队列（model-keyed）：长流式响应保持 run 在飞跨越编辑→reload→adoption 全窗口 */
export function survivorSteps(model: string, streamText: string, extraSteps: FauxStep[] = []): Record<string, FauxStep[]> {
  return { [model]: [{ text: streamText }, ...extraSteps] }
}

/** 读 <dataDir>/agent/logs/ 下 extension 文件日志（preserved 行证据源；TAIJI_AGENT_DEBUG=1 时产出） */
export function readExtensionLogs(dataDir: string): string {
  const logDir = path.join(dataDir, 'agent', 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs.readdirSync(logDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
    .join('\n')
}

/** 轮询节奏常量（日志/文件轮询间隔） */
const LOG_POLL_INTERVAL_MS = 500
/** 引擎执行树死亡级联（stdin EOF → relay 断连 → kill-on-disconnect）的宽限上界 */
const ENGINE_TREE_GONE_TIMEOUT_MS = 15_000
/** 引擎执行树归零核对间隔 */
const TREE_POLL_INTERVAL_MS = 1000

/** 轮询 readFn 产物直到 matcher 命中，返回命中行；超时返回 null（断言由调用方继续） */
export async function waitForLogLine(
  readFn: () => string,
  matcher: (line: string) => boolean,
  timeoutMs: number,
  intervalMs = LOG_POLL_INTERVAL_MS,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = readFn().split('\n').find((l) => matcher(l))
    if (hit !== undefined) return hit
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

/** preserved 行计数解析（取最后一条；计数语义见文件头） */
export interface PreservedCounts {
  runs: number
  records: number
  stores: number
}
export function parseLastPreserved(logs: string): PreservedCounts | null {
  const lines = logs.split('\n').filter((l) => l.includes('session_shutdown reason=reload preserved={'))
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  const runs = /runs:(\d+)/.exec(last)?.[1]
  const records = /records:(\d+)/.exec(last)?.[1]
  const stores = /stores:(\d+)/.exec(last)?.[1]
  if (runs === undefined || records === undefined || stores === undefined) return null
  return { runs: Number(runs), records: Number(records), stores: Number(stores) }
}

/** runtime 日志按行谓词匹配（D8-a/D8-b/kill 串的读取口；路径 = readRuntimeLogs） */
export function runtimeLogLines(dataDir: string): string[] {
  return readRuntimeLogs(dataDir).split('\n')
}

/** 读 JSONL 文件为 unknown[]（不可读/空文件返回 null——pi 延迟写入策略下文件可能未落） */
export function readJsonlEntries(file: string): unknown[] | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (raw === '') return null
    return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown)
  } catch {
    return null
  }
}

/** workflow-record entry 最小投影（只取断言消费的 runId/status 面） */
export interface WorkflowRecordView {
  runId: string
  status: string | undefined
}

/** 提取主 session JSONL 内指定 runId 的最后一条 workflow-record（W17：last-wins 终态） */
export function lastWorkflowRecordFor(file: string, runId: string): WorkflowRecordView | null {
  const entries = readJsonlEntries(file)
  if (entries === null) return null
  let latest: WorkflowRecordView | null = null
  for (const e of entries) {
    const rec = e as { customType?: unknown; data?: { v?: unknown; snapshot?: { runId?: unknown; state?: { status?: unknown } } } }
    if (rec?.customType !== 'workflow-record' || rec?.data?.v !== 1) continue
    const snap = rec.data.snapshot
    if (typeof snap?.runId !== 'string' || snap.runId !== runId) continue
    latest = {
      runId: snap.runId,
      status: typeof snap.state?.status === 'string' ? snap.state.status : undefined,
    }
  }
  return latest
}

// ── run 完成 → done 增量信号帧到达的双锚计时（S1b/S2 共用，G1 必达窗口断言） ──

/**
 * 双锚计时结果（reload-closeout-reliability 设计 §4 A1 新断言的观测面）。
 * - tDoneRecord：主 session JSONL 末条 workflow-record 落 done 的首见时刻——完成锚
 *   （权威 record 落盘 = 系统语义上的「run 完成」，W17 last-wins 终态）。
 * - tFrameSeen：spec WS events 首见 status=done 增量信号帧的时刻——到达锚
 *   （含 ≤DONE_TIMING_POLL_MS 轮询观测粒度；帧到达更早时观测值只晚不早）。
 * 负时差（帧先于文件 flush 被观测到）由调用方钳 0——收敛更早同样满足必达语义，
 * 30s 红线防的是「悬挂到下一次 reload」的失败形态（分钟级/永不到达），钳 0 不会掩盖它。
 */
export interface WorkflowDoneTiming {
  runId: string
  tDoneRecord: number
  tFrameSeen: number
}

/** 计时轮询间隔：30s 红线的观测粒度（断言侧 +2× 本值容差） */
const DONE_TIMING_POLL_MS = 500

/** 双锚等待总时限（与旧版 awaitDone 同款 150s：长流式收尾 + flush 慢路径的宽限上界） */
const DONE_TIMING_TIMEOUT_MS = 150_000

/**
 * 等「run 完成（JSONL 终态 done）+ done 增量信号帧到达 spec WS」双事件并记录各自首见时刻。
 * 两锚都见到才返回（时序不定：帧可先于文件 flush 到达，反之亦然）；deadline 内未见全返回 null。
 *
 * runId 取 events 内首条 workflowUpdate 帧（running 帧——run 启动即广播；harness 防重播种
 * 守卫后每 session 单 run，首个 runId 即目标）。events 全量遍历（禁 find：running 帧先入数组
 * 且 find 恒返回首帧，done 帧永不被检视——S1b/S2 既有注释同款教训）。
 */
export async function awaitWorkflowDoneTimed(
  events: Array<{ type?: string; payload?: Record<string, unknown> }>,
  sessionFile: string | null,
  timeoutMs = DONE_TIMING_TIMEOUT_MS,
): Promise<WorkflowDoneTiming | null> {
  const deadline = Date.now() + timeoutMs
  let runId = ''
  let tDoneRecord = 0
  let tFrameSeen = 0
  while (Date.now() < deadline) {
    for (const e of events) {
      if (e.type !== 'session.workflowUpdate') continue
      const update = e.payload?.update as { status?: unknown; runId?: unknown } | undefined
      if (update === undefined || typeof update.runId !== 'string') continue
      if (runId === '') runId = update.runId
      if (update.runId === runId && update.status === 'done' && tFrameSeen === 0) {
        tFrameSeen = Date.now()
      }
    }
    if (runId !== '' && tDoneRecord === 0 && sessionFile !== null
      && lastWorkflowRecordFor(sessionFile, runId)?.status === 'done') {
      tDoneRecord = Date.now()
    }
    if (runId !== '' && tDoneRecord !== 0 && tFrameSeen !== 0) {
      return { runId, tDoneRecord, tFrameSeen }
    }
    await new Promise((r) => setTimeout(r, DONE_TIMING_POLL_MS))
  }
  return null
}

/** G1 必达窗口红线（ms）：agent_settled 对账腿秒级 / 15s 定时腿最坏 ≈15s+单轮，30s = 2x 余量 */
export const WORKFLOW_DONE_MAX_LATENCY_MS = 30_000

/** 观测容差倍数：完成锚与到达锚各含一次观测延迟 */
const OBSERVE_SLACK_MULTIPLIER = 2

/** 到达锚观测容差（ms）= 2× 轮询粒度 */
export const DONE_TIMING_OBSERVE_SLACK_MS = OBSERVE_SLACK_MULTIPLIER * DONE_TIMING_POLL_MS

// ── 进程面（孤儿检查 / 引擎 pid 稳定性） ──────────────────────────────

/** ps 单行最小面 */
interface PsEntry {
  pid: number
  command: string
}

function psEntries(): PsEntry[] {
  const out = execFileSync('ps', ['-Ao', 'pid=', '-o', 'command='], { encoding: 'utf8' })
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (m === null) return []
    return [{ pid: Number(m[1]), command: m[2] }]
  })
}

/** 引擎执行树 marker（含子进程；孤儿子集都是这三族，见文件头 marker 说明） */
const ENGINE_TREE_MARKERS = ['pi-subagent-cli.mjs', 'relay.mjs', 'resources/pi/'] as const

function pidsMatching(markers: readonly string[]): number[] {
  // 排除宿主同跑实例：marker 是通用串（relay.mjs / resources/pi/ / pi-subagent-cli.mjs），
  // 同机其他 taiji 实例的引擎执行树进程同样命中，全局 ps 扫描凭 marker 无法区分。
  // 判属锚点 = binary/cli 载体路径（REPO_ROOT）：被测实例全部引擎进程都从本 worktree
  // 的 resources 加载（electron dist spawn 的 pi binary / relay / cli 全在本仓下），
  // argv 必含 REPO_ROOT；兄弟 worktree dev 实例与打包版 TaiJi.app 的载体路径都在别处。
  // 不能凭 session-dir / 数据目录特征判属——数据目录走 env 不走 argv，两类外来实例
  // 都实测出现过 argv 无 --session-dir 且无 ~/.taiji 提法的形态（打包版 relay 曾因此
  // 误计入 baseline，2026-09-19 复验实证；兄弟 dev 的 rpc pi 曾因此落入「不含 ~/.taiji
  // 兜底」误报孤儿，2026-09-19 终态确认实证，活态污染 3→6→8 个）；--append-system-prompt
  // 等参数值也可能恰好落在本机 tmp 根下，任意 tmp 提法匹配同样不可靠。
  return psEntries()
    .filter((e) => markers.some((mk) => e.command.includes(mk)))
    .filter((e) => e.command.includes(REPO_ROOT))
    .map((e) => e.pid)
    .sort((a, b) => a - b)
}

/** 引擎 CLI 进程 pid 集（D2b 稳定性断言面：reload 前后同一集合 = 单例未被 dispose 重建） */
export function engineCliPids(): number[] {
  return pidsMatching(['pi-subagent-cli.mjs'])
}

/** 引擎执行树全量 pid（派发后采集 = 基线；清理后归零核对 = 无孤儿） */
export function engineTreePids(): number[] {
  return pidsMatching(ENGINE_TREE_MARKERS)
}

/** 轮询引擎执行树 pid 归零（相对基线；宽限给 stdin EOF → relay 断连 → kill 级联留时） */
export async function waitForEngineTreeGone(baselinePids: number[], timeoutMs = ENGINE_TREE_GONE_TIMEOUT_MS): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = engineTreePids().filter((pid) => baselinePids.includes(pid))
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, TREE_POLL_INTERVAL_MS))
    remaining = engineTreePids().filter((pid) => baselinePids.includes(pid))
  }
  return remaining
}
