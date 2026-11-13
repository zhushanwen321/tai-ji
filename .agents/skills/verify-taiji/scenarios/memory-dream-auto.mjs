/**
 * memory-dream-auto —— 记忆扩展（@zhushanwen/pi-memory）Dream 整合自动触发真机验收
 * （设计 memory-system §4 V9 + V11 / 验收清单 A9；U7 dream/scheduler + runner，设计 D7，
 * 守护 RL9/RL11/AS5）。
 *
 * 场景（V9 步骤原文）：改该项目 last-integrated 为 25h 前 → 启动会话 → agent_settled
 * 空闲窗口 → Dream 自动执行；执行中用户输入到达即中止让位（下一空闲再续）；跨项目
 * 素材隔离（V11：项目 A 触发 Dream 时项目 B 的新会话不被消费）。
 *
 * ── 触发链与实测时序（dream/scheduler.ts + 2026-11-13 探针实测）──
 *
 *   session_start：间隔门槛（last-integrated ≥ 24h）＋ 游标 pending 素材 → 入队
 *   agent_settled：空闲窗口执行——触发点 = 首条消息回合结束的 settled（pi
 *     _emitAgentSettled 在 agent run 的 finally；启动空转不触发，mem-d1/d2 两轮实测：
 *     不发消息 Dream 永不入队执行、发一条 'ok' 后 settled 立即执行）。V9 步骤②
 *     「产生一轮对话后停止输入」正对应此时序。
 *   turn_start：执行中用户输入 → abort 让位（RL9），入队标记保留 → 下一空闲再续。
 *
 * ── LLM 通道：mock-http（meta.llm，tps=20 → 12.5ms/char）──
 *
 * Dream 的 complete 调用（dream/runner.ts → ctx.modelRegistry.complete）继承触发会话
 * 模型 → 与回合回复共用 mockllm/mock-main per-model 单游标。
 *
 * 零回合提炼编排：taiji 给每条用户消息追加 `<!--taiji:msg:<uuid>-->` 注释尾巴（+1 个
 * 拉丁计词段）——正文 1 词（如 "ok"）+ 尾巴 = 2 词 < 3（跳过门 USER_TEXT_MIN_WORDS），
 * 正文 ≥2 词即触发回合提炼与 Dream 竞争队列。故全部对话正文一律 1 词；素材哨兵放在
 * mock 回复文本（assistant 消息同样进 Dream 素材，serializeSessionMessage 保留 text）。
 *
 * 队列步序（消费序确定）：
 *   step0 会话A1 回合（回复文本含项目 A 哨兵 DREAM-FACT；正文 'ok' 零提炼）
 *   step1 会话B 回合（回复文本含项目 B 哨兵 PROJB；正文 'ok' 零提炼）
 *   step2 触发会话首轮回合（'ok'——settled 触发 Dream#1 的前置）
 *   step3 Dream#1 整合步（慢步 ~700 chars @tps20 ≈ 8.8s 在途窗口；add 操作集，
 *        Why:/How to apply: 行首标签过 write-gate 四校验）
 *   step4 触发会话次轮回合（'ok'——turn_start 在提交瞬间已 abort Dream#1）
 *   step5 Dream#2 整合步（abort 后下一空闲再续，同形操作集）
 *   尾部 +3 备用 skip 步
 *
 * ── fixture 构造（磁盘权威，AX1：扩展从磁盘重建状态）──
 *
 * 会话 A1（cwd=repo）与会话 B（cwd=<dataDir>/project-b，非 git 目录 → 独立 slug）各产
 * 一轮对话后，手写 ingest-cursor.jsonl 登记两行 pending（sessionFile=真实会话 JSONL、
 * projectSlug=engine/paths.ts deriveProjectSlug 复刻推导；已有行按 sessionFile 幂等键
 * 查重吸收）；再写项目 A last-integrated = 25h 前（projects/<slugA>/integration-state.json）。
 * fixture 全在 dataDir 内随 dispose 删除。
 *
 * Cleanup 由 runner 承载；本剧本零自持进程。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { realpathSync } from 'node:fs'

// ── 常量 ──────────────────────────────────────────────────────────────────────
const MAIN_MODEL = 'mock-main'
const PROVIDER = 'mockllm'

/** 项目 A（本 repo）素材哨兵（埋在 A1 回复文本——assistant 消息进 Dream 素材）。 */
const DREAM_FACT = 'DREAM-FACT-9917'
/** 项目 B 素材哨兵——Dream 载荷与产物必不含（V11 摄取隔离探针）。 */
const PROJB_FACT = 'PROJB-4477'
/** Dream 落盘条目 name（mock 整合步返回的 add 操作集指定）。 */
const DREAM_ENTRY = 'dream-merged-fact'
/** Dream 整合 systemPrompt 首句特征（extract/prompt.ts buildDreamIntegrationPrompt）。 */
const INTEGRATOR_MARK = '你是记忆库整合器'

const TURN_BUDGET_MS = 60_000
const DREAM_SETTLE_MS = 120_000

// ── deriveProjectSlug 复刻（extensions/universal/memory/src/engine/paths.ts 词法照抄）──

function slugLabel(dirName) {
  const normalized = dirName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 32)
    .replaceAll(/-+$/g, '')
  return normalized || 'project'
}

function deriveProjectSlug(cwd) {
  let commonDir = null
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) commonDir = path.resolve(cwd, out)
  } catch {
    commonDir = null
  }
  const stableKey = (target) => {
    try {
      return realpathSync(target)
    } catch {
      return target
    }
  }
  const hashKey = commonDir ? stableKey(commonDir) : stableKey(path.resolve(cwd))
  const labelSource = commonDir ? path.basename(path.dirname(commonDir)) : path.basename(path.resolve(cwd))
  const hash = createHash('sha256').update(hashKey).digest('hex').slice(0, 8)
  return `${slugLabel(labelSource)}-${hash}`
}

// ── mock 演员 ─────────────────────────────────────────────────────────────────

/**
 * Dream 整合步文本：add 操作集（project 类型——Why:/How to apply: 各占一行、行首标签，
 * 过 write-gate 四校验之④）；content 填充拉长到 ~700 chars 承载在途窗口（8.8s @tps20，
 * 上限须留足 networkTimeoutMs=15s 之内的余量）。
 */
function dreamStep() {
  const op = `{"operations":[{"op":"add","name":"${DREAM_ENTRY}","description":"Dream 整合产出的跨会话项目事实","type":"project","content":"跨会话素材整合：项目记录口径包含事实码 ${DREAM_FACT}（游标后新会话素材明确给出）。\\n素材审视备注：${'跨会话证据链完整，逐段核对无冲突。'.repeat(14)}\\nWhy: 游标后新会话素材明确给出该口径，值得跨会话保留。\\nHow to apply: 后续会话涉及该口径时以此条为准。"}]}`
  return { text: op, stopReason: 'stop' }
}

const SKIP_STEP = { text: '{"operations":[{"op":"skip","reason":"mock 演员编排的跳过步"}]}', stopReason: 'stop' }

/** mock-main 队列（步序语义见文件头注释）。 */
const mainQueue = [
  { text: `ack-a1 已记录项目 A 素材：长期口径包含事实码 ${DREAM_FACT}。`, stopReason: 'stop' }, // step0
  { text: `ack-b 已记录项目 B 素材：本目录口径包含标记 ${PROJB_FACT}。`, stopReason: 'stop' }, // step1
  { text: 'ack-2a 触发会话首轮回复', stopReason: 'stop' }, // step2
  dreamStep(), // step3 Dream#1（首轮 settled 触发）
  { text: 'ack-2b 让位后的次轮回复（用户回合不被阻塞）', stopReason: 'stop' }, // step4
  dreamStep(), // step5 Dream#2（下一空闲再续）
  SKIP_STEP, // 备用
  SKIP_STEP, // 备用
  SKIP_STEP, // 备用
]

export const meta = {
  id: 'memory-dream-auto',
  priority: 'P1',
  title: '记忆扩展 Dream 整合 V9+V11：间隔门槛自动触发 / 空闲执行 / 用户输入让位再续 / 跨项目摄取隔离',
  covers: ['session.create', 'chat.send', 'chat.wait', 'protocol.rpc', 'protocol.events'],
  requires: ['mock-http'],
  estimateSec: 420,
  env: { TAIJI_AGENT_DEBUG: '1' },
  llm: {
    mainModel: MAIN_MODEL,
    models: [MAIN_MODEL],
    responses: { [`${PROVIDER}/${MAIN_MODEL}`]: mainQueue },
    tps: 20,
  },
  provable: [
    'session_start 间隔门槛：last-integrated 25h 前 + 游标有素材 → 入队（日志 queued=true）',
    '空闲窗口自动执行整合（backups/<ts> 快照目录出现 + Dream 整合请求真实发生——system 含「你是记忆库整合器」）',
    '整合期间用户输入：让位日志（user input during integration; yielding）+ 用户回合不被阻塞（message.complete）',
    '让位后再续：第二次整合完成（last-integrated 更新为当前、项目 A 游标 consumedAt 非 null、origin: dream 条目落盘）',
    '整合前快照保留（backups 目录非空）；整合期间项目锁在盘、完成后释放',
    '跨会话素材被消费：Dream 模型调用载荷含项目 A 会话素材哨兵（V9 通过标准）',
    'V11 摄取隔离：项目 B 游标行不被消费（consumedAt 仍 null）+ Dream 载荷不含项目 B 哨兵 + 项目 B 记忆目录无新条目',
  ],
  notProvable: [
    '真实模型智能下的整合质量（mock 整合步由剧本编排返回固定操作集）',
    'session_shutdown 真实登记路径（taiji runtime 会话销毁策略下的触发形态）——素材登记经游标文件磁盘权威手写构造，不依赖 shutdown 语义',
    'lock-busy（他进程持锁）与 backup-failed 分支——需第二进程持锁/磁盘故障注入，本剧本单实例内不构造',
    '整合期间 smart-context 后台压缩同窗并发（V9 可选扩步骤）——本装配上下文量级远低于压缩阈值',
  ],
}

// ── 剧本 helper ───────────────────────────────────────────────────────────────

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 条件等待 mock server 收到指定模型的第 N 个 200 请求。 */
async function waitMockRequests(instance, model, count, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const hits = (instance.mockLlm?.requests ?? []).filter(
      (r) => r.status === 200 && (r.model === model || r.model?.endsWith(`/${model}`)),
    )
    if (hits.length >= count) return hits
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `等待 mock 请求超时（${label}）：model=${model} 期望 ≥${count}，实际 ${hits.length}；` +
          `全部请求=${JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })))}`,
      )
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 请求体全文（system + 各 role content 抽平；openai-completions 把 systemPrompt 转 messages[0]）。 */
function requestFullText(request) {
  return (request?.messages ?? [])
    .map((m) => {
      if (typeof m?.content === 'string') return m.content
      if (Array.isArray(m?.content)) return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      return ''
    })
    .join('\n')
}

/** 定位 session JSONL（pi 文件名 = <ts>_<sessionId>.jsonl，按 sessionId 递归匹配）。 */
function findSessionJsonl(dataDir, sessionId) {
  const root = path.join(dataDir, 'agent', 'sessions')
  if (!fs.existsSync(root)) return null
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    const hit = names.find((n) => n.endsWith('.jsonl') && n.includes(sessionId))
    if (hit) return path.join(dir, hit)
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full)
      } catch {
        /* 竞态删除跳过 */
      }
    }
  }
  return null
}

/** 手写游标登记（磁盘权威；幂等键 = sessionFile 绝对路径）。 */
function registerCursorFixture(agentDir, sessionFile, projectSlug) {
  const cursorFile = path.join(agentDir, 'memory', 'ingest-cursor.jsonl')
  const existing = readText(cursorFile)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  if (existing.some((r) => r.sessionFile === sessionFile)) return { cursorFile, appended: false, total: existing.length }
  const record = { sessionFile, projectSlug, registeredAt: new Date().toISOString(), consumedAt: null }
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true })
  fs.appendFileSync(cursorFile, `${JSON.stringify(record)}\n`, 'utf8')
  return { cursorFile, appended: true, total: existing.length + 1 }
}

/** 读游标全部行。 */
function readCursorRecords(agentDir) {
  return readText(path.join(agentDir, 'memory', 'ingest-cursor.jsonl'))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 读 memory 扩展日志。 */
function readMemoryLog(dataDir) {
  const dir = path.join(dataDir, 'agent', 'logs')
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('memory-') && f.endsWith('.log'))
    .map((f) => readText(path.join(dir, f)))
    .join('\n')
}

/** 条件轮询谓词为真。 */
async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`条件等待超时（${label}）`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── 剧本主体 ─────────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'taiji 给每条用户消息追加 <!--taiji:msg:<uuid>--> 注释尾巴（+1 个拉丁计词段）——正文 1 词 + 尾巴 = 2 词才低于跳过门 3 词线；正文 ≥2 词必触发回合提炼与 Dream 竞争 mock 队列（探针实测）',
    'Dream 的 settled 触发点 = 首条消息回合结束（pi _emitAgentSettled 在 agent run finally）——启动空转不触发（mem-d2 实测：不发消息 Dream 永不执行）；V9 步骤②「一轮对话后停止输入」正对应此时序',
    'Dream complete 继承触发会话模型——与回合共用 mock-main 单游标；Dream 步是慢步（tps 节流），在途窗口 ~8.8s 须小于 networkTimeoutMs=15s',
    'project 类型条目正文须含行首 Why: 与 How to apply: 行（write-gate 四校验之④）——mock 操作集的 content 换行转义（\\n）且标签各占一行',
    '游标 fixture 手写按幂等键（sessionFile 绝对路径）查重；slug 由 engine/paths.ts deriveProjectSlug 复刻推导（git commondir realpath 哈希）',
  ]

  const agentDir = path.join(dataDir, 'agent')
  const slugA = deriveProjectSlug(repo)
  const projectBDir = path.join(dataDir, 'project-b')
  fs.mkdirSync(projectBDir, { recursive: true })
  const slugB = deriveProjectSlug(projectBDir)
  ev.assert('装配：项目 A/B slug 隔离（git 仓 vs 非 git 目录）', slugA !== slugB, {
    channel: 'C',
    expected: 'slugA ≠ slugB',
    actual: `slugA=${slugA} slugB=${slugB}`,
  })
  ev.step({ step: 'assemble.slugs', channel: 'C', exitCode: 0, stats: { slugA, slugB } })

  // ── 素材会话：项目 A（repo）与项目 B（dataDir/project-b）各一轮对话 ──────────
  // 正文一律 'ok'（1 词 + 尾巴 = 2 词 → 跳过门拦下零提炼）；哨兵埋 mock 回复文本。
  const createdA1 = await protocol.call('session.create', { cwd: repo, label: 'dream-a1' }, { timeoutMs: 120_000 })
  const sidA1 = createdA1.session?.id
  ev.assert('A1: 项目 A 素材会话创建', Boolean(sidA1), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(createdA1.session ?? {}).slice(0, 200),
  })
  await protocol.subscribe(sidA1)
  let since = protocol.events.length
  await protocol.send(sidA1, 'ok')
  let end = await protocol.waitTurnEnd(sidA1, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('A1: 项目 A 素材回合完成', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  await waitMockRequests(instance, MAIN_MODEL, 1, 30_000, 'A1 回合')
  ev.step({ step: 'chat.materialA', channel: 'B', exitCode: 0, stats: { sessionId: sidA1 } })

  const createdB = await protocol.call('session.create', { cwd: projectBDir, label: 'dream-b' }, { timeoutMs: 120_000 })
  const sidB = createdB.session?.id
  ev.assert('B1: 项目 B 会话创建（cwd=project-b 非 git 目录）', Boolean(sidB), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(createdB.session ?? {}).slice(0, 200),
  })
  await protocol.subscribe(sidB)
  since = protocol.events.length
  await protocol.send(sidB, 'ok')
  end = await protocol.waitTurnEnd(sidB, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('B1: 项目 B 素材回合完成', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  await waitMockRequests(instance, MAIN_MODEL, 2, 30_000, 'B 回合')
  ev.step({ step: 'chat.materialB', channel: 'B', exitCode: 0, stats: { sessionId: sidB } })

  // ── fixture：游标登记（V11：两项目各一行 pending）+ last-integrated 25h 前 ──
  const jsonlA1 = findSessionJsonl(dataDir, sidA1)
  const jsonlB = findSessionJsonl(dataDir, sidB)
  ev.assert('F1: 两素材会话 JSONL 定位成功', Boolean(jsonlA1) && Boolean(jsonlB), {
    channel: 'C',
    expected: 'A1 与 B 的 session JSONL 在盘',
    actual: `A1=${jsonlA1 ?? '<缺>'} B=${jsonlB ?? '<缺>'}`,
  })
  if (jsonlA1) registerCursorFixture(agentDir, jsonlA1, slugA)
  if (jsonlB) registerCursorFixture(agentDir, jsonlB, slugB)
  const recordsAfterFixture = readCursorRecords(agentDir)
  ev.assert('F2: 游标 fixture 登记（项目 A/B 各一行 pending）', recordsAfterFixture.some((r) => r.projectSlug === slugA && r.consumedAt === null) && recordsAfterFixture.some((r) => r.projectSlug === slugB && r.consumedAt === null), {
    channel: 'C',
    expected: `pending 行含 slugA=${slugA} 与 slugB=${slugB}`,
    actual: JSON.stringify(recordsAfterFixture.map((r) => ({ slug: r.projectSlug, consumedAt: r.consumedAt }))),
  })
  // last-integrated = 25h 前（V9 步骤①）
  const staleIso = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString()
  const scopeDirA = path.join(agentDir, 'memory', 'projects', slugA)
  fs.mkdirSync(scopeDirA, { recursive: true })
  fs.writeFileSync(path.join(scopeDirA, 'integration-state.json'), `${JSON.stringify({ 'last-integrated': staleIso }, null, 2)}\n`, 'utf8')
  ev.assert('F3: 项目 A last-integrated 写为 25h 前', JSON.parse(readText(path.join(scopeDirA, 'integration-state.json')) ?? '{}')['last-integrated'] === staleIso, {
    channel: 'C',
    expected: staleIso,
    actual: readText(path.join(scopeDirA, 'integration-state.json')).slice(0, 120),
  })
  ev.step({ step: 'fixture.cursor', channel: 'C', exitCode: 0, stats: { rows: recordsAfterFixture.length, staleIso } })

  // ── 触发会话：项目 A 新会话（session_start 门槛入队 → 首轮 settled → Dream#1）──
  const createdA2 = await protocol.call('session.create', { cwd: repo, label: 'dream-trigger' }, { timeoutMs: 120_000 })
  const sidA2 = createdA2.session?.id
  ev.assert('T1: 触发会话创建', Boolean(sidA2), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(createdA2.session ?? {}).slice(0, 200),
  })
  await protocol.subscribe(sidA2)
  // 等 A2 的 gate 行（queued=true）：A1/B 会话的 gate 行（queued=false）先在盘
  try {
    await waitUntil(
      () => readMemoryLog(dataDir).split('\n').some((l) => l.includes('dream: session_start gate checked') && /"queued":\s*true/.test(l)),
      30_000,
      'A2 session_start gate 入队日志',
    )
  } catch {
    /* 日志未出现由 G1 断言暴露 */
  }
  const gateLine = readMemoryLog(dataDir)
    .split('\n')
    .filter((l) => l.includes('dream: session_start gate checked'))
    .reverse()
    .find((l) => /"queued":\s*true/.test(l)) ?? ''
  ev.assert('G1: session_start 间隔门槛入队（25h 前 + 有素材 → queued=true）', gateLine !== '', {
    channel: 'C',
    expected: 'gate 日志 queued=true（due=true, hasMaterial=true）',
    actual: gateLine.slice(0, 300) || '(queued=true 的 gate 日志未出现)',
  })
  ev.attach('gate-log-line', gateLine)

  // V9 步骤②：产生一轮对话后停止输入——首轮回合的 settled 即 Dream#1 空闲窗口
  since = protocol.events.length
  await protocol.send(sidA2, 'ok')
  end = await protocol.waitTurnEnd(sidA2, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('T2: 触发会话首轮完成（settled 触发前置）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  await waitMockRequests(instance, MAIN_MODEL, 3, 60_000, '触发会话首轮')

  // Dream#1 整合请求（第 4 个 mock-main 请求）到达 = 空闲窗口执行开始
  const mainReqs4 = await waitMockRequests(instance, MAIN_MODEL, 4, 90_000, 'Dream#1 整合请求')
  const dreamReq1 = mainReqs4.find((r) => requestFullText(r).includes(INTEGRATOR_MARK)) ?? null
  ev.assert('D1: 空闲窗口自动执行整合（Dream 整合请求真实发生，system 含「你是记忆库整合器」）', Boolean(dreamReq1), {
    channel: 'C',
    expected: `第 4 个请求含「${INTEGRATOR_MARK}」`,
    actual: `steps=${mainReqs4.map((r) => r.stepIndex).join(',')} hits=${mainReqs4.filter((r) => requestFullText(r).includes(INTEGRATOR_MARK)).length}`,
  })
  // 在途确认：等 1.5s 让流持续（慢步 ~8.8s）
  await new Promise((r) => setTimeout(r, 1_500))

  // 整合期间磁盘态：项目锁 + 快照目录（锁内先建快照再调 LLM——此时两者应在盘）
  const lockDir = path.join(scopeDirA, 'MEMORY.md.lock')
  const lockHeld = fs.existsSync(lockDir)
  const backupsDir = path.join(agentDir, 'memory', 'backups')
  const backupsDuring = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => /^\d{8}T\d{6}\d{3}Z/.test(n)) : []
  ev.assert('D2: 整合期间项目锁存在（MEMORY.md.lock 目录，V9 通过标准）', lockHeld, {
    channel: 'C',
    expected: `${lockDir} 存在`,
    actual: lockHeld ? '在盘' : '不存在',
  })
  ev.assert('D3: 整合前快照已创建（backups/<ts> 出现，V9 通过标准「有日志与快照」）', backupsDuring.length >= 1, {
    channel: 'C',
    expected: 'backups/ 下 ≥1 个快照目录',
    actual: `dirs=${JSON.stringify(backupsDuring)}`,
  })
  ev.step({
    step: 'dream.inflight', channel: 'C', exitCode: 0,
    stats: { dreamStepIndex: dreamReq1?.stepIndex, lockHeld, backups: backupsDuring.length },
  })

  // ── 让位：整合在途发消息（turn_start → abort；RL9）────────────────────────
  since = protocol.events.length
  await protocol.send(sidA2, 'ok')
  end = await protocol.waitTurnEnd(sidA2, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('Y1: 整合期间用户输入不被阻塞（次轮回合 message.complete）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete 非 error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  // 让位日志（turn_start handler：user input during integration; yielding）
  try {
    await waitUntil(() => readMemoryLog(dataDir).includes('dream: user input during integration; yielding'), 30_000, '让位日志')
  } catch {
    /* 由 Y2 断言暴露 */
  }
  const memLogMid = readMemoryLog(dataDir)
  ev.assert('Y2: 让位日志（dream: user input during integration; yielding）', memLogMid.includes('dream: user input during integration; yielding'), {
    channel: 'C',
    expected: '含让位日志行',
    actual: memLogMid.split('\n').filter((l) => l.includes('dream:')).slice(-6).join(' ⏎ ') || '(无 dream 日志)',
  })
  await waitMockRequests(instance, MAIN_MODEL, 5, 60_000, '次轮回合')

  // ── 下一空闲再续：次轮 settled → Dream#2 → 完成 ────────────────────────────
  const finished = await waitUntil(() => {
    const raw = readText(path.join(scopeDirA, 'integration-state.json'))
    try {
      const v = JSON.parse(raw ?? '')['last-integrated']
      return typeof v === 'string' && v !== staleIso ? v : false
    } catch {
      return false
    }
  }, DREAM_SETTLE_MS, 'Dream#2 完成（last-integrated 更新）')
  ev.assert('R1: 让位后下一空闲再续——Dream 二次执行完成（last-integrated 更新为当前时刻）', Boolean(finished), {
    channel: 'C',
    expected: 'last-integrated ≠ 25h 前的 stale 值',
    actual: `stale=${staleIso} now=${finished ?? '(未更新)'}`,
  })
  ev.step({ step: 'dream.finished', channel: 'C', exitCode: 0, stats: { lastIntegrated: finished } })

  // 完成后：锁释放 + 快照保留 + 游标推进 + 条目落盘
  await new Promise((r) => setTimeout(r, 500))
  ev.assert('R2: 完成后项目锁释放', !fs.existsSync(lockDir), {
    channel: 'C',
    expected: 'MEMORY.md.lock 不存在',
    actual: fs.existsSync(lockDir) ? '仍在盘' : '已释放',
  })
  const backupsFinal = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => /^\d{8}T\d{6}\d{3}Z/.test(n)) : []
  ev.assert('R3: 快照保留（backups 目录非空，V9 断言③）', backupsFinal.length >= 1, {
    channel: 'C',
    expected: '≥1 个快照目录',
    actual: `dirs=${JSON.stringify(backupsFinal)}`,
  })
  const records = readCursorRecords(agentDir)
  const recA = records.find((r) => r.projectSlug === slugA)
  const recB = records.find((r) => r.projectSlug === slugB)
  ev.assert('R4: 项目 A 游标推进（consumedAt 非 null——跨会话素材被消费）', recA?.consumedAt != null, {
    channel: 'C',
    expected: 'slugA 行 consumedAt 非 null',
    actual: JSON.stringify({ slugA: recA?.consumedAt ?? null, slugB: recB?.consumedAt ?? null }),
  })
  const dreamEntryPath = path.join(scopeDirA, 'facts', `${DREAM_ENTRY}.md`)
  const dreamEntry = readText(dreamEntryPath)
  ev.assert('R5: origin: dream 条目落盘（projects/<slugA>/facts/）', dreamEntry !== '' && /^ {2}origin: dream$/m.test(dreamEntry), {
    channel: 'C',
    expected: `${dreamEntryPath} 含「  origin: dream」`,
    actual: dreamEntry ? `在盘 origin 命中=${/^ {2}origin: dream$/m.test(dreamEntry)}` : '不存在',
  })
  ev.assert('R5b: 条目正文含项目 A 素材哨兵（跨会话素材进整合产物）', dreamEntry.includes(DREAM_FACT), {
    channel: 'C',
    expected: `正文含 ${DREAM_FACT}`,
    actual: `hit=${dreamEntry.includes(DREAM_FACT)}`,
  })
  ev.attach('dream-entry', dreamEntry.slice(0, 2_000))
  ev.step({
    step: 'dream.artifacts', channel: 'C', exitCode: 0,
    stats: { backups: backupsFinal.length, cursorA: recA?.consumedAt, cursorB: recB?.consumedAt, entry: dreamEntry !== '' },
  })

  // ── V11 摄取隔离：Dream 载荷与产物均不含项目 B 素材 ────────────────────────
  const allMainReqs = (instance.mockLlm?.requests ?? []).filter(
    (r) => r.status === 200 && (r.model === MAIN_MODEL || r.model?.endsWith(`/${MAIN_MODEL}`)),
  )
  const dreamReqs = allMainReqs.filter((r) => requestFullText(r).includes(INTEGRATOR_MARK))
  ev.assert('V11-1: Dream 模型调用载荷含项目 A 会话素材（跨会话证据，V9 通过标准）', dreamReqs.some((r) => requestFullText(r).includes(DREAM_FACT)), {
    channel: 'C',
    expected: `Dream 请求含 ${DREAM_FACT}`,
    actual: `dreamRequests=${dreamReqs.length}（steps=${dreamReqs.map((r) => r.stepIndex).join(',')}）`,
  })
  ev.assert('V11-2: Dream 载荷不含项目 B 会话素材（摄取隔离，V11 通过标准）', !dreamReqs.some((r) => requestFullText(r).includes(PROJB_FACT)), {
    channel: 'C',
    expected: `Dream 请求不含 ${PROJB_FACT}`,
    actual: `命中 ${dreamReqs.filter((r) => requestFullText(r).includes(PROJB_FACT)).length}/${dreamReqs.length} 条`,
  })
  ev.assert('V11-3: 项目 B 游标行不被消费（consumedAt 仍 null——素材不丢，后续自身 Dream 可消费）', recB?.consumedAt == null, {
    channel: 'C',
    expected: 'slugB 行 consumedAt=null',
    actual: JSON.stringify(recB ?? { missing: true }),
  })
  const scopeDirB = path.join(agentDir, 'memory', 'projects', slugB)
  const factsB = fs.existsSync(path.join(scopeDirB, 'facts')) ? fs.readdirSync(path.join(scopeDirB, 'facts')) : []
  ev.assert('V11-4: 项目 B 记忆目录无衍生条目', factsB.length === 0, {
    channel: 'C',
    expected: 'projects/<slugB>/facts/ 无条目（或目录不存在）',
    actual: `files=${JSON.stringify(factsB)}`,
  })
  ev.attach('mock-dream-requests', JSON.stringify(dreamReqs.map((r) => ({ stepIndex: r.stepIndex, messageCount: r.messageCount, hasA: requestFullText(r).includes(DREAM_FACT), hasB: requestFullText(r).includes(PROJB_FACT) })), null, 2))
  ev.attach('memory-log', readMemoryLog(dataDir).slice(-8_000))
  ev.attach('dream-finish-log', readMemoryLog(dataDir).split('\n').filter((l) => l.includes('dream: integration finished')).join('\n') || '(无)')

  log(`done sidA2=${sidA2} backups=${backupsFinal.length} lastIntegrated=${finished}`)
  return { uncovered, gotchas }
}
