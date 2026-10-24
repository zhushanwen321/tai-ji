/**
 * p0-restart-merge-sweep —— 宿主重启合并清点（验收项 A3 / 设计 §3.3.4 场景 3）：
 * kill -9 重启 → record 轮收条补失联（interrupted-by-restart + swept 附注）→
 * pending 债结清 lost → 占用计数归零 → 全程无时间窗（启动一次性扫描 + reattach 链内对账）。
 *
 * 装配：mock-http（本机 mock OpenAI 服务，零 token / 零外网；subagent 孙进程唯一零 token 通道）。
 *
 * 双实例编排（核心边界）：runner 的主实例生命周期归 runner 管，本剧本不触碰 ctx.instance /
 * ctx.protocol（主实例闲置）；kill 与重启的对象是剧本自建的第二实例（独立 name + 独立
 * data-dir，同 lib/instance.mjs 生命周期原语）：
 *   段 1 造在途——自建实例 A（mock-http 装配）建 session、主队 step0 派 subagent_start、
 *     成员队单步超长文本 + server 级 tps 拉低（8 000 字符 × 25ms/字符 ≈ 200s 流式窗口），
 *     四条件全满足才认定「在途态成立」：① record running 且轮收条未写 ② mock 收到成员模型
 *     200 请求 ③ manifest 快照 executionStatus=running（清点候选枚举的直接判据）
 *     ④ 主 session JSONL 已落 pending:register（债权在册——结清断言的前置）。
 *   段 2 kill -9——先 pgrep -P 递归收集自建实例进程树全部后代 PID，再对装配器 PID +
 *     后代逐个 SIGKILL（精确 PID 打击，禁 pkill 宽匹配）；随后条件轮询 vite/cdp/runtime
 *     端口释放，残留 owner 属收集列表才补刀，列表外 PID 只呈证据不盲杀。
 *     注：装配器 spawn 的 concurrently 子树是独立进程组（dev-instance.mjs launch detached），
 *     SIGKILL 装配器不波及子树——必须整树逐 PID 杀，这正是「宿主暴死」的模拟形态。
 *   段 3 重启——同 name + 同 data-dir 重新 createInstance + launch + waitReady（三条就绪判据）。
 *   段 4 断言①（C 通道主证据）——就绪后（会话激活前）≤10s 内三件磁盘/日志事实同时成立：
 *     manifest 快照 idle+interrupted-by-restart、record 事件文件的轮收条帧（停因 +
 *     swept 附注）、runtime 日志 startup sweep (records) 结果行。此段的观测面全部是
 *     磁盘事实，不依赖会话激活；同时记录一次激活前 getSubagents 探测（仅作查询面
 *     观测证据 attach，不作断言——新代际未激活会话的查询面语义见 gotchas）。
 *   段 5 断言①②③（激活后，B/C 同窗）——session.switch 触发 reattach（runtime respawn
 *     pi → extension session_start → initSession → 注册对账 sweep），≤45s 内双事实：
 *     getSubagents 的 record.stopReason=interrupted-by-restart + 无在途占用（①②③ B 位），
 *     主 session JSONL 出现 pending:unregister 且 reason=lost（②）。
 *   段 6 终态证据 + 收尾（dispose 重启后实例 + 删自建 data-dir）。
 *
 * wire 面事实（源码核实，断言位置依据）：
 *   - record 事件帧（C 位）：<recordsDir>/<sa-id>.events 的 record-round-idle 帧携带
 *     stopReason=interrupted-by-restart + swept={at,evidence}（record-restart-sweep.ts 唯一
 *     停因实参 + 清点附注落点）——swept 硬断言的权威事实位；
 *   - runtime wire（B 位）：session.getSubagents 的 SubagentRecord.lastRound **按设计不含
 *     swept**（events-projection-last-round.ts 头注：swept 附注不进 wire，失联标注经
 *     record.stopReason 宿主中断族值呈现）——故 B 位只断言 record.stopReason。
 *
 *
 * 实装锚（断言依据，均为源码核实事实）：
 *   - record 侧清点 = packages/subagent-core/src/orchestration/record-restart-sweep.ts
 *     （manifest 快照在途候选 + 事件流末帧确认 → 补 record-round-idle 帧：stopReason=
 *     SWEPT_STOP_REASON + swept={at,evidence}；runtime 日志行
 *     `[subagents] startup sweep (records): swept N interrupted record(s)`）；
 *   - wire 透传 = packages/subagent-core/src/execution/persistence/record-store-rebuild.ts
 *     lastRoundFromFold（swept 附注随 lastRound 到达 getSubagents wire）；
 *   - pending 结清 = packages/subagent-core/src/execution/registry-reconcile/{sweep-binding,
 *     reconcile-sweep}.ts（轮收条停因 interrupted-by-restart → 结清 lost → pi.appendEntry
 *     落主 session JSONL，data={id, reason, status}）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { createInstance, DEV_DATA_PARENT, portOwners, cmdOf, readRuntimeLogs } from '../scripts/lib/instance.mjs'

const SLUG = 'rsweep-sub'
const SUB_MODEL = 'mock-sub-a'
const MAIN_MODEL = 'mock-1'
/** 成员队单步长文本（≈8 000 字符）：tps=10 下约 200s 流式窗口，kill 必然落在在途段。 */
const MEMBER_LONG_TEXT = 'RSWEEP_INFLIGHT_CANARY '.repeat(400)
/** 无时间窗断言的观测余量上限：①③（启动扫描）10s；②（reattach 对账）45s——量级依据见 gotchas。 */
const SWEEP_DEADLINE_MS = 10_000
const SETTLE_DEADLINE_MS = 45_000

/** mock-http 剧本（model-keyed）：主队派发两步 + 成员队长在途单步。 */
function buildResponses() {  return {
    [`mockllm/${MAIN_MODEL}`]: [
      {
        text: '派一个子任务去核对：',
        toolCalls: [
          {
            name: 'subagent_start',
            args: {
              task: 'Keep streaming your scripted long answer until told otherwise.',
              slug: SLUG,
              model: `mockllm/${SUB_MODEL}`,
              fork: false,
            },
          },
        ],
        stopReason: 'toolUse',
      },
      { text: '子任务已派发，后台运行中（RSWEEP-DISPATCHED）。', stopReason: 'stop' },
      { text: 'parent-idle', stopReason: 'stop' },
    ],
    [`mockllm/${SUB_MODEL}`]: [{ text: MEMBER_LONG_TEXT, stopReason: 'stop' }],
  }
}

/** 读文本文件（缺失/不可读返回空串）。 */
function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 主 session JSONL 定位：优先 config.sessions 摘要的 sessionFile；缺失时回退按文件名
 * 扫 <dataDir>/agent/sessions/**（pi 会话文件名 = <ISO>_<sessionId>.jsonl）。
 */
function findMainSessionFile(dataDir, sessionsReply, sid) {
  const summaries = (sessionsReply?.groups ?? []).flatMap((g) => g.sessions ?? [])
  const hit = summaries.find((s) => s?.id === sid)
  if (typeof hit?.sessionFile === 'string' && hit.sessionFile.length > 0) return hit.sessionFile
  const root = path.join(dataDir, 'agent', 'sessions')
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.endsWith('.jsonl') && e.name.includes(String(sid))) return full
    }
  }
  return ''
}

/**
 * 主 session JSONL 里指定 record id 的 pending 差集行（register / unregister）。
 * 解析形态对齐 session-pending.ts 的按值快速路径：只 parse 含目标字面量的行，
 * data={id, reason?, status?}，坏行跳过。返回最后一次出现的行（append-only 取尾）。
 */
function findPendingLine(sessionFile, kind, recordId) {
  const literal = kind === 'register' ? '"pending:register"' : '"pending:unregister"'
  let last = null
  for (const line of readTextFile(sessionFile).split('\n')) {
    if (!line.includes(literal)) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed?.customType !== (kind === 'register' ? 'pending:register' : 'pending:unregister')) continue
      if (parsed?.data?.id !== recordId) continue
      last = parsed
    } catch {
      /* 坏行跳过（append 中途截断形态，产品侧同款纪律） */
    }
  }
  return last
}

/**
 * 递归收集进程树后代 PID（pgrep -P 逐层展开，限深防失控）。
 * 只做 PID 收集，不匹配进程名——无宽泛语义。
 */
function collectDescendantPids(rootPid, maxDepth = 12) {
  const out = []
  const queue = [Number(rootPid)]
  for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
    const next = []
    for (const pid of queue) {
      const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 10_000 })
      if (r.status !== 0 || !r.stdout) continue
      for (const line of r.stdout.split('\n')) {
        const p = Number(line.trim())
        if (Number.isInteger(p) && p > 0 && !out.includes(p)) {
          out.push(p)
          next.push(p)
        }
      }
    }
    queue.length = 0
    queue.push(...next)
  }
  return out
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

/** 条件轮询（禁盲等：每轮重算判定，超时返回 null 由调用方出证据）。 */
async function pollUntil(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await sleep(intervalMs)
  }
  return null
}

/** record manifest 快照读取（ext-sessions/<sid>/subagents/records/<id>.json）。 */
function readRecordManifest(dataDir, sid, recordId) {
  const raw = readTextFile(path.join(dataDir, 'ext-sessions', String(sid), 'subagents', 'records', `${recordId}.json`))
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** record 事件文件路径（与 manifest 同主名：<sa-id>.events）。 */
function recordEventsFile(dataDir, sid, recordId) {
  return path.join(dataDir, 'ext-sessions', String(sid), 'subagents', 'records', `${recordId}.events`)
}

/**
 * 读取 record 事件文件里的失联轮收条帧（record-round-idle + 停因 interrupted-by-restart
 * + swept 附注）。事件文件 = JSONL（首行 header，坏行宽容跳过——与产品 parseRecordEventFileLine
 * 同纪律）。返回最后一次命中的帧（append-only 取尾）；无命中返回 null。
 */
function readSweepRoundIdleFrame(dataDir, sid, recordId) {
  let hit = null
  for (const line of readTextFile(recordEventsFile(dataDir, sid, recordId)).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.includes('"record-round-idle"')) continue
    let frame
    try {
      frame = JSON.parse(trimmed)
    } catch {
      continue // 截断行/坏行跳过（产品侧同款纪律）
    }
    const stopReason = frame?.stopReason ?? frame?.engineStopReason
    if (frame?.type === 'record-round-idle' && stopReason === 'interrupted-by-restart' && frame?.swept !== undefined) {
      hit = frame
    }
  }
  return hit
}

export const meta = {
  id: 'p0-restart-merge-sweep',
  priority: 'P0',
  title: '宿主重启合并清点：kill -9 → 轮收条补失联 + pending 结清 lost + 占用归零，无时间窗',
  covers: [
    'env.launch', 'env.ready', 'env.cleanup', 'env.isolation',
    'session.create', 'session.switch', 'session.persistence',
    'chat.send', 'chat.wait',
    'subagent.dispatch', 'subagent.list',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 300,
  llm: {
    responses: buildResponses(),
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
  },
  provable: [
    '造在途：record 出现且轮在途（running 且轮收条未写）+ manifest 快照 running + pending:register 在册 + mock 收到成员模型 200 请求',
    'kill -9 自建实例进程树（精确 PID：装配器 PID + pgrep -P 递归后代，逐个 SIGKILL）后 vite/cdp/runtime 端口全释放',
    '激活前三件磁盘事实（就绪后 ≤10s 同时成立）：manifest 快照 idle+interrupted-by-restart；record 事件文件 record-round-idle 帧（停因 interrupted-by-restart + swept={at,evidence}）；runtime 日志 startup sweep (records) 结果行',
    '激活后 wire 呈现：getSubagents 的 record.stopReason=interrupted-by-restart（runtime wire 按设计不含 lastRound.swept）',
    '清点命中记录从占用判据摘除：激活后 getSubagents 无「running 且轮收条未写」条目',
    'pending 债结清 lost：session.switch 触发 reattach 对账后主 session JSONL 出现该 id 的 pending:unregister 且 reason=lost',
    '无时间窗：激活前磁盘事实在就绪后 10s 内成立（启动一次性扫描）；结清与 wire 断言在 switch 后 45s 内成立（pi spawn 真实成本 + session_start 链内毫秒级对账）',
  ],
  notProvable: [
    'record 会话本体续聊可跑通（设计场景 3 的 resume 锚点重建引擎）——独立验收面，本剧本不派后续轮',
    'run 级中断收编（run-interrupted / interrupted run 收编）——本剧本只派 subagent record，不派 workflow run',
    '「孤儿引擎进程存活仍判失联」变体（本剧本整树 SIGKILL，无 pi 孤儿残留形态；swept.evidence 的 aliveWriter=dead 即本形态证据）',
    'wire lastRound.swept 不进 wire（events-projection-last-round.ts 设计裁决：失联标注经 record.stopReason 宿主中断族值呈现）——swept 硬断言取 record 事件帧（C），wire 面不断言 swept',
    'mock 回复无真实模型语义：编排质量、真实耗时与 token 成本',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    '装配器 spawn 的 concurrently 子树是独立进程组（dev-instance.mjs detached）——SIGKILL 装配器 PID 不波及子树，必须先 pgrep -P 递归收集后代再逐 PID SIGKILL；这正是宿主暴死（无优雅链）的模拟形态',
    '双实例并存的端口安全：自建实例用独立 name（端口按 name hash 派生独立段）+ 独立 data-dir；runner 主实例闲置不触碰（生命周期归 runner）',
    'pending:unregister 落盘形态（实装核实）：data.reason=lost 是结清枚举 SettlementReason 的权威词（sweep-binding lostSettlementOf 直通）；data.status 走历史六值映射通道 mapReasonToStatus，词表无 lost 键 → 如实落 unknown（fail-visible，REASON_STATUS_MAP 无该键 + sweep-binding.test 锚定）——本剧本断言 reason=lost 为准，status 值照录不断言为 lost',
    '激活前查询面语义（2026-10-24 a3/a3b 两轮实测）：未激活会话的 session.getSubagents 可读性取决于首次读取时点——a3 在就绪后立即轮询 10s 全空（首次读取早于 sweep 补写，投影缓存停在在途态，未激活期间无推送源刷新），a3b 先等磁盘事实成立（214ms）再首次查询即返回 idle+interrupted-by-restart（found=true）——疑为未激活投影缓存不随磁盘后续变化刷新的边缘形态（读通道未始终返回当前真值，激活后自愈）；故激活前清点证据一律走磁盘（manifest / 事件帧 / 日志），查询面断言与②同窗放 switch 之后，探测结果 attach 到 pre-activation-getsubagents-probe 供归因（不作断言）',
    'wire lastRound 不含 swept（设计裁决，events-projection-last-round.ts 头注「swept 附注不进 wire，失联标注经 record.stopReason 宿主中断族值呈现」）：swept 附注的硬断言位 = record 事件帧 `<sa-id>.events` 的 record-round-idle 帧，wire 面只断言 record.stopReason=interrupted-by-restart；lastRound.engineStopReason 对清点 record 同样缺省（sweep 补写帧只落迁移期展示位 stopReason）',
    '无时间窗的 N 值构成：激活前三件磁盘事实的 10s 覆盖「waitReady 三判据通过 → 启动段扫描完成」的观测余量（清点在 runtime 启动段、先于任何 pi spawn）；② 的 45s 覆盖 session.switch 触发 pi 进程重新 spawn 的启动成本（SKILL.md 给 30s 量级）+ session_start 链内毫秒级同步对账（reconcile-sweep.ts 头注）——产品侧无定时器/稳定窗/宽限窗（record-restart-sweep.ts / reconcile-sweep.ts 头注），N 是观测上限不是产品宽限窗',
    '同 worktree 双实例启动会各跑一遍幂等 preSteps（bundle-extensions 等）：产物目录共享但运行中实例不受影响（多数据目录实例共存是 dev 常态）',
  ]

  // runner 主实例（ctx.instance/ctx.protocol）刻意闲置：runner 负责其 launch/doctor/dispose，
  // 本剧本全部驱动发生在自建实例上。此处只做一次协议通道确认（主实例 auth 握手由 runner 断言）。
  ev.step({ step: 'main-instance.idle', channel: 'C', exitCode: 0, stats: { mainPid: ctx.instance?.pid ?? null, note: 'runner 主实例闲置，kill/重启对象为剧本自建实例' } })

  const uniq = `${Date.now().toString(36)}${process.pid.toString(36)}`
  const instanceName = `verify-rsweep-${uniq}`
  const selfDataDir = path.join(DEV_DATA_PARENT, `verify-rsweep-${uniq}`)
  const llmOptions = { responses: buildResponses(), tps: 10 }

  /** 实例 A（造在途 + 被杀）与实例 B（同 data-dir 重启）。 */
  let instanceA = null
  let instanceB = null
  let protoA = null
  let protoB = null

  /** 段间共享事实。 */
  let sid = ''
  let recordId = ''
  let sessionFile = ''

  try {
    // ══ 段 1：造在途（自建实例 A，mock-http） ════════════════════
    instanceA = createInstance({ repo, name: instanceName, dataDir: selfDataDir, llm: llmOptions, background: true })
    await instanceA.launch()
    const readyA = await instanceA.waitReady({ timeoutMs: 240_000 })
    protoA = await instanceA.protocol()
    ev.step({ step: 'A.launch.ready', channel: 'C', exitCode: 0, stats: { pid: instanceA.pid, dataDir: selfDataDir, readyMs: readyA.elapsedMs } })
    ev.assert('A: 自建实例就绪（三条判据）', readyA.ok === true, {
      channel: 'C',
      expected: 'runtime.port + cdp.page + extensions ≥8',
      actual: readyA.conditions.map((c) => `${c.name}:${c.ok ? 'ok' : 'fail'}`).join(' | '),
    })

    const created = await protoA.call('session.create', { cwd: repo, label: 'p0-restart-sweep' }, { timeoutMs: 120_000 })
    sid = created.session?.id ?? ''
    ev.assert('A: session.create 返回 sessionId', Boolean(sid), {
      channel: 'B',
      expected: 'session.id 非空',
      actual: JSON.stringify(created.session ?? {}).slice(0, 200),
    })
    await protoA.subscribe(sid)
    await protoA.send(sid, 'dispatch one subagent (p0-restart-merge-sweep 段 1)')

    // 在途态四条件（全部事实判据，条件轮询）：
    //   B 通道——record running 且轮收条未写；C 通道——成员模型 200 请求、manifest 快照
    //   running（清点候选枚举的直接判据）、pending:register 在册（结清断言前置）。
    const inflight = await pollUntil(async () => {
      let record = null
      try {
        const reply = await protoA.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 30_000 })
        record = (reply.subagents ?? []).find((r) => r.slug === SLUG) ?? null
      } catch {
        return null
      }
      if (!record || record.status !== 'running' || record.stopReason !== undefined) return null
      const subReq = (instanceA.mockLlm?.requests ?? []).some((r) => r.model === SUB_MODEL && r.status === 200)
      if (!subReq) return null
      const manifest = record.subagentId ? readRecordManifest(selfDataDir, sid, record.subagentId) : null
      const manifestStatus = manifest?.executionStatus ?? manifest?.status
      if (manifestStatus !== 'running') return null
      return record
    }, 120_000)
    if (!inflight) {
      let recordsSnapshot = []
      try {
        const reply = await protoA.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 30_000 })
        recordsSnapshot = reply.subagents ?? []
      } catch {
        recordsSnapshot = []
      }
      ev.attach('inflight-failure-context', JSON.stringify({
        records: recordsSnapshot,
        mockRequests: (instanceA.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })),
        mockPending: instanceA.mockLlm?.pending() ?? {},
        logTailA: instanceA.logTail(60),
      }, null, 2))
      uncovered.push('造在途失败：record/manifest/mock 请求四条件 120s 内未同时成立，kill 与重启段未执行（防在「非在途态」上误测清点）')
      return { uncovered, gotchas }
    }
    recordId = String(inflight.subagentId ?? '')
    const sessionsBefore = await protoA.call('config.sessions', {}, { timeoutMs: 60_000 })
    sessionFile = findMainSessionFile(selfDataDir, sessionsBefore, sid)
    const registerLine = sessionFile ? findPendingLine(sessionFile, 'register', recordId) : null
    ev.step({
      step: 'A.inflight.confirmed', channel: 'B', exitCode: 0,
      stats: { sid, recordId, status: inflight.status, stopReason: inflight.stopReason ?? '(未写)', sessionFile: sessionFile || '(未定位)' },
    })
    ev.assert('段 1 在途态：record running 且轮收条未写', Boolean(recordId) && inflight.status === 'running' && inflight.stopReason === undefined, {
      channel: 'B',
      expected: 'status=running 且 stopReason 缺失（轮收条未写 = 在途）',
      actual: `subagentId=${recordId} status=${inflight.status} stopReason=${inflight.stopReason ?? '(缺)'}`,
    })
    ev.assert('段 1 在途态：mock 收到成员模型 200 请求（孙进程真在途）', (instanceA.mockLlm?.requests ?? []).some((r) => r.model === SUB_MODEL && r.status === 200), {
      channel: 'C',
      expected: `≥1 条 model=${SUB_MODEL} status=200`,
      actual: JSON.stringify((instanceA.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status }))),
    })
    ev.assert('段 1 在途态：manifest 快照 executionStatus=running（清点候选枚举判据）', (() => {
      const m = readRecordManifest(selfDataDir, sid, recordId)
      return (m?.executionStatus ?? m?.status) === 'running'
    })(), {
      channel: 'C',
      expected: 'ext-sessions/<sid>/subagents/records/<id>.json executionStatus=running',
      actual: JSON.stringify(readRecordManifest(selfDataDir, sid, recordId))?.slice(0, 300) ?? '(文件缺失)',
    })
    ev.assert('段 1 在途态：pending:register 已在册（债权登记先于 kill）', Boolean(registerLine), {
      channel: 'C',
      expected: `主 session JSONL 含 pending:register 且 data.id=${recordId}`,
      actual: registerLine ? JSON.stringify(registerLine).slice(0, 240) : `sessionFile=${sessionFile || '(未定位)'}`,
    })
    ev.attach('inflight-record', JSON.stringify(inflight, null, 2).slice(0, 20_000))

    // ══ 段 2：kill -9 自建实例进程树（精确 PID） ═════════════════
    const pidA = instanceA.pid
    const descendants = collectDescendantPids(pidA)
    const killList = [Number(pidA), ...descendants]
    const killCmds = new Map(killList.map((p) => [p, cmdOf(p)]))
    for (const pid of killList) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (e) {
        if (e?.code !== 'ESRCH') throw e
      }
    }
    const portsA = [instanceA.info().vitePort, instanceA.info().cdpPort, instanceA.info().runtimePort].filter((p) => p > 0)
    const freed = await pollUntil(() => portsA.every((p) => portOwners(p).length === 0), 60_000, 400)
    if (!freed) {
      // 补刀仅限收集列表内的 PID（列表外 owner 只呈证据不盲杀——只杀自己实例的纪律）
      for (const p of portsA) {
        for (const owner of portOwners(p)) {
          if (killList.includes(Number(owner))) {
            try {
              process.kill(Number(owner), 'SIGKILL')
            } catch (e) {
              if (e?.code !== 'ESRCH') throw e
            }
          }
        }
      }
      await pollUntil(() => portsA.every((p) => portOwners(p).length === 0), 5_000, 400)
    }
    const stillBusy = portsA.flatMap((p) => portOwners(p).map((pid) => `:${p} → PID ${pid} (${cmdOf(pid).slice(0, 120)})`))
    ev.step({
      step: 'kill9.tree', channel: 'C', exitCode: stillBusy.length === 0 ? 0 : 1,
      stats: { pidA, treeSize: killList.length, descendants: descendants.length, ports: portsA, residual: stillBusy },
    })
    ev.assert('段 2 kill -9：装配器与整树逐 PID SIGKILL（精确 PID，无 pkill）', killList.length >= 2 && descendants.length >= 1, {
      channel: 'C',
      expected: `SIGKILL 对象 = 装配器 PID ${pidA} + pgrep -P 递归后代（宿主树至少含 concurrently/vite/electron 后代）`,
      actual: `killList=${killList.length} 个、后代=${descendants.length} 个`,
    })
    ev.assert('段 2 kill -9：自建实例 vite/cdp/runtime 端口全部释放', stillBusy.length === 0, {
      channel: 'C',
      expected: `端口 ${portsA.join(',')} 均无占用者`,
      actual: stillBusy.length === 0 ? '全部释放' : stillBusy.join(' ; '),
    })
    ev.attach('kill-tree-commands', [...killCmds.entries()].map(([p, cmd]) => `${p}\t${cmd.slice(0, 200)}`).join('\n'))

    // ══ 段 3：同 data-dir 重启（自建实例 B） ═════════════════════
    await protoA.close().catch(() => {})
    // A 已死：dispose 的 SIGTERM 命中 ESRCH 容忍；显式先关 A 的 mock server（防吊住进程），
    // dispose 内部的 stop 会再次 close（幂等 no-op）。
    await instanceA.mockLlm?.close().catch(() => {})
    await instanceA.dispose().catch(() => {})
    instanceB = createInstance({ repo, name: instanceName, dataDir: selfDataDir, llm: llmOptions, background: true })
    await instanceB.launch()
    const readyB = await instanceB.waitReady({ timeoutMs: 240_000 })
    const tReady0 = Date.now() // ④a 计时起点 = 就绪时刻（不含 launch/waitReady 自身耗时）
    ev.step({
      step: 'B.relaunch.ready', channel: 'C', exitCode: 0,
      stats: { pid: instanceB.pid, dataDir: selfDataDir, readyMs: readyB.elapsedMs, dataDirKept: fs.existsSync(selfDataDir) },
    })
    ev.assert('段 3 重启：同 data-dir 实例就绪（三条判据）', readyB.ok === true && instanceB.pid !== pidA, {
      channel: 'C',
      expected: '新 PID + runtime.port/cdp.page/extensions 三判据过',
      actual: `pid=${instanceB.pid}（旧 ${pidA}）| ${readyB.conditions.map((c) => `${c.name}:${c.ok ? 'ok' : 'fail'}`).join(' | ')}`,
    })
    protoB = await instanceB.protocol()

    // ══ 段 4：断言①（C 通道主证据）——就绪后（会话激活前）清点事实已落盘 ══
    // 观测面全部是磁盘/日志事实（不依赖会话激活）：manifest 快照、record 事件文件的
    // 失联轮收条帧、runtime 日志清点结果行。此段同时证明「清点是启动一次性扫描、
    // 不等会话激活」（无时间窗正面半边）。
    const diskSweepView = await pollUntil(() => {
      const manifest = readRecordManifest(selfDataDir, sid, recordId)
      const frame = readSweepRoundIdleFrame(selfDataDir, sid, recordId)
      const logLine = readRuntimeLogs(selfDataDir).split('\n').filter((l) => l.includes('[subagents] startup sweep (records):')).pop() ?? ''
      const manifestOk = manifest?.executionStatus === 'idle' && manifest?.stopReason === 'interrupted-by-restart'
      const logOk = /swept [1-9]\d* interrupted record/.test(logLine)
      if (!manifestOk || !frame || !logOk) return null
      return { manifest, frame, logLine, at: Date.now() }
    }, SWEEP_DEADLINE_MS)
    const elapsedSweep = diskSweepView ? diskSweepView.at - tReady0 : SWEEP_DEADLINE_MS
    const manifestAfter = diskSweepView?.manifest ?? readRecordManifest(selfDataDir, sid, recordId)
    const frameAfter = diskSweepView?.frame ?? readSweepRoundIdleFrame(selfDataDir, sid, recordId)
    const sweepLogLine = diskSweepView?.logLine ?? ''
    ev.step({
      step: 'sweep.disk.assert', channel: 'C', exitCode: diskSweepView ? 0 : 1,
      stats: {
        elapsedMs: elapsedSweep,
        manifest: manifestAfter ? { executionStatus: manifestAfter.executionStatus, stopReason: manifestAfter.stopReason } : null,
        frame: frameAfter ? { round: frameAfter.round, stopReason: frameAfter.stopReason, engineStopReason: frameAfter.engineStopReason ?? null, swept: frameAfter.swept } : null,
        logLine: sweepLogLine || null,
      },
    })
    ev.assert('①a 失联停因（C 位）：manifest 快照 idle + interrupted-by-restart', manifestAfter?.executionStatus === 'idle' && manifestAfter?.stopReason === 'interrupted-by-restart', {
      channel: 'C',
      expected: 'executionStatus=idle 且 stopReason=interrupted-by-restart',
      actual: manifestAfter ? JSON.stringify({ executionStatus: manifestAfter.executionStatus, stopReason: manifestAfter.stopReason }) : '(manifest 缺失)',
    })
    ev.assert('①b swept 附注（C 位）：record 事件文件轮收条帧带 swept={at,evidence}', Boolean(frameAfter?.swept) && typeof frameAfter?.swept?.at === 'number' && String(frameAfter?.swept?.evidence ?? '').includes('manifest='), {
      channel: 'C',
      expected: 'record-round-idle 帧 stopReason=interrupted-by-restart 且 swept={at:number,evidence 含 manifest=}',
      actual: frameAfter
        ? JSON.stringify({ type: frameAfter.type, stopReason: frameAfter.stopReason, engineStopReason: frameAfter.engineStopReason ?? null, swept: frameAfter.swept })
        : '事件文件无命中的 record-round-idle 帧',
    })
    ev.assert('①c 清点执行事实（C 位）：runtime 日志 startup sweep (records) 结果行 swept ≥1', /swept [1-9]\d* interrupted record/.test(sweepLogLine), {
      channel: 'C',
      expected: '「[subagents] startup sweep (records): swept N interrupted record(s)」且 N≥1',
      actual: sweepLogLine || '(无结果行——无命中时不落行)',
    })
    ev.assert('④a 无时间窗：激活前三件磁盘事实在就绪后立即成立（≤10s，启动一次性扫描）', Boolean(diskSweepView) && elapsedSweep <= SWEEP_DEADLINE_MS, {
      channel: 'C',
      expected: `就绪后 ≤${SWEEP_DEADLINE_MS / 1000}s 内 manifest + 事件帧 + 日志三事实同时成立（不依赖会话激活）`,
      actual: diskSweepView ? `elapsedMs=${elapsedSweep}` : `10s 内未同时成立（超时上限 ${SWEEP_DEADLINE_MS}ms）`,
    })
    ev.attach('manifest-after-sweep', JSON.stringify(manifestAfter ?? {}, null, 2))
    ev.attach('sweep-round-idle-frame', JSON.stringify(frameAfter ?? {}, null, 2))

    // 激活前查询面探测（观测证据，不作断言）：新代际里会话未激活时 getSubagents 的
    // 可读性形态——供「查询面语义 vs 产品缺口」归因（a3 实测为空）。
    let preActivationProbe = null
    try {
      const reply = await protoB.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 30_000 })
      preActivationProbe = {
        ok: true,
        found: reply.found ?? null,
        count: (reply.subagents ?? []).length,
        records: (reply.subagents ?? []).map((r) => ({ subagentId: r.subagentId, status: r.status, stopReason: r.stopReason ?? null })),
      }
    } catch (e) {
      preActivationProbe = { ok: false, error: String(e?.message ?? e).slice(0, 500) }
    }
    ev.step({ step: 'pre-activation.probe', channel: 'B', exitCode: preActivationProbe.ok ? 0 : 1, stats: preActivationProbe })
    ev.attach('pre-activation-getsubagents-probe', JSON.stringify(preActivationProbe, null, 2))

    // ══ 段 5：断言①②③（激活后 B/C 同窗）——reattach 对账 + 查询面呈现 ══
    // 同一窗口轮询两条事实：JSONL 的 lost 注销行（②C）+ getSubagents 的 wire 呈现
    // （①B：record.stopReason；③B：无在途占用）。后者的时点不承担「无时间窗」证明，
    // 那是段 4 磁盘事实的职责。
    const tSwitch = Date.now()
    let switched = false
    try {
      await protoB.call('session.switch', { sessionId: sid }, { timeoutMs: 60_000 })
      switched = true
    } catch (e) {
      ev.step({ step: 'session.switch', channel: 'B', exitCode: 1, stats: { error: e instanceof Error ? e.message : String(e) } })
    }
    let lastQueryError = ''
    const settledView = switched
      ? await pollUntil(async () => {
          const line = findPendingLine(sessionFile, 'unregister', recordId)
          const lostOk = line?.data?.reason === 'lost'
          let record = null
          try {
            const reply = await protoB.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 30_000 })
            record = (reply.subagents ?? []).find((r) => r.subagentId === recordId) ?? null
          } catch (e) {
            lastQueryError = String(e?.message ?? e).slice(0, 300)
            return null
          }
          const wireOk = record?.stopReason === 'interrupted-by-restart'
          const notOccupied = record !== null && !(record.status === 'running' && record.stopReason === undefined)
          if (lostOk && wireOk && notOccupied) return { record, line, at: Date.now() }
          return null
        }, SETTLE_DEADLINE_MS)
      : null
    const elapsedSettle = settledView ? settledView.at - tSwitch : SETTLE_DEADLINE_MS
    const lostLine = settledView?.line ?? (switched ? findPendingLine(sessionFile, 'unregister', recordId) : null)
    const recordAfter = settledView?.record ?? null
    ev.step({
      step: 'settle.assert', channel: 'B', exitCode: settledView ? 0 : 1,
      stats: {
        switched, elapsedMs: elapsedSettle,
        unregister: lostLine?.data ?? null,
        record: recordAfter ? { status: recordAfter.status, stopReason: recordAfter.stopReason ?? null, lastRound: recordAfter.lastRound ?? null } : null,
        lastQueryError: lastQueryError || null,
      },
    })
    ev.assert('①d 失联停因（B 位）：激活后 getSubagents 的 record.stopReason=interrupted-by-restart', recordAfter?.stopReason === 'interrupted-by-restart', {
      channel: 'B',
      expected: 'record.stopReason=interrupted-by-restart（runtime wire 呈现位；lastRound.swept 按设计不进 wire）',
      actual: recordAfter ? `stopReason=${recordAfter.stopReason ?? '(缺)'} lastRound=${JSON.stringify(recordAfter.lastRound ?? null)}` : (lastQueryError || 'switch 后 45s 内未查到该 record'),
    })
    ev.assert('③ 占用计数归零：清点命中记录从占用判据摘除（无 running 且轮收条未写的条目）', recordAfter !== null && !(recordAfter.status === 'running' && recordAfter.stopReason === undefined), {
      channel: 'B',
      expected: 'record 非「running 且 stopReason 缺失」（占用判据 isOccupied=false）',
      actual: recordAfter ? `status=${recordAfter.status} stopReason=${recordAfter.stopReason ?? '(缺)'}` : '未查到该 record',
    })
    ev.assert('② pending 结清 lost：reattach 对账落 pending:unregister 且 reason=lost', Boolean(lostLine) && lostLine?.data?.reason === 'lost', {
      channel: 'C',
      expected: `主 session JSONL 含 pending:unregister 且 data.id=${recordId}、data.reason=lost（status 如实照录）`,
      actual: lostLine
        ? JSON.stringify(lostLine.data)
        : `switch=${switched}，${SETTLE_DEADLINE_MS / 1000}s 内未见 lost 注销行（sessionFile=${sessionFile || '(未定位)'}）`,
    })
    ev.assert('④b 无时间窗：结清与 wire 呈现均在首次 reattach 后到位（≤45s，含 pi spawn 真实成本）', Boolean(settledView) && elapsedSettle <= SETTLE_DEADLINE_MS, {
      channel: 'B',
      expected: `switch 后 ≤${SETTLE_DEADLINE_MS / 1000}s 内②+①d+③同时成立（pi respawn 30s 量级 + 链内毫秒级对账，无重试窗）`,
      actual: settledView ? `elapsedMs=${elapsedSettle}` : `超时上限 ${SETTLE_DEADLINE_MS}ms${lastQueryError ? `；最近查询错误：${lastQueryError}` : ''}`,
    })
    ev.attach('record-after-sweep', JSON.stringify(recordAfter ?? {}, null, 2).slice(0, 20_000))
    ev.attach('unregister-line', JSON.stringify(lostLine ?? { note: '未出现' }, null, 2))

    // 终态快照：重启后 list 全量 + session 树幸存（record 会话本体保留）
    try {
      const finalReply = await protoB.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 30_000 })
      ev.attach('final-subagents', JSON.stringify(finalReply.subagents ?? [], null, 2).slice(0, 40_000))
      ev.assert('record 会话本体保留：subagents 树与 record 条目仍在（清点是簿记收编非删除）', fs.existsSync(path.join(selfDataDir, 'ext-sessions', String(sid), 'subagents')) && (finalReply.subagents ?? []).some((r) => r.subagentId === recordId), {
        channel: 'C',
        expected: 'ext-sessions/<sid>/subagents/ 树存在 + list 含该 recordId',
        actual: `tree=${fs.existsSync(path.join(selfDataDir, 'ext-sessions', String(sid), 'subagents'))} listHit=${(finalReply.subagents ?? []).some((r) => r.subagentId === recordId)}`,
      })
    } catch (e) {
      ev.attach('final-subagents-error', e instanceof Error ? e.message : String(e))
    }

    log(`done sid=${sid} recordId=${recordId} elapsedSweep=${elapsedSweep}ms elapsedSettle=${elapsedSettle}ms`)
    return { uncovered, gotchas }
  } finally {
    // 收尾：proto → 实例（B 优雅停；A 已死仅回收 mock server）→ 删自建 data-dir。
    await protoB?.close().catch(() => {})
    if (instanceB) await instanceB.dispose().catch((e) => log(`B dispose 异常：${e instanceof Error ? e.message : String(e)}`))
    if (instanceA) await instanceA.dispose().catch(() => {}) // 幂等兜底（正常路径已在段 3 前执行）
    try {
      if (path.basename(selfDataDir).startsWith('verify-')) fs.rmSync(selfDataDir, { recursive: true, force: true })
      ev.step({ step: 'selfDataDir.cleanup', channel: 'C', exitCode: fs.existsSync(selfDataDir) ? 1 : 0, stats: { dataDir: selfDataDir, gone: !fs.existsSync(selfDataDir) } })
    } catch (e) {
      log(`自建数据目录清理失败：${e instanceof Error ? e.message : String(e)}（目录 ${selfDataDir}）`)
    }
  }
}
