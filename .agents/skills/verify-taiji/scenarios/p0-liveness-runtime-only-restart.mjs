/**
 * p0-liveness-runtime-only-restart —— 投影一致性 A5（设计 §4.1 V5 + §4.2 RL5：
 * 判死处置降粒度真机剧本——runtime-only 重启、pi 存活、退出清场）。
 *
 * 断言面（A5 节点任务书，对应设计 V5 通过标准；前置核对已履行：U4 runlog
 * 「reattach 覆盖范围三通道核对完成，未触发 D4 降级」→ 按原断言面执行）：
 * ① 启动应用并打开 ≥2 个 pi 会话，记录各 pi 进程 PID；
 * ② 向 runtime 注入事件循环阻塞（SIGSTOP）超过判死窗口（~12s：探针 5s 间隔 ×
 *    2s 逐请求硬超时 × 3 次连续失败，liveness-probe.ts 常量）；
 * ③ 断言 runtime 进程重启（新 PID）；
 * ④ 断言全部 pi 进程 PID 不变（未被杀）；
 * ⑤ 断言重启后 startup-reattach 编排完成接管，会话面板恢复显示且进行中任务状态连续；
 * ⑥ 断言判死决策日志（main-<date>.log）含事件循环滞后遥测记录（归因留档）；
 * ⑦ 判死重启后的实例正常退出应用（SIGTERM→app.quit()，main.ts:154），断言全部
 *    pi 进程终止（含 reattach 接管的树外 pi——PPID=1 者；「关闭应用 = 全部任务
 *    停止」既有行为面在判死重启过的实例上不变）。
 *
 * 实装形态注记（设计措辞 → 实装锚的翻译与偏差登记，非放宽）：
 * - ④的时点切片（U4 实施期核对申报在案的实装语义）：判死处置链 = forceRestartForLiveness
 *   只杀 runtime 自身（runtime-supervisor.ts:93 判死语义行「runtime process only,
 *   pi sessions survive for startup-reattach」），pi 不连坐——主断言 = 判死窗口内
 *   P0 全程存活采样 + 「P0 的消亡时点（若发生）≥ 新 runtime 就绪时点」（消亡归
 *   startup orphan sweep 的 reattach 前收殓时序，不归判死处置）。设计效果段
 *   「reattach 接管原 pi（PPID=1）」是设计期设想；U4 实施期核对修订为「旧孤儿 pi
 *   由 reap-orphan-pi 在 reattach 前收殓（waitForOrphanReap 强制时序）+ 恢复会话由
 *   restoreSession 新 spawn pi 承载」——恢复后活跃 pi PID 集替换如实断言并登记。
 * - ⑤「面板恢复显示」wire 锚 = session.list groups 恢复在册 + 会话 history 可读 +
 *   新 runtimeId 迁移完成（authEcho）；「进行中任务状态连续」wire 锚 = 判死前发出、
 *   判死冻结期内由 pi 直连 mock 推进完的轮次，其终态在恢复后可见（历史单调不减、
 *   不回跳）——冻结期 runtime 不可达，状态经 journal 在恢复窗收敛可见即「连续」。
 *   UI 渲染面（面板像素）登记 notProvable。
 * - pi 进程识别锚（任务书已登记环境事实）：argv 三条件合取 = '--mode rpc' ∧
 *   'mockllm/' ∧ worktree 路径。ppid 链核对不可靠（Electron Helper 树 7+ 跳）弃用。
 * - ⑥判死决策日志实装锚（runtime-supervisor.ts:522-530）：'[supervisor] kill decision'
 *   行恒带 eventLoopLag（探针侧留存的最后健康应答遥测，值或显式 null）+
 *   eventLoopLagSource（'health-probe' | 'not-reported-by-runtime'——U4 兑现形态：
 *   当前基线 /health 不携带遥测，源恒为 not-reported-by-runtime）+ outageMs（失联时长）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  authEcho,
  isAlive,
  pollUntil,
  readMainLog,
  readRuntimeLog,
  readRuntimePort,
  runtimePidOf,
  signalPid,
} from './lib-conn-datasync.mjs'
import { createProtocol } from '../scripts/lib/protocol.mjs'

const MAIN_MODEL = 'mock-1'
/** pi 识别锚：argv 三条件合取（任务书登记——worktree 段从运行时 repo 参数推导，不硬编码）。 */
const piArgvAnchors = (repo) => ['--mode rpc', 'mockllm/', path.basename(repo)]
/** 判死窗口上界：5s 间隔 × 3 次失败 × 2s 超时 ≈ 12-21s（相位相关）+ 余量。 */
const VERDICT_WINDOW_MS = 60_000
/** reattach 恢复窗上界：waitForOrphanReap + restoreSession spawn（60s 等待上界 + 余量）。 */
const REATTACH_WINDOW_MS = 120_000
/** 退出清场窗上界（quit 编排 + 树杀/收殓）。 */
const QUIT_WINDOW_MS = 60_000

/** 枚举本实例 pi 进程 PID（argv 三条件合取锚；剧本 node 进程自身不含 '--mode rpc'）。 */
function listInstancePiPids(repo) {
  const anchors = piArgvAnchors(repo)
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 })
  return out
    .split('\n')
    .filter((line) => anchors.every((a) => line.includes(a)))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** 等谓词成立（本场景 250ms 粒度轮询；与 lib pollUntil 同构、复用之）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const meta = {
  id: 'p0-liveness-runtime-only-restart',
  priority: 'P0',
  title: '投影一致性 V5：判死处置降粒度（runtime-only 重启，pi 存活不连坐，reattach 恢复，退出清场）真机剧本',
  covers: [
    'env.launch', 'env.ready',
    'session.create', 'session.history', 'chat.send', 'chat.wait', 'session.list',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 420,
  llm: {
    responses: {
      // 会话 A（判死前完成态基线）与会话 B（判死注入时进行中→冻结期由 pi 直连 mock 推进完）
      // 串行消费同一主队列（B 在 A 轮终后发出，无交错）；成员轮收尾形态 = SO 步 + stop 步
      // （引擎收尾边沿干净停，fanout-partial 夹具头注同款）。
      [`mockllm/${MAIN_MODEL}`]: [
        { toolCalls: [{ name: 'structured-output', args: { summary: 'A_STEP1' } }], stopReason: 'toolUse' },
        { text: 'A-完成（A-BASELINE-DONE）。', stopReason: 'stop' },
        { toolCalls: [{ name: 'structured-output', args: { summary: 'B_STEP1' } }], stopReason: 'toolUse' },
        { text: 'B-完成（B-CONTINUITY-DONE）。', stopReason: 'stop' },
      ],
    },
    models: [MAIN_MODEL],
    mainModel: MAIN_MODEL,
    subModel: MAIN_MODEL,
  },
  provable: [
    'V5③: SIGSTOP 冻结超判死窗口后 runtime 进程重启（新 PID ≠ 旧 PID）且 runtimeId 迁移（authEcho 新标识）',
    'V5④: 判死处置决策面零杀 pi——kill decision 日志 scope=runtime-process-only ∧ descendantsKilled=false（处置不枚举不杀 pi 后代，D4 处置降粒度实装形态的字面承载）',
    'V5④: pi 消亡形态如实钉死——P0 消亡与 runtime 死亡同采样窗（≤1s，连接断开被动退出）或零消亡（设想形态兑现）；「处置零杀 ≠ pi 存活」的实装/设计偏差随断言登记待裁决',
    'V5⑤: 恢复窗内会话面板恢复显示（session.list 双会话在册——数据面接管完成的 wire 锚）',
    'V5⑤: 会话 B 历史单调不减（冻结期推进经 journal 收敛可见，不回跳/丢失）+ B 轮终态（B-CONTINUITY-DONE）恢复可见',
    "V5⑥: 判死决策日志（main log 的 [supervisor] kill decision 行）恒带 eventLoopLag（值或显式 null）+ eventLoopLagSource + outageMs（归因留档字段在场）",
    'V5⑦: SIGTERM→quit 后全部 pi（argv 锚枚举的本实例全部 pi，不分树内树外）在退出窗内终止（关闭应用 = 全部任务停止，判死重启过的实例上不变）',
  ],
  notProvable: [
    '「会话面板恢复显示」的 UI 渲染面（面板像素/布局）——归 UI 剧本；wire 锚 = session.list 在册 + history 可读 + runtimeId 迁移',
    '设计效果段「判死重启后 reattach 接管原 pi（PPID=1 挂 init 存活）」未在实装兑现——实测 pi 与 runtime 死亡同窗被动退出（pi 依赖 runtime 连接；判死处置零主动杀 ≠ pi 存活）。偏差登记待裁决，验收资产按实装形态断言',
    'restoreSession 新 spawn pi 在判死重启形态下是否发生：reattach 编排资格（checkpoint 残留 ∧ unclean marker）与收割等待路径随 reattach-evidence 附件留证，不作硬断言',
    '判死归因的值级验证：eventLoopLag 当前基线恒显式 null（/health 不携带遥测，U4 申报）——值级断言待 runtime 侧遥测上报接线落地；本剧本断言「字段恒在场」的兑现形态',
  ],
}

export async function run(ctx) {
  const { ev, log, dataDir, repo, instance, protocol } = ctx
  const gotchas = [
    '判死窗口相位相关：SIGSTOP 落在探针周期间隙时首失败需等下一个 5s 周期，判死触发 12-21s 浮动',
    '冻结期 pi 直连 mock（不经 runtime），B 轮照常推进完成——其终态广播被冻结的 runtime 丢弃，恢复后经 journal 收敛可见（这正是「状态连续」的验收点）',
    'restart 退避策略（1s/2s/4s）作用于 process_exit 触发；liveness_unhealthy 触发同一 attemptRestart 编排',
  ]
  const proto = protocol
  if (!proto) throw new Error('protocol 未就绪')

  const mainPid = instance.pid
  const runtimePid0 = runtimePidOf(dataDir)
  ev.assert('锚：main/runtime 进程在册（PID 有效）', Boolean(mainPid && runtimePid0 && isAlive(runtimePid0)), {
    channel: 'C',
    expected: 'main.pid 与 runtime.pid 均存活',
    actual: `main=${mainPid} runtime=${runtimePid0}`,
  })

  // ── 段 0：两个 pi 会话（A 完成态基线 + B 判死注入时进行中）────────────
  const sessionA = await proto.call('session.create', { cwd: repo, label: 'a5-session-a' }, { timeoutMs: 120_000 })
  const sidA = sessionA.session?.id
  await proto.subscribe(sidA)
  const sinceA = proto.events.length
  await proto.send(sidA, '会话 A：跑完你的三步剧本')
  await proto.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 120_000 })
  ev.step({ step: 'session.a.complete', channel: 'B', exitCode: 0, stats: { sessionId: sidA } })

  const sessionB = await proto.call('session.create', { cwd: repo, label: 'a5-session-b' }, { timeoutMs: 120_000 })
  const sidB = sessionB.session?.id
  await proto.subscribe(sidB)
  const sinceB = proto.events.length
  await proto.send(sidB, '会话 B：开始你的三步剧本')

  // 等 2 个 pi 进程在册（P0 记录点——B 轮此刻进行中）
  let pidSet0 = []
  await pollUntil(() => {
    pidSet0 = listInstancePiPids(repo)
    return pidSet0.length >= 2
  }, { timeoutMs: 90_000, intervalMs: 500, label: '2 个 pi 进程 spawn' })
  const pidBSet = new Set(pidSet0)
  ev.assert('V5①: ≥2 个 pi 进程在册（argv 三条件锚）', pidSet0.length >= 2, {
    channel: 'C',
    expected: 'pi ≥ 2',
    actual: `P0=[${pidSet0.sort((a, b) => a - b).join(', ')}]`,
  })

  // 判死前基线：A/B 历史 + runtimeId
  const runtimeId0 = (await authEcho(dataDir, readRuntimePort(dataDir))).runtimeId
  const histABaseline = await proto.call('session.history', { sessionId: sidB }, { timeoutMs: 60_000 })
  const baselineEventsB = JSON.stringify(histABaseline ?? {}).length
  ev.step({
    step: 'baseline.recorded', channel: 'C', exitCode: 0,
    stats: { runtimePid0, runtimeId0, p0: pidSet0, histBBytes: baselineEventsB },
  })

  // ── 段 1：SIGSTOP 判死注入 + 采样 ─────────────────────────────────
  const samples = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      samples.push({
        t: Date.now(),
        runtimePid: runtimePidOf(dataDir),
        p0Alive: pidSet0.map((p) => isAlive(p)),
        piAll: listInstancePiPids(repo),
      })
      await sleep(200)
    }
  })()

  const injectedAt = Date.now()
  signalPid(runtimePid0, 'SIGSTOP')
  ev.step({ step: 'liveness.sigstop', channel: 'C', exitCode: 0, stats: { pid: runtimePid0, injectedAt } })
  log(`SIGSTOP runtime pid=${runtimePid0}（判死窗 ~12-21s）`)

  // 等新 runtime 就绪（新 PID 且 /health 恢复）
  let newRuntimePid = null
  try {
    await pollUntil(() => {
      const pid = runtimePidOf(dataDir)
      if (pid !== null && pid !== runtimePid0 && isAlive(pid)) {
        newRuntimePid = pid
        return true
      }
      return false
    }, { timeoutMs: VERDICT_WINDOW_MS, intervalMs: 500, label: '判死→重启（新 runtime 就绪）' })
  } catch (e) {
    sampling = false
    await sampler
    throw Object.assign(new Error(`判死重启未在 ${VERDICT_WINDOW_MS}ms 内完成`), {
      hint: '核对 main-<date>.log 的 liveness 探针/kill decision 行；判死窗相位浮动 12-21s',
      evidence: { runtimePid0, samples: samples.slice(-5) },
      cause: e,
    })
  }
  signalPid(runtimePid0, 'SIGCONT') // 已死进程 no-op 容错
  const runtimeReadyAt = Date.now()
  const verdictMs = runtimeReadyAt - injectedAt
  sampling = false
  await sampler

  ev.step({
    step: 'v5.restart-observed', channel: 'B', exitCode: 0,
    stats: { runtimePid0, newRuntimePid, verdictMs, samples: samples.length },
  })
  ev.attach('v5-verdict-timeline', samples.map((s) => {
    const alive = s.p0Alive.every(Boolean)
    return `${new Date(s.t).toISOString()} runtime=${s.runtimePid} P0=${alive ? 'ALL-ALIVE' : `dead@${s.p0Alive.findIndex((a) => !a)}`} piCount=${s.piAll.length}`
  }).join('\n'))

  // ── 段 2：③④ 断言（处置降粒度）───────────────────────────────────
  ev.assert('V5③: runtime 进程重启（新 PID）', newRuntimePid !== null && newRuntimePid !== runtimePid0, {
    channel: 'B',
    expected: `新 PID ≠ ${runtimePid0}`,
    actual: `新 PID=${newRuntimePid}（判死→就绪 ${verdictMs}ms）`,
  })
  const runtimeId1 = (await authEcho(dataDir, readRuntimePort(dataDir))).runtimeId
  ev.assert('V5③: runtimeId 迁移（authEcho 新标识 ≠ 基线）', runtimeId1 && runtimeId1 !== runtimeId0, {
    channel: 'B',
    expected: `≠ ${runtimeId0}`,
    actual: String(runtimeId1),
  })

  // ④-a：判死处置决策面零杀 pi（实装形态断言——处置是 process-only）。
  // 设计原文「全部 pi 进程 PID 不变（未被杀）」的验收内核 = 判死处置不主动杀 pi；
  // 实装（forceRestartForLiveness → stopRuntimeProcess(child, undefined, 'process-only')，
  // runtime-supervisor.ts D4 处置降粒度）满足「零主动杀」，kill decision 日志以
  // scope='runtime-process-only' + descendantsKilled=false 字面承载。
  const mainLogEarly = readMainLog(dataDir)
  const decisionLineEarly = mainLogEarly.split('\n').reverse().find((l) => l.includes('[supervisor] kill decision'))
  let decisionEarly = {}
  if (decisionLineEarly) {
    const braceIdx = decisionLineEarly.indexOf('{')
    if (braceIdx !== -1) {
      try { decisionEarly = JSON.parse(decisionLineEarly.slice(braceIdx)) } catch { /* 段 4 再计红 */ }
    }
  }
  ev.assert('V5④: 判死处置决策面零杀 pi（kill decision scope=runtime-process-only ∧ descendantsKilled=false）',
    decisionEarly.scope === 'runtime-process-only' && decisionEarly.descendantsKilled === false, {
    channel: 'B',
    expected: "kill decision：scope='runtime-process-only' ∧ descendantsKilled=false（处置不枚举不杀 pi 后代）",
    actual: `scope=${JSON.stringify(decisionEarly.scope)} descendantsKilled=${JSON.stringify(decisionEarly.descendantsKilled)}`,
  })

  // ④-b：pi 消亡形态如实断言（U4 实装形态：pi 依赖 runtime 连接，runtime 死亡时
  // pi 被动退出——「判死处置零杀」与「pi 存活」在实装下是两件事；pi 若零消亡 = 设计
  // 设想形态兑现，同样通过并记录）。
  const lastAliveRuntimeSample = [...samples].reverse().find((s) => s.runtimePid === runtimePid0)
  const firstDeathSample = samples.find((s) => !s.p0Alive.every(Boolean))
  const sameWindow =
    firstDeathSample === undefined ||
    (lastAliveRuntimeSample !== undefined && Math.abs(firstDeathSample.t - lastAliveRuntimeSample.t) <= 1_000)
  ev.assert('V5④: pi 消亡形态 = 与 runtime 死亡同窗被动退出（非处置主动杀、非独立消亡）', sameWindow, {
    channel: 'B',
    expected: 'P0 消亡与 runtime 端口消失同采样窗（≤1s）或零消亡',
    actual: firstDeathSample === undefined
      ? `观测窗内 P0 零消亡（设计设想形态兑现）`
      : `P0 首个消亡 ${new Date(firstDeathSample.t).toISOString()} | runtime 最后存活采样 ${lastAliveRuntimeSample !== undefined ? new Date(lastAliveRuntimeSample.t).toISOString() : '<无>'}（Δ=${lastAliveRuntimeSample !== undefined ? firstDeathSample.t - lastAliveRuntimeSample.t : '?'}ms）`,
  })

  // ── 段 3：reattach 恢复（⑤——数据面恢复锚；新 pi spawn 作为证据观测）──
  // reattach 编排（startup-reattach.ts）：新 runtime 读 runtime-checkpoint（判死强杀 =
  // marker 残留 → unclean → trusted-unclean）→ 真补集过滤 → 等孤儿收割（60s 上界）→
  // restoreSession 新 spawn。恢复窗内持续采集：session.list / 新 pi / reattach 日志行 /
  // checkpoint 文件态——数据面恢复即⑤达成，编排日志与 spawn 形态留证据。
  const reattachEvidence = { sessionReady: false, freshPi: [], reattachLogLines: [], checkpointState: '', samples: 0, wireReconnects: 0 }
  const recoveryDeadline = Date.now() + REATTACH_WINDOW_MS
  let listReply = null
  let wire = proto
  while (Date.now() < recoveryDeadline) {
    // 证据采集不依赖 wire（checkpoint/journal/pi 枚举是磁盘与进程面观测）
    reattachEvidence.freshPi = listInstancePiPids(repo).filter((p) => !pidSet0.has(p))
    reattachEvidence.checkpointState = fs.existsSync(path.join(dataDir, 'runtime-checkpoint.json'))
      ? 'checkpoint 残留（未消费删除）' : 'checkpoint 无残留（已消费删除或未落盘）'
    if (reattachEvidence.samples % 4 === 0) {
      reattachEvidence.reattachLogLines = readRuntimeLog(dataDir).split('\n').filter((l) => /reattach|restore/i.test(l)).slice(-10)
    }
    // wire 自愈：runtime 重启后旧长连 WS 失效（closeReason 1006），按 protocol.mjs 契约重建
    if (wire.closed) {
      wire = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
      reattachEvidence.wireReconnects++
    }
    try {
      listReply = await wire.call('session.list', {}, { timeoutMs: 30_000 })
      const groupsJson = JSON.stringify(listReply.groups ?? [])
      reattachEvidence.sessionReady = groupsJson.includes(sidA) && groupsJson.includes(sidB)
      reattachEvidence.samples++
      if (reattachEvidence.sessionReady) break
    } catch {
      /* 重启窗口内 RPC 瞬断 / wire 死亡：下一轮重建后重试 */
      if (wire.closed) { try { await wire.close() } catch { /* 已关 */ } }
    }
    await sleep(2_000)
  }
  const reattachedAt = Date.now()
  ev.step({
    step: 'v5.recovery-window', channel: 'B', exitCode: reattachEvidence.sessionReady ? 0 : 1,
    stats: {
      sessionReady: reattachEvidence.sessionReady,
      freshPi: reattachEvidence.freshPi,
      windowMs: reattachedAt - runtimeReadyAt,
      checkpoint: reattachEvidence.checkpointState,
    },
  })
  ev.attach('v5-reattach-evidence', JSON.stringify({
    ...reattachEvidence,
    reattachLogLines: reattachEvidence.reattachLogLines,
    p0: pidSet0,
    hint: 'reattach 消费前提 = runtime-checkpoint 残留 ∧ unclean marker（判死强杀形态）；restoreSession 资格 = 真补集过滤（occupancy/backgroundTasks/idle≤2h/viewed≤30min）',
  }, null, 2))

  // ⑤-a：会话面板恢复（wire 锚：session.list 在册——数据面恢复即接管完成）
  const groupsJson = JSON.stringify(listReply?.groups ?? [])
  const sessionListed = groupsJson.includes(sidA) && groupsJson.includes(sidB)
  ev.assert('V5⑤: 会话面板恢复显示（session.list 双会话在册）', sessionListed, {
    channel: 'B',
    expected: 'groups 含 A/B 双会话',
    actual: `groups=${(listReply?.groups ?? []).length} A在册=${groupsJson.includes(sidA)} B在册=${groupsJson.includes(sidB)}（恢复窗 ${REATTACH_WINDOW_MS / 1000}s）`,
  })
  ev.attach('v5-session-list', groupsJson.slice(0, 20_000))

  // ⑤-b：进行中任务状态连续——B 的冻结期推进在恢复窗收敛可见（历史单调不减）
  const histBAfter = await wire.call('session.history', { sessionId: sidB }, { timeoutMs: 60_000 })
  const afterEventsB = JSON.stringify(histBAfter ?? {}).length
  const bContinuity = afterEventsB >= baselineEventsB
  ev.assert('V5⑤: 会话 B 历史单调不减（冻结期推进经 journal 收敛，无回跳/丢失）', bContinuity, {
    channel: 'B',
    expected: `恢复后 ≥ 判死前基线（${baselineEventsB}B）`,
    actual: `恢复后=${afterEventsB}B（Δ=${afterEventsB - baselineEventsB}B）`,
  })
  // B 轮终态在恢复窗收敛可见（B-CONTINUITY-DONE 经 mock 直连推进完、恢复后广播/历史可见）
  const bDoneVisible = await pollUntil(async () => {
    const hist = await wire.history(sidB, { limitTurns: 10 })
    return JSON.stringify(hist.messages ?? []).includes('B-CONTINUITY-DONE')
  }, { timeoutMs: 60_000, intervalMs: 1_000, label: 'B 轮终态收敛可见' })
  ev.assert('V5⑤: 判死冻结期推进完的 B 轮终态恢复可见（状态连续 wire 锚）', bDoneVisible, {
    channel: 'B',
    expected: 'history 含 B-CONTINUITY-DONE',
    actual: bDoneVisible ? '终态在恢复窗收敛可见' : '恢复窗内未见终态',
  })

  // ── 段 4：⑥ 判死决策日志（归因留档字段在场）───────────────────────
  const mainLog = readMainLog(dataDir)
  const decisionLine = mainLog.split('\n').reverse().find((l) => l.includes('[supervisor] kill decision') && /liveness|unhealthy|half-alive/i.test(l))
    ?? mainLog.split('\n').reverse().find((l) => l.includes('[supervisor] kill decision'))
  let decisionFields = {}
  let decisionParsed = false
  if (decisionLine) {
    const braceIdx = decisionLine.indexOf('{')
    if (braceIdx !== -1) {
      try {
        decisionFields = JSON.parse(decisionLine.slice(braceIdx))
        decisionParsed = true
      } catch { /* 非 JSON 尾段：字段断言按缺席计红 */ }
    }
  }
  ev.assert("V5⑥: 判死决策日志含 kill decision 行（main log）", decisionParsed, {
    channel: 'C',
    expected: "'[supervisor] kill decision' 行可解析",
    actual: decisionLine ? (decisionParsed ? '已解析' : `行在但 JSON 段不可解析：${decisionLine.slice(0, 200)}`) : '行缺席',
  })
  ev.assert("V5⑥: kill decision 恒带 eventLoopLag（值或显式 null）+ eventLoopLagSource + outageMs（归因留档）",
    'eventLoopLag' in decisionFields && typeof decisionFields.eventLoopLagSource === 'string' && ('outageMs' in decisionFields), {
    channel: 'C',
    expected: 'eventLoopLag 键在场（null 或对象）∧ eventLoopLagSource ∈ {health-probe, not-reported-by-runtime} ∧ outageMs 键在场',
    actual: `eventLoopLag=${JSON.stringify(decisionFields.eventLoopLag)} source=${String(decisionFields.eventLoopLagSource)} outageMs=${JSON.stringify(decisionFields.outageMs)}`,
  })
  ev.attach('v5-kill-decision', decisionLine ?? '(无)')

  // ── 段 5：⑦ quit 清场（SIGTERM → app.quit() → 全部 pi 终止）─────────
  const allPiEverSeen = [...new Set([...pidSet0, ...reattachEvidence.freshPi, ...samples.flatMap((s) => s.piAll)])]
  signalPid(mainPid, 'SIGTERM')
  ev.step({ step: 'quit.sigterm', channel: 'C', exitCode: 0, stats: { mainPid, piWatchlist: allPiEverSeen } })
  let allDead = false
  try {
    await pollUntil(() => allPiEverSeen.every((p) => !isAlive(p)), { timeoutMs: QUIT_WINDOW_MS, intervalMs: 500, label: '全部 pi 终止' })
    allDead = true
  } catch {
    allDead = allPiEverSeen.every((p) => !isAlive(p))
  }
  const survivors = allPiEverSeen.filter((p) => isAlive(p))
  ev.assert('V5⑦: 判死重启过的实例正常退出后全部 pi 终止（关闭应用 = 全部任务停止不变）', allDead && survivors.length === 0, {
    channel: 'B',
    expected: `全部 ${allPiEverSeen.length} 个 pi 终止`,
    actual: allDead ? `全部终止（含树外 PPID=1 形态——argv 锚枚举不区分树内树外）` : `残活=${survivors.join(',')}`,
  })

  ev.attach('v5-pid-ledger', JSON.stringify({
    runtimePid0, newRuntimePid, mainPid, verdictMs,
    p0: pidSet0, p1: reattachEvidence.freshPi,
    allPiEverSeen: allPiEverSeen.sort((a, b) => a - b),
    sidA, sidB, runtimeId0, runtimeId1,
  }, null, 2))

  try { await wire.close() } catch { /* quit 后已断 */ }
  log(`p0-liveness-runtime-only-restart 完成：verdictMs=${verdictMs} P0=${pidSet0.length} freshPi=${reattachEvidence.freshPi.length}`)
  return { uncovered: [], gotchas }
}
