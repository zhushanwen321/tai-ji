/**
 * memory-subagent-isolation —— 记忆扩展（@zhushanwen/pi-memory）孙进程隔离真机验收
 * （设计 memory-system §4 V10 / 验收清单 A10；D11/G10 守护——扩展工厂入口短路）。
 *
 * 场景：主会话派发 subagent（subagent-workflow 的 subagent_start 工具，mock-http 孙进程
 * 通道——先例 p0-subagent-workflow-dispatch 同款）完成一次任务 → 断言孙进程会话内
 * memory 扩展三面全部不挂载（注入/提炼/摄取），主会话记忆行为照常。
 *
 * ── 隔离机制（memory/src/index.ts 源码语义）──
 *
 * 扩展工厂入口检测 process.env.PI_SUBAGENT_SELF_RECORD_ID（subagent-workflow spawn
 * 孙进程时注入，session-lifecycle.ts 实码）非空即短路 return——先于一切事件接线与
 * 工具注册：注入（context/promptSnippet）、提炼（turn_end 入队）、摄取（session_shutdown
 * 游标登记）三面在孙进程内均不发生；主进程形态不受影响。
 *
 * ── 断言通道（V10 通过标准逐条）──
 *
 * ① 「子代理上下文无记忆索引块注入」：mock.requests 留档孙进程请求全文——断言
 *    model=mock-sub 的全部请求不含 <memory-context>（inject/block.ts 定界标签）；
 *    对照组 = 主会话在记忆库有内容后的回合请求必含该标签（主进程注入生效的正面证据）。
 * ② 「记忆库不出现子代理对话衍生条目」+「turn_end 不在孙进程产生提炼」：断言
 *    mock-sub 全部请求不含「你是记忆提炼器」（提炼调用必带该 systemPrompt——孙进程
 *    若未短路，其提炼 complete 会以孙进程缺省模型打到 mock 队列）；比对派发前后
 *    facts/ 条目集合不变。
 * ③ 「摄取游标无子代理会话登记」：ingest-cursor.jsonl 无 subagents 树会话行。
 * ④ 「主会话自身的提炼/注入/摄取不受影响」：主会话 turn 提炼条目（origin: extracted）
 *    落盘 + 主会话后续回合请求含 <memory-context>。
 *
 * ── 队列步序（mock-main per-model 单游标；子队独立）──
 *
 *   mock-main step0 消息1回合（正文 ≥3 词 → turn_end 提炼入队）
 *   mock-main step1 回合提炼步（返回 add 操作集：name=user-pref-fact，type=user）
 *   mock-main step2 消息2回合（"go" 1 词 + taiji 注释尾巴 = 2 词 → 跳过门拦下零提炼）
 *            ＝ subagent_start toolCall 诱导轮
 *   mock-main step3 孙进程收尾后的主会话收尾轮回复
 *   mock-sub  step0 孙进程 canary 文本（stop）+ step1-3 done 余量（成员引擎收尾轮）
 *
 * scopedModels 白名单 patch（p0 剧本同款）：显式 model 派发受 providers.json
 * scopedModels 白名单校验，launch 后把两个 mock 演员补进白名单。
 *
 * Cleanup 由 runner 承载；本剧本零自持进程。
 */
import fs from 'node:fs'
import path from 'node:path'

// ── 常量 ──────────────────────────────────────────────────────────────────────
const MAIN_MODEL = 'mock-main'
const SUB_MODEL = 'mock-sub'
const PROVIDER = 'mockllm'

/** 主会话记忆事实关键词（消息 1 正文 + 提炼条目正文）。 */
const USER_PREF_MARK = '中文周报偏好-6620'
/** 主会话提炼落盘条目 name。 */
const MAIN_ENTRY = 'user-pref-fact'
/** 孙进程 canary（先例剧本手法）。 */
const SUB_CANARY = 'GRANDCHILD_MEMORY_CANARY_77f3'
/** 注入块定界标签（inject/block.ts MEMORY_BLOCK_START）。 */
const MEMORY_BLOCK_TAG = '<memory-context>'
/** 提炼 systemPrompt 首句特征（extract/prompt.ts）。 */
const EXTRACTOR_MARK = '你是记忆提炼器'

const TURN_BUDGET_MS = 60_000

/** mock-main 队列（步序语义见文件头注释）。 */
const mainQueue = [
  { text: `ack-1 已收到用户偏好（${USER_PREF_MARK}）`, stopReason: 'stop' }, // step0
  {
    // step1 回合提炼：add 操作集（type=user → user scope facts/）
    text: `{"operations":[{"op":"add","name":"${MAIN_ENTRY}","description":"用户偏好：周报用中文并携带标记","type":"user","content":"用户明确偏好：周报一律用中文撰写并携带标记 ${USER_PREF_MARK}。\\nWhy: 用户在主会话中明确要求。\\nHow to apply: 撰写周报时遵循该偏好。"}]}`,
    stopReason: 'stop',
  },
  {
    // step2 诱导轮：派发 subagent（显式 model → scopedModels 白名单须含 mock 演员）
    text: '派出子任务核对其响应：',
    toolCalls: [
      {
        name: 'subagent_start',
        args: {
          task: 'Echo the exact canary word your scripted response contains, nothing else.',
          slug: 'memory-iso-sub',
          model: `${PROVIDER}/${SUB_MODEL}`,
          fork: false,
        },
      },
    ],
    stopReason: 'toolUse',
  },
  { text: '子任务已完成（主会话收尾轮）', stopReason: 'stop' }, // step3
  { text: '{"operations":[{"op":"skip","reason":"备用步"}]}', stopReason: 'stop' }, // 备用
  { text: '{"operations":[{"op":"skip","reason":"备用步"}]}', stopReason: 'stop' }, // 备用
]

/** mock-sub 队列（孙进程演员；干净 stop 后成员引擎仍有一轮收尾请求——先例 p0/a2 实测，备余量）。 */
const subQueue = [
  { text: SUB_CANARY, stopReason: 'stop' },
  { text: 'done', stopReason: 'stop' }, // 收尾轮余量
  { text: 'done', stopReason: 'stop' }, // 收尾轮余量
  { text: 'done', stopReason: 'stop' }, // 收尾轮余量
]

export const meta = {
  id: 'memory-subagent-isolation',
  priority: 'P1',
  title: '记忆扩展孙进程隔离 V10/D11：subagent 会话无注入/无提炼/无摄取，主会话记忆照常',
  covers: ['session.create', 'chat.send', 'chat.wait', 'subagent.dispatch', 'subagent.list', 'protocol.rpc'],
  requires: ['mock-http'],
  estimateSec: 300,
  env: { TAIJI_AGENT_DEBUG: '1' },
  llm: {
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
    models: [MAIN_MODEL, SUB_MODEL],
    responses: {
      [`${PROVIDER}/${MAIN_MODEL}`]: mainQueue,
      [`${PROVIDER}/${SUB_MODEL}`]: subQueue,
    },
  },
  provable: [
    'subagent 派发链路成功：record 走到终态 + canary 出现在子代理产物（隔离断言的前置成立条件）',
    '孙进程请求载荷不含记忆索引块（<memory-context>）——D11 注入面不挂载',
    '孙进程无记忆提炼调用（mock-sub 全部请求不含「你是记忆提炼器」systemPrompt）——D11 提炼面不挂载',
    '记忆库无子代理对话衍生条目（派发前后 facts/ 条目集合不变）',
    '摄取游标无子代理会话登记（ingest-cursor 无 subagents 树会话行）——D11 摄取面不挂载',
    '主会话对照：turn 提炼条目 origin: extracted 落盘 + 主会话后续回合请求含 <memory-context> 注入块',
  ],
  notProvable: [
    'promptSnippet/工具注册面（memory_save 等工具在孙进程的缺席）——mock server 不留档请求体 tools 字段，无观测通道',
    '真实模型智能下的子任务语义（mock 孙进程演员由剧本编排）',
    'workflow fan-out 孙进程（同为孙进程通道，D11 同一短路覆盖——先例 p0-subagent-workflow-dispatch 已覆盖派发链路本身）',
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

/** 请求体全文（system + 各 role content 抽平）。 */
function requestFullText(request) {
  return (request?.messages ?? [])
    .map((m) => {
      if (typeof m?.content === 'string') return m.content
      if (Array.isArray(m?.content)) return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      return ''
    })
    .join('\n')
}

/** 递归读目录下文本（体积上限保护；先例剧本同款）。 */
function readTreeText(root, maxBytes = 4_000_000) {
  let total = 0
  const parts = []
  const walk = (dir, depth = 0) => {
    if (depth > 6 || total > maxBytes) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (total > maxBytes) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const st = fs.statSync(full, { throwIfNoEntry: false })
      if (!st || st.size > 2_000_000) continue
      const text = readText(full)
      total += text.length
      parts.push(`# ${path.relative(root, full)}\n${text}`)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return parts.join('\n')
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
    '孙进程经 PI_CODING_AGENT_DIR 读同一份 models.json（--no-extensions spawn，faux 不可达）——mock-http 是孙进程唯一零 token 通道（先例 p0 剧本结论）',
    '显式 model 派发受 providers.json scopedModels 白名单校验——launch 后 patch 两个 mock 演员（实例装配配置，非产品代码）',
    'taiji 给每条用户消息追加 <!--taiji:msg:<uuid>--> 注释尾巴（+1 计词段）——正文 1 词 + 尾巴 = 2 词才低于跳过门 3 词线（探针实测）；诱导轮正文用 "go"',
    '主会话请求识别对照组：mock-main 第 3 个请求（stepIndex=2）= 记忆落盘后的诱导轮请求——注入块应在其 messages 头部',
    '提炼调用识别特征 = systemPrompt「你是记忆提炼器」（openai-completions provider 把 systemPrompt 转 messages[0] role=system）',
    '成员引擎干净 stop 后仍有一轮收尾请求（先例 p0/a2 实测）——subQueue 备 done 余量防收尾轮 404 判 failed',
  ]

  // 装配自检 + scopedModels patch（p0 剧本同款）
  const topo = instance.llm
  const modelsJson = JSON.parse(readText(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  const subCfg = JSON.parse(readText(path.join(dataDir, 'agent', 'subagents', 'config.json')) || '{}')
  ev.assert('装配：孙进程缺省模型 = mock-sub（engineDefaults.pi）', String(subCfg.engineDefaults?.pi ?? '').includes(SUB_MODEL), {
    channel: 'C',
    expected: `engineDefaults.pi 含 ${SUB_MODEL}`,
    actual: subCfg.engineDefaults?.pi ?? '<缺>',
  })
  const providersPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  try {
    const providersRaw = JSON.parse(readText(providersPath) || '{}')
    const before = Array.isArray(providersRaw.scopedModels) ? providersRaw.scopedModels : []
    providersRaw.scopedModels = [...new Set([...before, `${PROVIDER}/${MAIN_MODEL}`, `${PROVIDER}/${SUB_MODEL}`])]
    fs.writeFileSync(providersPath, `${JSON.stringify(providersRaw, null, 2)}\n`)
    log(`scopedModels patched: ${JSON.stringify(providersRaw.scopedModels)}`)
  } catch (e) {
    log(`scopedModels patch 失败：${e.message}`)
  }

  const memoryFactsDir = path.join(dataDir, 'agent', 'memory', 'facts')

  // ── 主会话：记忆事实落盘（提炼链路 + 索引重建，为注入对照组铺底）────────────
  const created = await protocol.call('session.create', { cwd: repo, label: 'memory-iso' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert('M1: 主会话创建', Boolean(sid), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created.session ?? {}).slice(0, 200),
  })
  await protocol.subscribe(sid)
  ev.step({ step: 'session.create', channel: 'B', exitCode: 0, stats: { sessionId: sid } })

  let since = protocol.events.length
  await protocol.send(sid, `请记住这个长期偏好：${USER_PREF_MARK}——我的周报一律用中文撰写并携带此标记。`)
  let end = await protocol.waitTurnEnd(sid, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('M2: 记忆事实回合完成', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  // 等回合提炼（fire-and-forget）完成：条目文件落盘（含索引重建）
  await waitMockRequests(instance, MAIN_MODEL, 2, 30_000, '记忆事实回合+提炼')
  const mainEntryPath = path.join(memoryFactsDir, `${MAIN_ENTRY}.md`)
  let mainEntry = ''
  try {
    await waitUntil(() => readText(mainEntryPath) !== '', 30_000, '主会话提炼条目落盘')
    mainEntry = readText(mainEntryPath)
  } catch {
    mainEntry = readText(mainEntryPath)
  }
  ev.assert('M3: 主会话 turn 提炼落盘 facts/user-pref-fact.md', mainEntry !== '', {
    channel: 'C',
    expected: mainEntryPath,
    actual: mainEntry ? '在盘' : '不存在',
  })
  ev.assert('M4: 条目溯源 origin: extracted（主会话提炼照常，V10 对照组）', /^ {2}origin: extracted$/m.test(mainEntry), {
    channel: 'C',
    expected: 'metadata.origin = extracted',
    actual: mainEntry ? mainEntry.split('---')[1]?.trim().split('\n').filter((l) => l.includes('origin')).join(' | ') : '(文件缺失)',
  })
  const factsBefore = fs.existsSync(memoryFactsDir) ? fs.readdirSync(memoryFactsDir).filter((f) => f.endsWith('.md')).sort() : []
  ev.step({ step: 'memory.mainExtract', channel: 'C', exitCode: mainEntry !== '' ? 0 : 1, stats: { factsBefore: JSON.stringify(factsBefore) } })

  // ── 派发 subagent（消息 2 诱导轮；孙进程请求打 mock-sub）────────────────────
  // 正文 'go'（1 词 + taiji 注释尾巴 = 2 词 → 跳过门拦下，零回合提炼——队列消费序确定）
  since = protocol.events.length
  await protocol.send(sid, 'go')
  end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('S1: 诱导轮回合完成（subagent_start 派发 + 收尾）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })

  // 等子代理 record 终态
  const deadline = Date.now() + 120_000
  let records = []
  let record = null
  while (Date.now() < deadline) {
    const reply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === 'memory-iso-sub') ?? records[0] ?? null
    if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
    if (record && (record.stopReason || record.outcome)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  ev.assert('S2: 子代理 record 走到终态 done/idle（派发链路成立——隔离断言的前置）', ['done', 'idle'].includes(String(record?.status)), {
    channel: 'B',
    expected: 'status ∈ {done, idle}',
    actual: `status=${record?.status} model=${record?.model} error=${String(record?.error ?? '').slice(0, 150)}`,
  })
  ev.attach('subagent-records', JSON.stringify(records, null, 2).slice(0, 20_000))
  ev.step({
    step: 'subagent.observe', channel: 'B', exitCode: 0,
    stats: { count: records.length, status: record?.status, model: record?.model },
  })

  // C 通道：canary 出现在子代理产物（孙进程真的产出 mock 回复）
  const subagentsTree = path.join(dataDir, 'ext-sessions', String(sid), 'subagents')
  const diskText = readTreeText(subagentsTree)
  ev.assert('S3: canary 出现在子代理产物', diskText.includes(SUB_CANARY), {
    channel: 'C',
    expected: `subagents 树含 ${SUB_CANARY}`,
    actual: `bytes=${diskText.length} hit=${diskText.includes(SUB_CANARY)}`,
  })

  // ── D11 隔离断言（mock 请求铁证 + 磁盘状态）─────────────────────────────────
  const allRequests = instance.mockLlm?.requests ?? []
  const subReqs = allRequests.filter((r) => r.status === 200 && (r.model === SUB_MODEL || r.model?.endsWith(`/${SUB_MODEL}`)))
  const mainReqs = allRequests.filter((r) => r.status === 200 && (r.model === MAIN_MODEL || r.model?.endsWith(`/${MAIN_MODEL}`)))
  ev.assert('D11 前置：孙进程请求真实打到 mock（≥1 条 mock-sub 请求）', subReqs.length >= 1, {
    channel: 'C',
    expected: `≥1 × model=${SUB_MODEL}`,
    actual: `${subReqs.length} 条（steps=${subReqs.map((r) => r.stepIndex).join(',')}）`,
  })

  // ① 注入面：孙进程请求不含记忆索引块
  const subWithBlock = subReqs.filter((r) => requestFullText(r).includes(MEMORY_BLOCK_TAG))
  ev.assert('D11-1: 孙进程请求载荷不含记忆索引块 <memory-context>（注入面不挂载）', subReqs.length > 0 && subWithBlock.length === 0, {
    channel: 'C',
    expected: '0 条孙进程请求含注入块',
    actual: `${subWithBlock.length}/${subReqs.length} 条命中（steps=${subWithBlock.map((r) => r.stepIndex).join(',')}）`,
  })

  // 对照组：主会话诱导轮请求（记忆落盘后的第一个回合请求）含注入块
  const mainTurn2 = mainReqs.find((r) => r.stepIndex === 2) ?? mainReqs[mainReqs.length - 1]
  const mainInjected = requestFullText(mainTurn2 ?? {}).includes(MEMORY_BLOCK_TAG)
  ev.assert('D11-1b 对照：主会话诱导轮请求含 <memory-context>（主进程注入生效——同库同标签的正反对照）', mainInjected, {
    channel: 'C',
    expected: `mock-main step2 请求含 ${MEMORY_BLOCK_TAG}`,
    actual: `stepIndex=${mainTurn2?.stepIndex} hit=${mainInjected} mainRequests=${mainReqs.length}`,
  })

  // ② 提炼面：孙进程无提炼调用（systemPrompt 特征）
  const subWithExtractor = subReqs.filter((r) => requestFullText(r).includes(EXTRACTOR_MARK))
  ev.assert('D11-2: 孙进程无记忆提炼调用（mock-sub 请求不含「你是记忆提炼器」）', subReqs.length > 0 && subWithExtractor.length === 0, {
    channel: 'C',
    expected: '0 条孙进程请求含提炼 systemPrompt',
    actual: `${subWithExtractor.length}/${subReqs.length} 条命中`,
  })

  // ②' 记忆库条目集合不变（无子代理衍生条目）
  const factsAfter = fs.existsSync(memoryFactsDir) ? fs.readdirSync(memoryFactsDir).filter((f) => f.endsWith('.md')).sort() : []
  ev.assert('D11-3: 记忆库无子代理对话衍生条目（facts 集合派发前后不变）', JSON.stringify(factsAfter) === JSON.stringify(factsBefore), {
    channel: 'C',
    expected: `facts=${JSON.stringify(factsBefore)}`,
    actual: `facts=${JSON.stringify(factsAfter)}`,
  })
  // 项目级 facts 也核对（孙进程 cwd=主会话 cwd → 同项目 scope）
  const projectFactsDirs = (() => {
    const projectsDir = path.join(dataDir, 'agent', 'memory', 'projects')
    if (!fs.existsSync(projectsDir)) return []
    const out = []
    for (const slug of fs.readdirSync(projectsDir)) {
      const facts = path.join(projectsDir, slug, 'facts')
      if (fs.existsSync(facts)) out.push(...fs.readdirSync(facts).filter((f) => f.endsWith('.md')).map((f) => `${slug}/${f}`))
    }
    return out.sort()
  })()
  ev.assert('D11-3b: 项目级 facts 无新增条目（孙进程同 cwd 不落项目记忆）', projectFactsDirs.length === 0, {
    channel: 'C',
    expected: 'projects/*/facts/ 无条目',
    actual: `files=${JSON.stringify(projectFactsDirs)}`,
  })

  // ③ 摄取面：游标无子代理会话登记
  const cursorRaw = readText(path.join(dataDir, 'agent', 'memory', 'ingest-cursor.jsonl'))
  const cursorLines = cursorRaw.split('\n').filter((l) => l.trim() !== '')
  const subagentCursorRows = cursorLines.filter((l) => l.includes('subagents'))
  ev.assert('D11-4: 摄取游标无子代理会话登记（V10 通过标准）', subagentCursorRows.length === 0, {
    channel: 'C',
    expected: 'ingest-cursor.jsonl 无 subagents 树会话行',
    actual: `总行数=${cursorLines.length} 子代理行=${subagentCursorRows.length}`,
  })
  ev.attach('cursor-file', cursorRaw || '(文件不存在)')
  ev.attach('mock-requests', JSON.stringify(allRequests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, messageCount: r.messageCount })), null, 2))
  ev.attach('sub-request-samples', JSON.stringify(subReqs.slice(0, 2).map((r) => ({ stepIndex: r.stepIndex, summary: r.summary })), null, 2))
  ev.step({
    step: 'memory.isolation', channel: 'C', exitCode: 0,
    stats: {
      subRequests: subReqs.length, subWithBlock: subWithBlock.length, subWithExtractor: subWithExtractor.length,
      mainInjected, factsBefore: factsBefore.length, factsAfter: factsAfter.length, cursorRows: cursorLines.length,
    },
  })

  log(`done sid=${sid} sub=${record?.status} subReqs=${subReqs.length} mainInjected=${mainInjected}`)
  return { uncovered, gotchas }
}
