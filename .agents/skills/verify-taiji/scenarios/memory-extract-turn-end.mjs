/**
 * memory-extract-turn-end —— 记忆扩展（@zhushanwen/pi-memory）turn_end 回合提炼
 * 成功链真机验收（设计 memory-system U4/D3/RL3；验收清单 A2c——现有 a1～a9 均未
 * 覆盖「成功写入」半边：a1 的提问回合会触发回合提炼但队列按主回合编排，提炼
 * 命中耗尽 404 → warn 放弃，无写入）。
 *
 * 场景（同一会话两回合，同一模型）：
 *   回合 1（该记的）：用户陈述偏好类事实（正文含哨兵码，≥3 词触发提炼）→
 *     mock 提炼步返回 add 操作集 → 统一写入入口落盘项目级条目 + 索引行；
 *   回合 2（不该记的）：用户问纯代码结构问题（≥3 词入队提炼）→ mock 返回
 *     skip → 无新条目、索引不变。
 *
 * ── LLM 通道：mock-http（meta.llm），单模型单队列 ──
 *
 * 提炼 complete 继承当轮会话模型（extract/runner.ts createModelRegistryCompleteCall，
 * AS12）→ 与主回合共用 mockllm/mock-main per-model 单游标。队列步序 = 严格消费序，
 * 每步之间条件等待 mock 请求数到位再推进（waitMockRequests；错位消费会让提炼拿到
 * 普通文本、解析重试 1 次后放弃——a3 剧本踩过的坑，同款纪律）：
 *   step0 回合 1 主回合 / step1 回合 1 提炼（add，type=project）
 *   step2 回合 2 主回合 / step3 回合 2 提炼（skip）/ 尾部 +2 备用 skip 步
 *
 * ── turn_end 双发去重的断言定位 ──
 *
 * pi 对同一回合可能双发 turn_end（finishTurn 扩展边界与内部 emit 两条路径），
 * 扩展按 turnIndex|messageEntryId 记录最近回合丢弃第二发（extract/queue.ts
 * lastTurnKey）。断言 = 提炼请求（请求 system 含「你是记忆提炼器」的 200 请求）
 * 每回合恰好 1 个：回合 1 后提炼请求数 === 1，回合 2 后 === 2。若去重失效，
 * 第二发提炼会多消费队列步 → 恰好计数断言与 stepIndex 断言同时红。
 *
 * ── 提炼触发链与不插队事实（源码核实）──
 *
 * - 跳过门（extract/queue.ts shouldSkipExtraction）：本回合有 memory_save 痕迹 /
 *   用户正文 <3 词 / 计划模式 → 跳过。两回合正文均 ≥3 词（taiji 尾巴注释
 *   <!--taiji:msg:…--> 由扩展先剥再计数）且无工具调用 → 均入队提炼。
 * - Dream 自动整合不插队：触发 = session_start 间隔判定入队 + agent_settled 执行，
 *   且要求 ingest 游标有 pending 素材；游标登记只发生在 session_shutdown
 *   （ingest/hook.ts registerSessionShutdown）——本剧本两回合之间不关会话，
 *   游标恒空 → Dream 永不入队。
 * - auto-rename 标题生成已由装配层关闭（lib/instance.mjs disarmAutoRename）；
 *   smart-context 无配置文件不启用（a3 需显式写 smart-context-ext-config.json）。
 *   故 mock-main 队列消费者只有主回合步 + 提炼步，「恰好计数」断言成立。
 *
 * ── scope 编排说明（对齐实装 SCOPE_FOR_TYPE，write-gate.ts）──
 *
 * type→scope 映射：user/feedback/reference → user 级、project → 项目级。
 * 回合 1 add 编排 type=project（正文带 Why:/How to apply: 两行过 write-gate
 * 格式校验）→ 落 projects/<slug>/facts/，断言链的「项目 scope 目录 + 非 user 级」
 * 用该条目承载；mock 操作集类型由剧本编排，真实模型的类型选择质量属 notProvable。
 *
 * Cleanup 由 runner 承载（SKILL.md §5）；本剧本零自持进程，fixture 全在 dataDir 内。
 */
import fs from 'node:fs'
import path from 'node:path'

// ── 常量 ──────────────────────────────────────────────────────────────────────
/** 主会话模型（回合演员 + memory 提炼调用继承的当轮会话模型）。 */
const MAIN_MODEL = 'mock-main'
const PROVIDER = 'mockllm'

/** 回合 1 哨兵码：埋在用户正文（提炼素材断言）与 add content（落盘正文断言）。 */
const PREF_CODE = 'PREF-SENTRY-7719'
/** 回合 2 关键码：纯代码结构问题的类名（提炼素材覆盖断言）。 */
const Q2_MARK = 'RouterMiddleware'

/** 回合 1 提炼步 add 操作集的目标条目（name 须 kebab-case 过 write-gate 词法）。 */
const ENTRY_NAME = 'reply-language-chinese'
const ENTRY_DESC = '用户要求以后所有回复一律使用中文'

/** memory 回合提炼 systemPrompt 首句特征（extract/prompt.ts buildExtractionPrompt）。 */
const EXTRACTOR_MARK = '你是记忆提炼器'
/** memory 扩展放弃日志标记（extract/queue.ts drain 的 AX2 降级路径；成功链不应出现）。 */
const GAVE_UP_MARK = 'turn extraction gave up'

/** 单回合完成预算。 */
const TURN_BUDGET_MS = 60_000

// ── mock 演员（步序语义见文件头队列注释；操作集文本经 JSON.stringify 构造防转义笔误）──

/** 回合 1 提炼步：add 操作集（type=project → 项目级；Why/How to apply 行过 write-gate）。 */
const ADD_STEP = {
  text: JSON.stringify({
    operations: [
      {
        op: 'add',
        name: ENTRY_NAME,
        description: ENTRY_DESC,
        type: 'project',
        content: `用户明确要求：以后所有回复一律使用中文，不使用英文（哨兵码 ${PREF_CODE}）。\nWhy: 用户在协作中明确提出的语言偏好，影响所有后续回复。\nHow to apply: 生成任何回复时默认使用中文，代码标识符与技术名词保留原文。`,
      },
    ],
  }),
  stopReason: 'stop',
}

/** skip 操作集（回合 2 提炼步 / 队列备用步）。 */
const SKIP_STEP = { text: JSON.stringify({ operations: [{ op: 'skip', reason: 'mock 演员编排的跳过步' }] }), stopReason: 'stop' }

/** 回合 2 提炼步：skip（纯代码结构问题不该记）。 */
const SKIP_Q2_STEP = { text: JSON.stringify({ operations: [{ op: 'skip', reason: '纯代码结构问题，无偏好/纠正/决策语义' }] }), stopReason: 'stop' }

/** mock-main 队列（严格消费序：主回合步与提炼步交错）。 */
const mainQueue = [
  { text: '好的，之后都用中文回复。', stopReason: 'stop' }, // step0 回合 1 主回合
  ADD_STEP, // step1 回合 1 turn_end 提炼（add → 落盘）
  { text: '这个类的定义位置我查一下项目结构再答复。', stopReason: 'stop' }, // step2 回合 2 主回合
  SKIP_Q2_STEP, // step3 回合 2 turn_end 提炼（skip → 不落盘）
  SKIP_STEP, // 备用（防解析重试等意外多消费一步时 fail 快、诊断全）
  SKIP_STEP, // 备用
]

export const meta = {
  id: 'memory-extract-turn-end',
  priority: 'P0',
  title: 'turn_end 回合提炼成功链：add 落盘项目级条目 + 索引行 + 双发去重每回合恰好 1 次提炼；不该记的回合 skip 零写入',
  covers: ['session.create', 'chat.send', 'chat.wait', 'session.history', 'protocol.rpc', 'protocol.events'],
  requires: ['mock-http'],
  estimateSec: 300,
  // TAIJI_AGENT_DEBUG=1：memory 扩展 fileLog 落 <dataDir>/agent/logs/memory-<date>.log（E 组日志断言数据源）
  env: { TAIJI_AGENT_DEBUG: '1' },
  llm: {
    mainModel: MAIN_MODEL,
    models: [MAIN_MODEL],
    responses: {
      [`${PROVIDER}/${MAIN_MODEL}`]: mainQueue,
    },
  },
  provable: [
    '回合 1（该记的）主回合正常完成（message.complete 非 error）',
    '提炼请求真实到达 mock：请求 system 含「你是记忆提炼器」、素材（user 消息）含用户正文哨兵码 PREF-SENTRY-7719',
    'turn_end 双发去重：提炼请求每回合恰好 1 次（回合 1 后提炼请求数=1、回合 2 后=2），且队列步序严格对位（提炼步消费 step1/step3，主回合步消费 step0/step2）',
    'add 操作集经统一写入入口落盘 projects/<slug>/facts/reply-language-chinese.md：frontmatter type: project、metadata origin: extracted、originSessionId=会话 id、正文含哨兵内容与 Why:/How to apply: 两行',
    '对应 scope 的 MEMORY.md 索引行落盘（- [name](name.md) — description 形态）',
    '统一入口 scope 判定：条目只落项目级（user 级 facts/ 无该条目）',
    '回合 2（不该记的）主回合正常完成、提炼请求到达且素材含 RouterMiddleware、系统提示 manifest 含已有条目（去重参照在场）、mock 返回 skip 后无新条目文件、索引行不变',
    '成功链下游消费：回合 2 主回合请求含该条目的记忆注入块（写入 → 索引 → 注入闭环）',
    'memory 日志无「turn extraction gave up」放弃标记（成功路径未走 AX2 降级）',
  ],
  notProvable: [
    '真实模型智能下的提炼质量（add/skip 操作集由 mock 演员编排返回，非模型语义产出——mock-http 通道固有边界）',
    '跳过门的 already-saved / plan-mode 两个分支（本剧本两回合均无工具调用、无计划模式，只走「有素材入队」半边；already-saved 由 a1 的 memory_save 回合承载）',
    '解析失败重试路径（EXTRACT_PARSE_RETRY=1 后放弃）——正常链断言其不发生（提炼请求恰好计数），重试行为本身归单测',
    '「模型是否真的把偏好类事实判为 user 类型」的类型选择语义——本剧本为满足项目级落盘断言编排 type=project（SCOPE_FOR_TYPE 实装映射：user/feedback/reference→user 级，project→项目级）',
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

/** 条件等待 mock server 收到指定模型的第 N 个 200 请求（禁固定 sleep；超时带全量请求诊断）。 */
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

/** 请求体全文（system + 各 role content 抽平；systemPrompt 经 provider 转 messages[0]）。 */
function requestFullText(request) {
  return (request?.messages ?? [])
    .map((m) => {
      if (typeof m?.content === 'string') return m.content
      if (Array.isArray(m?.content)) return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      return ''
    })
    .join('\n')
}

/** 提炼请求识别：system 含提炼器首句标记的 200 请求（主回合请求不含该标记）。 */
function extractRequests(instance, model) {
  return (instance.mockLlm?.requests ?? []).filter(
    (r) => r.status === 200 && (r.model === model || r.model?.endsWith(`/${model}`)) && requestFullText(r).includes(EXTRACTOR_MARK),
  )
}

/** 从条目文件文本解析 frontmatter 标量与 metadata 缩进键（最小解析，够断言用；a1 同款）。 */
function parseFrontmatter(text) {
  const lines = text.split('\n')
  const end = lines.indexOf('---', 1)
  if (lines[0] !== '---' || end === -1) return null
  const top = {}
  const metadata = {}
  for (const raw of lines.slice(1, end)) {
    const meta = /^ {2}([A-Za-z]+): ?(.*)$/.exec(raw)
    if (meta) {
      metadata[meta[1]] = meta[2]
      continue
    }
    const kv = /^([A-Za-z]+): ?(.*)$/.exec(raw)
    if (kv) top[kv[1]] = kv[2]
  }
  return { top, metadata }
}

/** 读 memory 扩展日志（<dataDir>/agent/logs/memory-*.log 全量拼接）。 */
function readMemoryLog(dataDir) {
  const dir = path.join(dataDir, 'agent', 'logs')
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('memory-') && f.endsWith('.log'))
    .map((f) => readText(path.join(dir, f)))
    .join('\n')
}

/**
 * 否定性断言前的稳定轮询：skip 路径无 IO、无完成信号可等——以「facts 目录条目数
 * 与索引文本连续多次读数不变」为稳定判据（条件等待，非固定 sleep），迟到落盘会
 * 重置稳定窗并被最终读数捕捉。
 */
async function waitDiskStable(snapshotFn, { intervalMs = 200, rounds = 5 } = {}) {
  let last = JSON.stringify(snapshotFn())
  let stable = 0
  const t0 = Date.now()
  while (stable < rounds && Date.now() - t0 < 15_000) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const next = JSON.stringify(snapshotFn())
    if (next === last) stable += 1
    else {
      stable = 0
      last = next
    }
  }
  return JSON.parse(last)
}

// ── 剧本主体 ─────────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const gotchas = [
    '提炼 complete 继承当轮会话模型（extract/runner.ts AS12）——与主回合共用 mock-main per-model 单游标，每步间必须条件等待请求数到位再推进（错位消费会让提炼拿到普通文本、解析重试后放弃）',
    'mock-main 队列步序 = 严格消费序：回合步与提炼步交错编排，见文件头队列注释',
    'Dream 自动整合不插队的前提是游标无 pending 素材（登记只发生在 session_shutdown）——若未来该触发链变化（如回合级登记），本剧本的恰好计数断言会红，属预期防护',
    'turn_end 双发去重的直接断言面是 mock 请求数；扩展侧 debug 日志（turn_end duplicate dropped）仅随 TAIJI_AGENT_DEBUG 落 fileLog，作辅证不做硬断言',
    'mock 演员不设 tps 即时返回（对齐 a3 纪律，规避网络超时类误判）',
  ]

  const agentDir = path.join(dataDir, 'agent')
  const memoryDir = path.join(agentDir, 'memory')
  const userFactsDir = path.join(memoryDir, 'facts')
  const projectsDir = path.join(memoryDir, 'projects')

  // ── 0. 装配自检：mock provider 指向本机 mock 服务 ──────────────────────────
  const topo = instance.llm
  const provider = JSON.parse(readText(path.join(agentDir, 'models.json')) || '{}').providers?.[topo.providerId]
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  ev.step({ step: 'assemble.config', channel: 'C', exitCode: 0, stats: { providerId: topo.providerId, mainRef: topo.mainRef } })

  // ── 1. 建会话（cwd=repo；全新实例 memory 库为空）───────────────────────────
  const created = await protocol.call('session.create', { cwd: repo, label: 'memory-extract-turn-end' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert('A1: session.create 返回 sessionId', Boolean(sid), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created.session ?? {}).slice(0, 200),
  })
  await protocol.subscribe(sid)
  ev.step({ step: 'session.create', channel: 'B', exitCode: 0, stats: { sessionId: sid, modelId: created.session?.modelId } })

  // ── 2. 回合 1（该记的）：偏好陈述含哨兵码 ──────────────────────────────────
  let since = protocol.events.length
  await protocol.send(sid, `以后回复都用中文，别用英文，这是我的长期协作偏好，偏好哨兵码 ${PREF_CODE}`)
  let end = await protocol.waitTurnEnd(sid, { since, timeoutMs: TURN_BUDGET_MS })
  const turn1Ok = end.type === 'message.complete' && end.ok
  ev.assert('A2: 回合 1 主回合正常完成（message.complete 非 error）', turn1Ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: 'chat.send.turn1', channel: 'B', exitCode: turn1Ok ? 0 : 1, stats: { sessionId: sid } })

  // 条件等待：主回合 step0 + 提炼 step1（提炼 fire-and-forget，waitTurnEnd 返回时请求可能未发）
  const reqsAfter1 = await waitMockRequests(instance, MAIN_MODEL, 2, 30_000, '回合1主回合+提炼')
  ev.assert('A3: 回合 1 链条恰好消耗 2 步（主回合 + 提炼，无第三方插队）', reqsAfter1.length === 2, {
    channel: 'C',
    expected: '恰好 2 个 200 请求（step0 回合 + step1 提炼）',
    actual: `count=${reqsAfter1.length} steps=${reqsAfter1.map((r) => r.stepIndex).join(',')}`,
  })

  // ── 3. 提炼请求断言组（B 组：到达 + 素材 + 去重）───────────────────────────
  const extracts1 = extractRequests(instance, MAIN_MODEL)
  ev.assert('B1: turn_end 双发去重——回合 1 提炼请求恰好 1 个（第二发被 turnIndex|messageEntryId 去重丢弃）', extracts1.length === 1, {
    channel: 'C',
    expected: '提炼请求（system 含「你是记忆提炼器」）恰好 1 个',
    actual: `count=${extracts1.length} steps=${extracts1.map((r) => r.stepIndex).join(',')}`,
  })
  const extract1 = extracts1[0] ?? null
  ev.assert('B2: 提炼请求 system 含「你是记忆提炼器」（extract/prompt.ts buildExtractionPrompt 首句）', extract1 ? requestFullText(extract1).includes(EXTRACTOR_MARK) : false, {
    channel: 'C',
    expected: `请求全文含「${EXTRACTOR_MARK}」`,
    actual: extract1 ? `hit=${requestFullText(extract1).includes(EXTRACTOR_MARK)} stepIndex=${extract1.stepIndex}` : '(无提炼请求)',
  })
  ev.assert('B3: 提炼素材含用户正文哨兵码（userPrompt 承载本回合用户正文）', extract1 ? requestFullText(extract1).includes(PREF_CODE) : false, {
    channel: 'C',
    expected: `提炼请求含 ${PREF_CODE}`,
    actual: extract1 ? `hit=${requestFullText(extract1).includes(PREF_CODE)}` : '(无提炼请求)',
  })
  ev.assert('B4: 队列步序对位——提炼消费 step1（主回合消费 step0，错位即此断言红）', extract1?.stepIndex === 1, {
    channel: 'C',
    expected: '提炼请求 stepIndex=1',
    actual: `stepIndex=${extract1?.stepIndex ?? '<缺>'}`,
  })
  ev.attach('extract-request-1', extract1 ? JSON.stringify({ stepIndex: extract1.stepIndex, messageCount: extract1.messageCount, summary: extract1.summary }, null, 2) : '(无)')

  // ── 4. 落盘断言组（C 组：统一写入入口 + frontmatter + 索引）────────────────
  const entryFile = await (async () => {
    // slug 动态发现：全新实例库为空 → projects/ 下恰 1 个 slug（首次 project 写入时创建）
    const deadline = Date.now() + 30_000
    for (;;) {
      const slugs = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).filter((n) => !n.startsWith('.')) : []
      if (slugs.length === 1) {
        const candidate = path.join(projectsDir, slugs[0], 'facts', `${ENTRY_NAME}.md`)
        if (fs.existsSync(candidate)) return candidate
      }
      if (Date.now() > deadline) return path.join(projectsDir, slugs[0] ?? '<slug 未生成>', 'facts', `${ENTRY_NAME}.md`)
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  const slug = path.basename(path.dirname(path.dirname(entryFile)))
  ev.assert('C1: add 经统一写入入口落盘 projects/<slug>/facts/reply-language-chinese.md', fs.existsSync(entryFile), {
    channel: 'C',
    expected: entryFile,
    actual: fs.existsSync(entryFile) ? `在盘（slug=${slug}）` : '不存在（提炼落盘失败或未走项目级）',
  })
  ev.step({ step: 'memory.entry-file', channel: 'C', exitCode: fs.existsSync(entryFile) ? 0 : 1, stats: { entryFile, slug } })

  const entryText = readText(entryFile)
  const fm = parseFrontmatter(entryText)
  ev.assert('C2: frontmatter type: project（mock add 操作集的 type 原样落章）', fm?.top['type'] === 'project', {
    channel: 'C',
    expected: 'type=project',
    actual: fm ? `type=${fm.top['type']}` : 'frontmatter 解析失败',
  })
  ev.assert('C3: frontmatter origin: extracted（回合提炼溯源章，区别于 explicit/compaction/dream）', fm?.metadata['origin'] === 'extracted', {
    channel: 'C',
    expected: 'metadata.origin=extracted',
    actual: fm ? `origin=${fm.metadata['origin']}` : 'frontmatter 解析失败',
  })
  ev.assert('C4: frontmatter originSessionId=会话 id（溯源到本会话）', fm?.metadata['originSessionId'] === sid, {
    channel: 'C',
    expected: `originSessionId=${sid}`,
    actual: fm ? `originSessionId=${fm.metadata['originSessionId']}` : 'frontmatter 解析失败',
  })
  ev.assert('C5: 条目正文含哨兵内容（提炼产物承载关键事实）', entryText.includes(PREF_CODE), {
    channel: 'C',
    expected: `正文含 ${PREF_CODE}`,
    actual: entryText ? `hit=${entryText.includes(PREF_CODE)}` : '(文件缺失)',
  })
  ev.assert('C6: 条目正文含 Why: 与 How to apply: 两行（project 类型 write-gate 格式校验的落盘形态）', /^Why[:：]/m.test(entryText) && /^How to apply[:：]/m.test(entryText), {
    channel: 'C',
    expected: 'Why: 与 How to apply: 各占一行',
    actual: entryText ? `Why=${/^Why[:：]/m.test(entryText)} HowToApply=${/^How to apply[:：]/m.test(entryText)}` : '(文件缺失)',
  })
  ev.attach('entry-file', entryText.slice(0, 2_000))

  const indexFile = path.join(projectsDir, slug, 'MEMORY.md')
  const indexText = readText(indexFile)
  const expectedIndexLine = `- [${ENTRY_NAME}](${ENTRY_NAME}.md) — ${ENTRY_DESC}`
  ev.assert('C7: 对应 scope 的 MEMORY.md 索引行落盘（写入入口写后重建索引）', indexText.includes(expectedIndexLine), {
    channel: 'C',
    expected: expectedIndexLine,
    actual: indexText.split('\n').filter((l) => l.includes(ENTRY_NAME)).join(' | ') || '(索引行未找到)',
  })
  ev.assert('C8: 统一入口 scope 判定——条目只落项目级，user 级 facts/ 无该条目', !fs.existsSync(path.join(userFactsDir, `${ENTRY_NAME}.md`)), {
    channel: 'C',
    expected: `user 级 ${ENTRY_NAME}.md 不存在（type=project 强制项目级）`,
    actual: fs.existsSync(path.join(userFactsDir, `${ENTRY_NAME}.md`)) ? 'user 级意外出现同名条目' : '不存在（scope 判定正确）',
  })
  ev.step({ step: 'memory.disk.turn1', channel: 'C', exitCode: indexText.includes(expectedIndexLine) ? 0 : 1, stats: { indexFile } })

  // 快照（回合 2 的不变量基线：条目文件集 + 索引全文）
  const listMd = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [])
  const snapshotFn = () => ({
    projectFacts: listMd(path.join(projectsDir, slug, 'facts')),
    userFacts: listMd(userFactsDir),
    indexText: readText(indexFile),
    userIndexText: readText(path.join(userFactsDir, '..', 'MEMORY.md')),
  })
  const snapshot1 = await waitDiskStable(snapshotFn)

  // ── 5. 回合 2（不该记的）：纯代码结构问题 ──────────────────────────────────
  since = protocol.events.length
  await protocol.send(sid, `项目里的 ${Q2_MARK} 类定义在哪个文件，它的继承结构是怎样的`)
  end = await protocol.waitTurnEnd(sid, { since, timeoutMs: TURN_BUDGET_MS })
  const turn2Ok = end.type === 'message.complete' && end.ok
  ev.assert('D1: 回合 2 主回合正常完成（message.complete 非 error）', turn2Ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: 'chat.send.turn2', channel: 'B', exitCode: turn2Ok ? 0 : 1, stats: { sessionId: sid } })

  const reqsAfter2 = await waitMockRequests(instance, MAIN_MODEL, 4, 30_000, '回合2主回合+提炼')
  ev.assert('D2: 回合 2 链条恰好再消耗 2 步（累计 4：无第三方插队、无重复提炼）', reqsAfter2.length === 4, {
    channel: 'C',
    expected: '恰好 4 个 200 请求（step0..3）',
    actual: `count=${reqsAfter2.length} steps=${reqsAfter2.map((r) => r.stepIndex).join(',')}`,
  })

  const extracts2 = extractRequests(instance, MAIN_MODEL)
  const extract2 = extracts2[1] ?? null
  ev.assert('D3: 双发去重跨回合成立——提炼请求总计恰好 2 个（每回合 1 次）', extracts2.length === 2, {
    channel: 'C',
    expected: '提炼请求总计 2 个',
    actual: `count=${extracts2.length} steps=${extracts2.map((r) => r.stepIndex).join(',')}`,
  })
  ev.assert('D4: 回合 2 提炼步消费 step3（步序对位）', extract2?.stepIndex === 3, {
    channel: 'C',
    expected: '回合 2 提炼请求 stepIndex=3',
    actual: `stepIndex=${extract2?.stepIndex ?? '<缺>'}`,
  })
  ev.assert('D5: 回合 2 提炼素材含 RouterMiddleware（素材覆盖该回合正文，skip 判定输入真实）', extract2 ? requestFullText(extract2).includes(Q2_MARK) : false, {
    channel: 'C',
    expected: `提炼请求含 ${Q2_MARK}`,
    actual: extract2 ? `hit=${requestFullText(extract2).includes(Q2_MARK)}` : '(无第二提炼请求)',
  })
  ev.assert('D6: 回合 2 提炼 system 的 manifest 含回合 1 条目（既有条目清单作为去重参照进提示词）', extract2 ? requestFullText(extract2).includes(ENTRY_NAME) : false, {
    channel: 'C',
    expected: `system manifest 段含 ${ENTRY_NAME}`,
    actual: extract2 ? `hit=${requestFullText(extract2).includes(ENTRY_NAME)}` : '(无第二提炼请求)',
  })
  ev.attach('extract-request-2', extract2 ? JSON.stringify({ stepIndex: extract2.stepIndex, messageCount: extract2.messageCount, summary: extract2.summary }, null, 2) : '(无)')

  // 回合 2 主回合请求（step2）含回合 1 条目的注入块——「写入 → 索引 → 注入」下游消费闭环
  const mainReq2 = (instance.mockLlm?.requests ?? []).find((r) => r.status === 200 && (r.model === MAIN_MODEL || r.model?.endsWith(`/${MAIN_MODEL}`)) && r.stepIndex === 2)
  const block2 = mainReq2 ? (JSON.stringify(mainReq2.messages).match(/\\{0,2}<memory-context>[\s\S]*?\\{0,2}<\/memory-context>/)?.[0] ?? null) : null
  ev.assert('F1: 成功链下游消费——回合 2 主回合请求含记忆注入块且内含回合 1 条目', block2 !== null && block2.includes(ENTRY_NAME), {
    channel: 'B',
    expected: `<memory-context> 块存在且含 ${ENTRY_NAME}`,
    actual: block2 ? (block2.includes(ENTRY_NAME) ? '块存在且含条目行' : '块存在但无条目行') : '无注入块',
  })

  // ── 6. skip 零写入不变量（D 组磁盘断言；先等磁盘稳定再对比快照）────────────
  const snapshot2 = await waitDiskStable(snapshotFn)
  ev.assert('D7: 无新条目文件（项目级与 user 级 facts 均无新增——mock skip 被正确消费为不写入）', JSON.stringify(snapshot2.projectFacts) === JSON.stringify(snapshot1.projectFacts) && JSON.stringify(snapshot2.userFacts) === JSON.stringify(snapshot1.userFacts), {
    channel: 'C',
    expected: `facts 清单不变（project=${JSON.stringify(snapshot1.projectFacts)} user=${JSON.stringify(snapshot1.userFacts)}）`,
    actual: `project=${JSON.stringify(snapshot2.projectFacts)} user=${JSON.stringify(snapshot2.userFacts)}`,
  })
  ev.assert('D8: 索引行不变（MEMORY.md 全文与回合 1 落盘后一致）', snapshot2.indexText === snapshot1.indexText && snapshot2.userIndexText === snapshot1.userIndexText, {
    channel: 'C',
    expected: '两级索引全文不变',
    actual: `projectIndex ${snapshot2.indexText === snapshot1.indexText ? '一致' : '变化'} userIndex ${snapshot2.userIndexText === snapshot1.userIndexText ? '一致' : '变化'}`,
  })
  ev.step({ step: 'memory.disk.turn2', channel: 'C', exitCode: snapshot2.indexText === snapshot1.indexText ? 0 : 1, stats: { projectFacts: snapshot2.projectFacts } })

  // ── 7. 成功链行为面（E 组：日志无放弃 + 会话历史完整）───────────────────────
  const memLog = readMemoryLog(dataDir)
  ev.assert('E1: memory 日志无「turn extraction gave up」放弃标记（两回合提炼均走成功路径）', !memLog.includes(GAVE_UP_MARK), {
    channel: 'C',
    expected: `不含「${GAVE_UP_MARK}」`,
    actual: memLog.includes(GAVE_UP_MARK) ? memLog.split('\n').filter((l) => l.includes(GAVE_UP_MARK)).slice(0, 3).join(' ⏎ ') : '干净',
  })
  ev.attach('memory-log-tail', memLog.slice(-4_000))

  const hist = await protocol.history(sid, { limitTurns: 10 })
  const histText = JSON.stringify(hist)
  ev.assert('E2: 会话历史完整（两回合 mock 演员回复在场——主回合功能面未被提炼链破坏）', histText.includes('之后都用中文回复') && histText.includes('查一下项目结构再答复'), {
    channel: 'B',
    expected: '含回合 1 与回合 2 演员回复文本',
    actual: `turn1=${histText.includes('之后都用中文回复')} turn2=${histText.includes('查一下项目结构再答复')}`,
  })

  log(`done sid=${sid} extracts=${extracts2.length} entry=${fs.existsSync(entryFile)}`)
  return { uncovered: [], gotchas }
}
