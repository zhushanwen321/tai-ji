/**
 * memory-explicit-cross-session —— 显式记忆跨会话注入 + 故障降级（memory-system 设计 §4 V1 + V6，A1）。
 *
 * 判据原文（设计文档 V1 行 + V6 行）：
 *   V1「会话 A 说『记住：这个仓库统一用 pnpm，禁用 npm』→ ① memory_save 工具调用与回执；
 *      ② agentDir/memory/projects/<slug>/facts/ 下新条目文件与 MEMORY.md 索引行；③ 新会话 B 提问，
 *      B 的请求载荷里含索引块（context 注入，带边界标记）」——条目文件含 frontmatter
 *      （type: project、originSessionId 为会话 A 的 id、origin: explicit）。
 *   V6「索引文件被人为破坏后正常对话：对话正常完成（AX2）——注入降级为不注入或按可解析
 *      部分注入；不向用户抛错」。
 *   另验 system-prompt 共存：memory 工具静态提示（promptSnippet）与注入块在同一请求并存。
 *
 * 装配：mock-http（createInstance llm 通道）。faux core 实测无请求载荷捕获面
 * （createFauxCore 返回 api/provider/models/stream/streamSimple/fetchDeferred/cancelDeferred/
 * getModel/state/setResponses/appendResponses/getPendingResponseCount，无 requests），
 * 断言「B 的请求载荷含注入块」改以 instance.mockLlm.requests 的全量 messages 为铁证面
 * （verify-taiji SKILL.md §1.1b 明示语义）。
 *
 * 游标纪律（mock-http README 坑 2）：三个会话各绑独立模型（mem-a1/mem-b1/mem-c1），
 * per-model 游标互不串扰。会话 A 的 memory_save 回合被 turn_end 提炼跳过门拦截
 * （toolResults 含 memory_save → already-saved，不消耗队列）；会话 B/C 的提问回合会触发
 * 后台提炼打到各自模型队列——队列按主回合精确编排，提炼命中耗尽 404 → warn 放弃，
 * 无写入无副作用（AX2），断言只认 status 200 的主回合请求。
 *
 * 断言聚焦 V1/V6 criteria：①条目 frontmatter（type/origin/originSessionId=sidA）②索引行
 * 落盘 ③B 主回合请求含注入块（<memory-context> 边界标记 + prefer-pnpm 条目行）④system
 * 提示共存 ⑤破坏索引后对话正常完成、注入降级、无异常。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROVIDER = 'mockllm'
const MODEL_A = 'mem-a1'
const MODEL_B = 'mem-b1'
const MODEL_C = 'mem-c1'

// ── mock 演员（model-keyed；请求体 model 是裸 id，key 用裸 id） ──────────────────
const responses = {
  [MODEL_A]: [
    {
      text: '好的，我来保存这条记忆：',
      toolCalls: [
        {
          name: 'memory_save',
          args: {
            name: 'prefer-pnpm',
            description: '本仓库统一用 pnpm，禁用 npm',
            type: 'project',
            content:
              '本仓库包管理器统一使用 pnpm，禁止使用 npm。\nWhy: 团队约定与 lockfile 一致性要求。\nHow to apply: 安装依赖一律用 pnpm add / pnpm install，禁用 npm install。',
          },
        },
      ],
      stopReason: 'toolUse',
    },
    { text: '已记住：这个仓库统一用 pnpm，禁用 npm。', stopReason: 'stop' },
  ],
  [MODEL_B]: [{ text: '好的，用 pnpm add <package> 安装依赖。', stopReason: 'stop' }],
  [MODEL_C]: [{ text: '好的，我已按项目当前状态处理。', stopReason: 'stop' }],
}

export const meta = {
  id: 'memory-explicit-cross-session',
  priority: 'P0',
  title: 'V1 显式记忆跨会话：memory_save 落盘 → 新会话请求载荷含索引注入块；V6 索引破坏后对话正常',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'session.history', 'chat.send', 'chat.wait'],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: MODEL_A,
    subModel: MODEL_A,
    models: [MODEL_A, MODEL_B, MODEL_C],
  },
  estimateSec: 300,
  provable: [
    'V1① 会话 A 的 memory_save 工具调用被真实执行（B 通道 toolUse 步消费 + 回执文本进会话历史）',
    'V1② C 通道磁盘：agentDir/memory/projects/<slug>/facts/prefer-pnpm.md 落盘，frontmatter type: project / origin: explicit / originSessionId=会话 A id；MEMORY.md 索引行含 prefer-pnpm',
    'V1③ 会话 B 主回合 LLM 请求载荷含记忆索引注入块（<memory-context>…</memory-context> 边界标记 + prefer-pnpm 条目行）——mock server 请求留档为铁证',
    'system-prompt 共存：同一请求中 memory 工具静态提示（promptSnippet）与注入块并存',
    'V6 破坏项目索引（乱写全非法内容）后：新会话对话正常完成（message.complete + stop）、请求不含注入块（降级为不注入）、无异常抛出',
  ],
  notProvable: [
    'V1 判据「模型回复执行 pnpm 而非 npm」的行为语义半边：mock 演员只会吐剧本步，模型行为质量不可断言（mock-http 通道固有边界）——本剧本以请求载荷含 pnpm 条目证明记忆可达模型',
    '「关闭会话 A，打开会话 B」的 UI 会话切换半边：本剧本走协议形态建第二会话（同一用户路径语义：新会话新 pi 进程，跨会话记忆经磁盘传递）',
    'V6「按可解析部分注入」形态：本剧本破坏形态为全非法内容（降级为不注入）；部分可解析形态由 inject 单测覆盖',
    '/memory list 可看到库状态（V6 criteria 尾项，治理命令域——归治理剧本）',
  ],
}

/** 从请求 messages（JSON 序列化后）提取注入块文本；无块返回 null。 */
function extractMemoryBlock(messages) {
  const text = JSON.stringify(messages)
  const m = text.match(/\\{0,2}<memory-context>[\s\S]*?\\{0,2}<\/memory-context>/)
  return m ? m[0] : null
}

/** 提取请求全部消息文本（含 system；判 promptSnippet 共存用）。 */
function messagesText(messages) {
  return JSON.stringify(messages)
}

/** 从条目文件文本解析 frontmatter 标量与 metadata 缩进键（最小解析，够断言用）。 */
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

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const gotchas = [
    'faux 通道无请求载荷捕获面（createFauxCore 实测无 requests 导出）——载荷断言必须走 mock-http 通道',
    '会话 B/C 的提问回合会触发后台回合提炼打到各自模型队列（无 memory_save + 正文 ≥3 词）；队列按主回合编排后提炼命中耗尽 404 → warn 放弃，无写入，断言只认 status 200 请求',
    '注入块不落会话历史（SC4：生命周期等于单次请求）——history 里看不到注入块是设计内行为，载荷断言只能看 mock requests',
  ]

  const agentDir = path.join(dataDir, 'agent')
  const memoryDir = path.join(agentDir, 'memory')

  // ── 0. fixture 项目目录（git init 独立仓 → slug 唯一） ──────────
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-v1-fixture-'))
  execFileSync('git', ['init', '-q', fixture], { timeout: 15_000 })
  ev.step({ step: 'fixture.init', command: `git init ${fixture}`, exitCode: 0, stats: { fixture } })

  try {
    // ── 1. 会话 A：显式保存记忆 ──────────────────────────────────
    const createA = await protocol.call(
      'session.create',
      { cwd: fixture, label: 'mem-v1-a', modelOverride: `${PROVIDER}/${MODEL_A}` },
      { timeoutMs: 120_000 },
    )
    const sidA = createA.session?.id
    ev.assert('B: 会话 A 创建（cwd=fixture git 仓）', Boolean(sidA) && createA.session?.cwd === fixture, {
      channel: 'B',
      expected: `sid 非空且 cwd=${fixture}`,
      actual: `sid=${sidA} cwd=${createA.session?.cwd}`,
    })
    log(`会话 A = ${sidA}`)

    await protocol.subscribe(sidA)
    const sinceA = protocol.events.length
    await protocol.send(sidA, '记住：这个仓库统一用 pnpm，禁用 npm')
    ev.step({ step: 'chat.send.A', exitCode: 0, stats: { sessionId: sidA } })
    const endA = await protocol.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 180_000 })
    ev.assert('B: 会话 A turn 正常完成（memory_save 调用 + 回执）', endA.type === 'message.complete' && endA.ok, {
      channel: 'B',
      expected: 'message.complete + stopReason≠error',
      actual: `${endA.type} stopReason=${endA.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.wait.A', exitCode: endA.ok ? 0 : 1, stats: { type: endA.type, stopReason: endA.payload?.stopReason } })

    // V1① 工具回执进会话历史（memory_save 的 Saved 回执文本；组合子串避免 JSON 转义引号歧义）
    const histA = await protocol.history(sidA, { limitTurns: 10 })
    const histAText = JSON.stringify(histA)
    ev.assert(
      'B: V1① memory_save 回执进会话历史（Saved memory + project scope）',
      histAText.includes('Saved memory') && histAText.includes('(project, project scope)'),
      {
        channel: 'B',
        expected: '含 Saved memory 与 (project, project scope) 回执文本',
        actual: `saved=${histAText.includes('Saved memory')} scope=${histAText.includes('(project, project scope)')}`,
      },
    )
    // B 通道铁证：mock 收到会话 A 的两步请求（toolUse 步 + 收尾文本步均消费）
    const reqsA = instance.mockLlm.requests.filter((r) => r.model === MODEL_A && r.status === 200)
    ev.assert('B: 会话 A 演员两步均打到 mock（toolUse + 收尾）', reqsA.length >= 2, {
      channel: 'B',
      expected: '≥2 个 200 请求',
      actual: `count=${reqsA.length}`,
    })
    ev.attach('mock-requests-A', JSON.stringify(reqsA.map((r) => ({ model: r.model, stepIndex: r.stepIndex, messageCount: r.messageCount })), null, 2))

    // ── 2. C 通道：条目落盘 + frontmatter + 索引行（V1②） ────────
    const projectsDir = path.join(memoryDir, 'projects')
    const slugs = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []
    ev.assert('C: 项目 scope 目录生成（fixture git 仓 slug）', slugs.length === 1, {
      channel: 'C',
      expected: 'projects/ 下恰 1 个 slug',
      actual: `slugs=${slugs.join(',')}`,
    })
    const slug = slugs[0]
    const entryFile = path.join(projectsDir, slug, 'facts', 'prefer-pnpm.md')
    const entryExists = fs.existsSync(entryFile)
    ev.assert('C: V1② 条目文件落盘 projects/<slug>/facts/prefer-pnpm.md', entryExists, {
      channel: 'C',
      expected: entryFile,
      actual: entryExists ? '存在' : '不存在',
    })

    let frontmatterOk = false
    let fmActual = ''
    if (entryExists) {
      const entryText = fs.readFileSync(entryFile, 'utf8')
      const fm = parseFrontmatter(entryText)
      frontmatterOk =
        fm !== null &&
        fm.top['type'] === 'project' &&
        fm.metadata['origin'] === 'explicit' &&
        fm.metadata['originSessionId'] === sidA
      fmActual = fm ? `type=${fm.top['type']} origin=${fm.metadata['origin']} originSessionId=${fm.metadata['originSessionId']}` : 'frontmatter 解析失败'
      ev.attach('entry-file', entryText)
      // 正文含 Why / How to apply（project 类型格式校验过的落盘形态）
      ev.assert('C: 条目正文含 Why 与 How to apply 行', /^Why[:：]/m.test(entryText) && /^How to apply[:：]/m.test(entryText), {
        channel: 'C',
        expected: 'Why: 与 How to apply: 各占一行',
        actual: `Why=${/^Why[:：]/m.test(entryText)} HowToApply=${/^How to apply[:：]/m.test(entryText)}`,
      })
    }
    ev.assert('C: V1② frontmatter（type: project / origin: explicit / originSessionId=会话 A id）', frontmatterOk, {
      channel: 'C',
      expected: `type=project origin=explicit originSessionId=${sidA}`,
      actual: fmActual,
    })

    const indexFile = path.join(projectsDir, slug, 'MEMORY.md')
    const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : ''
    ev.assert('C: V1② 索引行落盘（MEMORY.md 含 prefer-pnpm 行）', indexText.includes('- [prefer-pnpm](prefer-pnpm.md) — 本仓库统一用 pnpm，禁用 npm'), {
      channel: 'C',
      expected: '- [prefer-pnpm](prefer-pnpm.md) — 本仓库统一用 pnpm，禁用 npm',
      actual: indexText.split('\n').filter((l) => l.includes('prefer-pnpm')).join('|') || '未找到',
    })
    ev.step({ step: 'evidence.disk.A', channel: 'C', exitCode: 0, stats: { slug, entryFile, indexFile } })

    // ── 3. 会话 B：跨会话注入（V1③ + 边界标记 + system-prompt 共存） ──
    const createB = await protocol.call(
      'session.create',
      { cwd: fixture, label: 'mem-v1-b', modelOverride: `${PROVIDER}/${MODEL_B}` },
      { timeoutMs: 120_000 },
    )
    const sidB = createB.session?.id
    ev.assert('B: 会话 B 创建（≠A，同 cwd 跨会话）', Boolean(sidB) && sidB !== sidA, {
      channel: 'B',
      expected: 'sidB 非空且 ≠ sidA',
      actual: `sidB=${sidB}`,
    })
    log(`会话 B = ${sidB}`)
    await protocol.subscribe(sidB)
    const sinceB = protocol.events.length
    await protocol.send(sidB, '帮我装个依赖')
    ev.step({ step: 'chat.send.B', exitCode: 0, stats: { sessionId: sidB } })
    const endB = await protocol.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 180_000 })
    ev.assert('B: 会话 B turn 正常完成', endB.type === 'message.complete' && endB.ok, {
      channel: 'B',
      expected: 'message.complete',
      actual: `${endB.type} stopReason=${endB.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.wait.B', exitCode: endB.ok ? 0 : 1, stats: { type: endB.type } })

    // 主回合请求 = 该模型首个 200 请求（stepIndex 0）
    const mainReqB = instance.mockLlm.requests.find((r) => r.model === MODEL_B && r.status === 200 && r.stepIndex === 0)
    ev.assert('B: 会话 B 主回合请求已捕获（mock 铁证面）', Boolean(mainReqB), {
      channel: 'B',
      expected: 'mem-b1 的 200/step0 请求',
      actual: `requests=${instance.mockLlm.requests.filter((r) => r.model === MODEL_B).length}`,
    })
    if (mainReqB) {
      const block = extractMemoryBlock(mainReqB.messages)
      ev.assert('B: V1③ 会话 B 请求载荷含记忆索引注入块', block !== null, {
        channel: 'B',
        expected: '<memory-context>…</memory-context> 块存在',
        actual: block ? `块长度=${block.length}` : '未找到注入块',
      })
      ev.assert('B: V1③ 注入块边界标记完整（<memory-context> 与 </memory-context>）', block !== null && block.includes('<memory-context>') && block.includes('</memory-context>'), {
        channel: 'B',
        expected: '首尾定界标签均在块内',
        actual: block ? 'start=有 end=有' : '无块',
      })
      ev.assert('B: V1③ 注入块含 prefer-pnpm 条目行（跨会话记忆可达模型）', block !== null && block.includes('prefer-pnpm'), {
        channel: 'B',
        expected: '块内含 prefer-pnpm',
        actual: block ? (block.includes('prefer-pnpm') ? '含' : '不含') : '无块',
      })
      ev.assert('B: 注入块含边界声明（历史记忆非当前指令，AX6）', block !== null && block.includes('以下为历史记忆'), {
        channel: 'B',
        expected: '块首边界声明在场',
        actual: block ? (block.includes('以下为历史记忆') ? '在' : '缺') : '无块',
      })
      // system-prompt 共存：memory 工具静态提示与注入块同一请求并存
      const textB = messagesText(mainReqB.messages)
      ev.assert('B: system-prompt 共存（memory 工具 promptSnippet 与注入块同请求）', textB.includes('Persistent memory across sessions') && block !== null, {
        channel: 'B',
        expected: 'promptSnippet 常驻 + 注入块并存',
        actual: `snippet=${textB.includes('Persistent memory across sessions')} block=${block !== null}`,
      })
      // 注入块位于消息流头部（历史记忆先于对话历史）
      const firstUser = (mainReqB.messages ?? []).find((m) => m?.role === 'user')
      const firstUserHasBlock = firstUser ? JSON.stringify(firstUser).includes('<memory-context>') : false
      ev.assert('B: 注入块置于请求消息流头部 user 消息', firstUserHasBlock, {
        channel: 'B',
        expected: '首条 user 消息含 <memory-context>',
        actual: firstUserHasBlock ? '是' : '否',
      })
      ev.attach('request-B-messages-head', JSON.stringify((mainReqB.messages ?? []).slice(0, 2), null, 2).slice(0, 8_000))
    }

    // ── 4. V6 故障注入：破坏项目索引 → 对话正常 + 注入降级 ────────
    const corrupt = '### THIS INDEX IS CORRUPTED BY VERIFICATION ###\n不是合法索引行，无条目链接形态\nrandom garbage {{ no-pattern\n'
    fs.writeFileSync(indexFile, corrupt, 'utf8')
    ev.step({ step: 'fault.corrupt-index', command: `writeFileSync ${indexFile} <garbage>`, exitCode: 0, stats: { bytes: corrupt.length } })
    log('已破坏项目索引 MEMORY.md（全非法行）')

    const createC = await protocol.call(
      'session.create',
      { cwd: fixture, label: 'mem-v1-c', modelOverride: `${PROVIDER}/${MODEL_C}` },
      { timeoutMs: 120_000 },
    )
    const sidC = createC.session?.id
    ev.assert('B: 会话 C 创建（V6 故障注入段）', Boolean(sidC), {
      channel: 'B',
      expected: 'sidC 非空',
      actual: `sidC=${sidC}`,
    })
    log(`会话 C = ${sidC}`)
    await protocol.subscribe(sidC)
    const sinceC = protocol.events.length
    await protocol.send(sidC, '帮我看看这个项目的构建方式')
    ev.step({ step: 'chat.send.C', exitCode: 0, stats: { sessionId: sidC } })
    const endC = await protocol.waitTurnEnd(sidC, { since: sinceC, timeoutMs: 180_000 })
    ev.assert('B: V6 破坏索引后对话正常完成（AX2）', endC.type === 'message.complete' && endC.ok, {
      channel: 'B',
      expected: 'message.complete + stopReason≠error',
      actual: `${endC.type} stopReason=${endC.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.wait.C', exitCode: endC.ok ? 0 : 1, stats: { type: endC.type, stopReason: endC.payload?.stopReason } })

    const mainReqC = instance.mockLlm.requests.find((r) => r.model === MODEL_C && r.status === 200 && r.stepIndex === 0)
    ev.assert('B: 会话 C 主回合请求已捕获', Boolean(mainReqC), {
      channel: 'B',
      expected: 'mem-c1 的 200/step0 请求',
      actual: `requests=${instance.mockLlm.requests.filter((r) => r.model === MODEL_C).length}`,
    })
    if (mainReqC) {
      const blockC = extractMemoryBlock(mainReqC.messages)
      ev.assert('B: V6 注入降级为不注入（全非法索引 → 请求不含注入块）', blockC === null, {
        channel: 'B',
        expected: '无 <memory-context> 块',
        actual: blockC ? `意外存在块：${blockC.slice(0, 120)}` : '无块（降级成立）',
      })
    }

    // 降级日志核验（V6 criteria「日志有降级记录」）：全量收集 memory 扩展文件日志、
    // pi 会话日志、会话 C 树内 session entries（appendEntry 的 memory:log warn 落点）
    // 中与「注入跳过/降级」相关的行，据实呈现。命中模式收紧为注入域原文
    // （inject handler warn 原文 = "memory index injection skipped"），防提炼域
    // 日志（turn extraction skipped/gave up——turn_end 提炼跳过门与 404 放弃，见
    // 文件头）误命中。实测结果记 gotcha：无命中 = 设计 V6「日志有降级记录」与实装
    // 差距（parseIndexFile 静默容错路径无日志语句），登记 blocker 由验收修复循环处置。
    const logsDir = path.join(agentDir, 'logs')
    let memLogText = ''
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir)) {
        if (f.startsWith('memory-') && f.endsWith('.log')) memLogText += fs.readFileSync(path.join(logsDir, f), 'utf8')
      }
    }
    ev.attach('memory-ext-log', memLogText.slice(-8_000) || '(空——无 memory-*.log 或无内容)')
    const sessionTreeC = path.join(dataDir, 'ext-sessions', sidC)
    const collectFiles = (root) => {
      const out = []
      if (!fs.existsSync(root)) return out
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else out.push(p)
        }
      }
      walk(root)
      return out
    }
    const evidenceFiles = [
      ...collectFiles(sessionTreeC),
      ...collectFiles(path.join(dataDir, 'ext-sessions'))
        .filter((p) => p.includes(`${path.sep}logs${path.sep}`) && path.basename(p).startsWith('pi-')),
    ]
    let evidenceText = ''
    for (const f of evidenceFiles) {
      try {
        evidenceText += `${fs.readFileSync(f, 'utf8')}\n`
      } catch {
        /* 单文件读失败不阻塞 */
      }
    }
    const injectionDegradedLines = [
      // 通道 1：文件日志 warn 原文（inject handler 的 logger.warn 原样）
      ...memLogText.split('\n').filter((l) => l.includes('memory index injection skipped')).map((l) => `[file-log] ${l.slice(0, 400)}`),
      // 通道 2：appendEntry 落 session 树的 memory:log warn（customType 精确匹配，防 system-prompt 长行英文误命中）
      ...evidenceText.split('\n').filter((l) => l.includes('"memory:log"') && /injection|注入/.test(l)).map((l) => `[entry] ${l.slice(0, 400)}`),
    ]
    ev.attach('v6-injection-degraded-log-lines', injectionDegradedLines.length > 0 ? injectionDegradedLines.join('\n') : '(无命中——注入降级无日志行)')
    if (injectionDegradedLines.length === 0) {
      gotchas.push(
        'V6 criteria「日志有降级记录」与实装差距：破坏索引（全非法内容）后实测无注入降级日志行——parseIndexFile 走静默容错（不可解析行跳过，无日志语句），inject handler 的 warn 仅覆盖异常路径；对话正常/降级不注入/无异常三项 criteria 断言通过，日志项登记 blocker 交验收修复循环',
      )
    }

    // 会话 C 历史正常（回复文本在场 = 对话功能面完整）
    const histC = await protocol.history(sidC, { limitTurns: 10 })
    const histCText = JSON.stringify(histC)
    ev.assert('B: V6 会话 C 历史完整（assistant 回复在场）', histCText.includes('已按项目当前状态处理'), {
      channel: 'B',
      expected: '含 mem-c1 演员回复文本',
      actual: histCText.includes('已按项目当前状态处理') ? '在' : '缺',
    })
    ev.attach('pi-log-tail', evidenceText.split('\n').slice(-40).map((l) => (l.length > 800 ? `${l.slice(0, 800)}…[truncated]` : l)).join('\n'))

    return { uncovered: [], gotchas }
  } finally {
    // fixture 清理（临时 git 仓，不留 worktree）
    try {
      fs.rmSync(fixture, { recursive: true, force: true })
      ev.step({ step: 'fixture.cleanup', command: `rm -rf ${fixture}`, exitCode: 0, stats: { cleaned: true } })
    } catch (e) {
      ev.step({ step: 'fixture.cleanup', exitCode: 1, stats: { error: String(e) } })
    }
  }
}
