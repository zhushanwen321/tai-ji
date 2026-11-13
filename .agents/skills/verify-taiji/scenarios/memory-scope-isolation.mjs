/**
 * memory-scope-isolation —— 两级 scope 项目隔离 + 跨 scope 写拒绝（memory-system 设计 §4 V4，A4）。
 *
 * 判据原文（设计文档 V4 行）：
 *   「① 项目甲会话存『构建前必须跑 codegen』（type: project）；② 项目乙会话问
 *    『这个项目有什么要注意的』；③ 检查注入的索引块只含项目乙与全局内容」——
 *   项目甲条目不进项目乙的注入；用户级条目（如『回复用中文』）两级都注入；
 *   type: project 写入用户级目录被拒绝（工具回执提示正确 scope）。
 *
 * 装配：mock-http（createInstance llm 通道）。断言面 = instance.mockLlm.requests 的
 * 全量 messages（注入块唯一可观测铁证面——注入块不落会话历史，SC4 生命周期等于
 * 单次请求）。
 *
 * 结构（每会话单 turn + 独立模型）：同模型队列游标被完成通知轮与后台回合提炼竞争
 * 消耗（memory-explicit-cross-session 剧本实测：turn 完成后 triggerTurn 通知轮与
 * turn_end 提炼均打 mock）。本剧本每个逻辑操作一个独立会话 + 专属模型 + 队列只含
 * 本 turn 主步——每会话首个 200 请求必为主回合首调用（会话首调用无竞争者），
 * turn 后的 404 消耗（通知轮/提炼）落在队列耗尽上，无害（AX2）。
 *
 * 断言聚焦 V4 criteria：①两 fixture git 仓 slug 不同 ②注入块只含本项目+全局
 * （甲/乙双向互验）③type: project 写用户级被拒（回执含拒绝原因与正确 scope 提示
 * + 双 scope 磁盘均未落盘）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROVIDER = 'mockllm'

// 每会话独立模型（队列零竞争，见文件头）
const M = {
  a1: 'mem-iso-a1', // 甲·存项目记忆
  a2: 'mem-iso-a2', // 甲·存用户级记忆
  a3: 'mem-iso-a3', // 甲·提问（注入块甲视角）
  b1: 'mem-iso-b1', // 乙·存项目记忆
  b2: 'mem-iso-b2', // 乙·提问（注入块乙视角）
  c1: 'mem-iso-c1', // 乙·跨 scope 写拒绝
}
const ALL_MODELS = Object.values(M)

const saveStep = (name, description, type, content, scope) => ({
  text: '好的，我来保存：',
  toolCalls: [{ name: 'memory_save', args: scope ? { name, description, type, content, scope } : { name, description, type, content } }],
  stopReason: 'toolUse',
})
const ackStep = (text) => ({ text, stopReason: 'stop' })

const responses = {
  [M.a1]: [
    saveStep(
      'run-codegen-before-build',
      '构建前必须跑 codegen',
      'project',
      '本项目构建前必须先运行 codegen 生成代码。\nWhy: 手写生成物与 schema 会漂移。\nHow to apply: 执行构建前先跑 pnpm codegen。',
    ),
    ackStep('已保存项目记忆：构建前必须跑 codegen。'),
  ],
  [M.a2]: [
    saveStep('reply-in-chinese', '回复用中文', 'user', '用户要求所有回复使用中文。'),
    ackStep('已保存用户偏好：回复用中文。'),
  ],
  [M.a3]: [ackStep('按项目记忆处理：构建前先跑 codegen。')],
  [M.b1]: [
    saveStep(
      'use-vite-dev-server',
      '本项目开发服务器用 vite',
      'project',
      '本项目开发服务器统一使用 vite。\nWhy: 构建链统一与 HMR 速度。\nHow to apply: 本地起服务用 vite dev。',
    ),
    ackStep('已保存项目记忆：开发服务器用 vite。'),
  ],
  [M.b2]: [ackStep('按记忆索引回答：开发服务器用 vite，回复用中文。')],
  [M.c1]: [
    saveStep(
      'try-wrong-scope',
      '试探跨 scope 写入的条目',
      'project',
      '这条项目记忆试图写入用户全局。\nWhy: 验证写入入口的 type 与 scope 强校验。\nHow to apply: 不应被接受。',
      'user',
    ),
    ackStep('保存被拒绝了：project 类型只能写入 project scope。'),
  ],
}

export const meta = {
  id: 'memory-scope-isolation',
  priority: 'P0',
  title: 'V4 两级 scope 隔离：项目甲/乙条目互不串注入 + 用户级两级都注入 + type:project 写用户级被拒',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'session.history', 'chat.send', 'chat.wait'],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: M.a1,
    subModel: M.a1,
    models: ALL_MODELS,
  },
  estimateSec: 360,
  provable: [
    'V4① 两个独立 fixture git 仓派生不同项目 slug（C 通道：agentDir/memory/projects/ 下两 slug 且不同）',
    'V4② 项目甲条目（run-codegen-before-build）不进项目乙会话的注入块；项目乙条目（use-vite-dev-server）不进项目甲会话的注入块（双向互验，mock 请求载荷铁证）',
    'V4② 用户级条目（reply-in-chinese）两级注入：甲、乙两个项目的会话注入块都含它',
    'V4③ type: project 写用户级目录被拒：memory_save(type=project, scope=user) 工具回执含拒绝原因与正确 scope 提示（写入入口 type↔scope 强校验）',
    'V4③ 被拒条目不落盘：用户级 facts/ 与项目级 facts/ 均无 try-wrong-scope.md（C 通道）',
  ],
  notProvable: [
    '「项目乙会话问『这个项目有什么要注意的』」的 UI 交互半边：本剧本走协议形态建会话提问（同一用户路径语义）',
    '被拒回执中 hint 字段（"将 scope 参数改为…"）是否随 pi 工具错误转换进入模型上下文：断言口径为回执 message（含正确 scope 提示），hint 形态属 pi 错误转换细节',
    '真实模型对拒绝回执的理解与纠正行为（mock 演员只会吐剧本步）',
  ],
}

/** 从请求 messages（JSON 序列化后）提取注入块文本；无块返回 null。 */
function extractMemoryBlock(messages) {
  const text = JSON.stringify(messages)
  const m = text.match(/\\{0,2}<memory-context>[\s\S]*?\\{0,2}<\/memory-context>/)
  return m ? m[0] : null
}

/** 建会话 + 单 turn 发消息 + 等 turn 结束；返回 { sid, end }。 */
async function singleTurnSession(protocol, ev, { cwd, label, model, text, stepName }) {
  const created = await protocol.call(
    'session.create',
    { cwd, label, modelOverride: `${PROVIDER}/${model}` },
    { timeoutMs: 120_000 },
  )
  const sid = created.session?.id
  ev.assert(`B: 会话建立（${label}，cwd=${path.basename(cwd)}）`, Boolean(sid) && created.session?.cwd === cwd, {
    channel: 'B',
    expected: `sid 非空且 cwd=${cwd}`,
    actual: `sid=${sid} cwd=${created.session?.cwd}`,
  })
  await protocol.subscribe(sid)
  const since = protocol.events.length
  await protocol.send(sid, text)
  const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert(`B: ${label} turn 正常完成`, end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: stepName, exitCode: end.ok ? 0 : 1, stats: { sessionId: sid, model, type: end.type } })
  return { sid, end }
}

/** 取指定模型首个 200 请求（= 该会话主回合首调用，见文件头零竞争论证）。 */
function firstMainRequest(instance, model) {
  return instance.mockLlm.requests.find((r) => r.model === model && r.status === 200 && r.stepIndex === 0)
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const gotchas = [
    '同模型队列游标会被完成通知轮与后台回合提炼竞争消耗（memory-explicit-cross-session 实测）——本剧本每会话独立模型 + 单 turn，队列只含主步，turn 后 404 消耗无害',
    '注入块不落会话历史（SC4）——scope 隔离断言只能看 mock 请求载荷',
    '用户级条目 reply-in-chinese 由甲会话写入（a2 模型）：写入口按 type 推导 scope（user 类型 → user scope），与写入时所在项目无关——这正是「用户级两级都注入」的落盘前提',
  ]

  const agentDir = path.join(dataDir, 'agent')
  const memoryDir = path.join(agentDir, 'memory')

  // ── 0. 两个独立 fixture git 仓 ────────────────────────────────
  const fixtureA = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-v4-projA-'))
  const fixtureB = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-v4-projB-'))
  execFileSync('git', ['init', '-q', fixtureA], { timeout: 15_000 })
  execFileSync('git', ['init', '-q', fixtureB], { timeout: 15_000 })
  ev.step({ step: 'fixture.init', command: 'git init ×2（独立仓）', exitCode: 0, stats: { fixtureA, fixtureB } })

  try {
    // ── 1. 会话甲①：存项目记忆 codegen ──────────────────────────
    await singleTurnSession(protocol, ev, {
      cwd: fixtureA,
      label: '甲·存项目记忆',
      model: M.a1,
      text: '记住：这个项目构建前必须跑 codegen',
      stepName: 'save.A.project',
    })

    // ── 2. 会话甲②：存用户级记忆 回复用中文 ──────────────────────
    await singleTurnSession(protocol, ev, {
      cwd: fixtureA,
      label: '甲·存用户级记忆',
      model: M.a2,
      text: '记住我的偏好：回复用中文',
      stepName: 'save.A.user',
    })

    // ── 3. 会话乙①：存乙项目记忆 vite ───────────────────────────
    await singleTurnSession(protocol, ev, {
      cwd: fixtureB,
      label: '乙·存项目记忆',
      model: M.b1,
      text: '记住：这个项目开发服务器用 vite',
      stepName: 'save.B.project',
    })

    // ── 4. C 通道：slug 断言（V4①）+ 条目落盘分布 ────────────────
    const projectsDir = path.join(memoryDir, 'projects')
    const slugs = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []
    ev.assert('C: V4① 两项目 slug 均生成且不同（独立 git 仓）', slugs.length === 2 && slugs[0] !== slugs[1], {
      channel: 'C',
      expected: 'projects/ 下恰 2 个互不相同 slug',
      actual: `slugs=${slugs.join(',')}`,
    })
    const slugA = slugs.find((s) => s.startsWith('mem-v4-proja-'))
    const slugB = slugs.find((s) => s.startsWith('mem-v4-projb-'))
    ev.assert('C: V4① slug 前缀可辨识各自 fixture（归一目录名段）', Boolean(slugA) && Boolean(slugB), {
      channel: 'C',
      expected: 'slugA 前缀 mem-v4-proja- / slugB 前缀 mem-v4-projb-',
      actual: `slugA=${slugA} slugB=${slugB}`,
    })
    const userFacts = path.join(memoryDir, 'facts')
    const listFacts = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [])
    ev.assert('C: 甲项目条目落甲 slug', listFacts(path.join(projectsDir, slugA, 'facts')).includes('run-codegen-before-build.md'), {
      channel: 'C',
      expected: 'projects/<slugA>/facts/run-codegen-before-build.md',
      actual: `files=${listFacts(path.join(projectsDir, slugA, 'facts')).join(',')}`,
    })
    ev.assert('C: 用户级条目落用户级 facts', listFacts(userFacts).includes('reply-in-chinese.md'), {
      channel: 'C',
      expected: 'memory/facts/reply-in-chinese.md',
      actual: `files=${listFacts(userFacts).join(',')}`,
    })
    ev.assert('C: 乙项目条目落乙 slug', listFacts(path.join(projectsDir, slugB, 'facts')).includes('use-vite-dev-server.md'), {
      channel: 'C',
      expected: 'projects/<slugB>/facts/use-vite-dev-server.md',
      actual: `files=${listFacts(path.join(projectsDir, slugB, 'facts')).join(',')}`,
    })
    ev.step({ step: 'evidence.disk.scopes', channel: 'C', exitCode: 0, stats: { slugA, slugB } })

    // ── 5. 会话乙②：提问 → 注入块只含乙 + 全局（V4②③） ──────────
    await singleTurnSession(protocol, ev, {
      cwd: fixtureB,
      label: '乙·提问',
      model: M.b2,
      text: '这个项目有什么要注意的',
      stepName: 'ask.B',
    })
    const reqB = firstMainRequest(instance, M.b2)
    ev.assert('B: 乙提问主回合请求已捕获', Boolean(reqB), {
      channel: 'B',
      expected: `${M.b2} 首个 200 请求`,
      actual: `requests=${instance.mockLlm.requests.filter((r) => r.model === M.b2).length}`,
    })
    if (reqB) {
      const blockB = extractMemoryBlock(reqB.messages)
      ev.assert('B: 乙会话注入块在场（乙已有记忆）', blockB !== null, {
        channel: 'B',
        expected: '<memory-context> 块存在',
        actual: blockB ? `块长度=${blockB.length}` : '未找到注入块',
      })
      ev.assert(
        'B: V4② 项目甲条目不进乙注入块（run-codegen-before-build 不在）',
        blockB === null || !blockB.includes('run-codegen-before-build'),
        {
          channel: 'B',
          expected: '块内不含 run-codegen-before-build',
          actual: blockB ? (blockB.includes('run-codegen-before-build') ? '串入（隔离失败）' : '不含（隔离成立）') : '无块',
        },
      )
      ev.assert(
        'B: V4② 乙注入块含本项目条目（use-vite-dev-server 在）',
        blockB !== null && blockB.includes('use-vite-dev-server'),
        {
          channel: 'B',
          expected: '块内含 use-vite-dev-server',
          actual: blockB ? (blockB.includes('use-vite-dev-server') ? '含' : '不含') : '无块',
        },
      )
      ev.assert(
        'B: V4② 用户级条目两级注入（乙视角含 reply-in-chinese）',
        blockB !== null && blockB.includes('reply-in-chinese'),
        {
          channel: 'B',
          expected: '块内含 reply-in-chinese',
          actual: blockB ? (blockB.includes('reply-in-chinese') ? '含' : '不含') : '无块',
        },
      )
      ev.attach('request-B-block', blockB ?? '(无块)')
    }

    // ── 6. 会话甲③：提问 → 注入块只含甲 + 全局（V4② 反向） ──────
    await singleTurnSession(protocol, ev, {
      cwd: fixtureA,
      label: '甲·提问',
      model: M.a3,
      text: '这个项目有什么要注意的',
      stepName: 'ask.A',
    })
    const reqA = firstMainRequest(instance, M.a3)
    ev.assert('B: 甲提问主回合请求已捕获', Boolean(reqA), {
      channel: 'B',
      expected: `${M.a3} 首个 200 请求`,
      actual: `requests=${instance.mockLlm.requests.filter((r) => r.model === M.a3).length}`,
    })
    if (reqA) {
      const blockA = extractMemoryBlock(reqA.messages)
      ev.assert('B: 甲会话注入块在场', blockA !== null, {
        channel: 'B',
        expected: '<memory-context> 块存在',
        actual: blockA ? `块长度=${blockA.length}` : '未找到注入块',
      })
      ev.assert(
        'B: V4② 项目乙条目不进甲注入块（use-vite-dev-server 不在）',
        blockA === null || !blockA.includes('use-vite-dev-server'),
        {
          channel: 'B',
          expected: '块内不含 use-vite-dev-server',
          actual: blockA ? (blockA.includes('use-vite-dev-server') ? '串入（隔离失败）' : '不含（隔离成立）') : '无块',
        },
      )
      ev.assert(
        'B: V4② 甲注入块含本项目条目（run-codegen-before-build 在）',
        blockA !== null && blockA.includes('run-codegen-before-build'),
        {
          channel: 'B',
          expected: '块内含 run-codegen-before-build',
          actual: blockA ? (blockA.includes('run-codegen-before-build') ? '含' : '不含') : '无块',
        },
      )
      ev.assert(
        'B: V4② 用户级条目两级注入（甲视角含 reply-in-chinese）',
        blockA !== null && blockA.includes('reply-in-chinese'),
        {
          channel: 'B',
          expected: '块内含 reply-in-chinese',
          actual: blockA ? (blockA.includes('reply-in-chinese') ? '含' : '不含') : '无块',
        },
      )
      ev.attach('request-A-block', blockA ?? '(无块)')
    }

    // ── 7. 会话丙：跨 scope 写拒绝（V4③） ────────────────────────
    const c = await singleTurnSession(protocol, ev, {
      cwd: fixtureB,
      label: '丙·跨 scope 写',
      model: M.c1,
      text: '试着把这条项目记忆保存到用户全局',
      stepName: 'save.wrong-scope',
    })

    // 回执断言：工具错误文本进入模型上下文（follow-up 请求的 messages 含拒绝原因）
    const reqC2 = instance.mockLlm.requests.find((r) => r.model === M.c1 && r.status === 200 && r.stepIndex === 1)
    ev.assert('B: 拒绝后 follow-up 请求已捕获（stepIndex 1）', Boolean(reqC2), {
      channel: 'B',
      expected: `${M.c1} 的 200/step1 请求`,
      actual: `requests=${instance.mockLlm.requests.filter((r) => r.model === M.c1).map((r) => `${r.stepIndex}:${r.status}`).join(',')}`,
    })
    if (reqC2) {
      const textC2 = JSON.stringify(reqC2.messages)
      ev.assert('B: V4③ 回执含拒绝原因与正确 scope（只能写入 project scope）', textC2.includes('只能写入 project scope'), {
        channel: 'B',
        expected: '回执文本含「只能写入 project scope」',
        actual: textC2.includes('只能写入 project scope') ? '含' : '缺',
      })
      ev.assert('B: V4③ 回执指明收到的错误 scope（收到的是 "user" scope）', textC2.includes('收到的是 "user" scope') || textC2.includes('收到的是 \\"user\\" scope'), {
        channel: 'B',
        expected: '回执文本含错误 scope 指认',
        actual: textC2.includes('user') ? '含 user 字样' : '缺',
      })
      // 拒绝回执也进会话历史（用户可见的失败工具调用）
      const histC = await protocol.history(c.sid, { limitTurns: 10 })
      const histCText = JSON.stringify(histC)
      ev.assert('B: V4③ 拒绝回执进会话历史', histCText.includes('只能写入 project scope'), {
        channel: 'B',
        expected: 'history 含拒绝文案',
        actual: histCText.includes('只能写入 project scope') ? '在' : '缺',
      })
      // 证据可追溯：attach 定位含拒绝文本的消息片段（盲截尾消息会把超长 toolResult 截掉）
      const rejectIdx = (reqC2.messages ?? []).findIndex((m) => JSON.stringify(m).includes('只能写入 project scope'))
      const rejectMsg = rejectIdx >= 0 ? JSON.stringify(reqC2.messages[rejectIdx], null, 2) : '(未定位到含拒绝文本的消息)'
      ev.attach('request-C-reject-message', rejectMsg.slice(0, 12_000))
    }

    // 磁盘断言：被拒条目两级都不落盘
    ev.assert('C: V4③ 被拒条目不落用户级 facts', !listFacts(userFacts).includes('try-wrong-scope.md'), {
      channel: 'C',
      expected: 'memory/facts/ 无 try-wrong-scope.md',
      actual: `files=${listFacts(userFacts).join(',')}`,
    })
    const allProjectFacts = slugs.flatMap((s) => listFacts(path.join(projectsDir, s, 'facts')).map((f) => `${s}/${f}`))
    ev.assert('C: V4③ 被拒条目不落任何项目级 facts', !allProjectFacts.some((f) => f.includes('try-wrong-scope')), {
      channel: 'C',
      expected: 'projects/*/facts/ 无 try-wrong-scope.md',
      actual: `files=${allProjectFacts.join(',')}`,
    })
    ev.attach('memory-tree', JSON.stringify({ userFacts: listFacts(userFacts), projects: Object.fromEntries(slugs.map((s) => [s, listFacts(path.join(projectsDir, s, 'facts'))])), slugA, slugB }, null, 2))

    return { uncovered: [], gotchas }
  } finally {
    // fixture 清理（临时 git 仓，不留 worktree）
    for (const f of [fixtureA, fixtureB]) {
      try {
        fs.rmSync(f, { recursive: true, force: true })
      } catch {
        /* 清理失败不阻塞 */
      }
    }
    ev.step({ step: 'fixture.cleanup', command: `rm -rf ${fixtureA} ${fixtureB}`, exitCode: 0, stats: { cleaned: true } })
  }
}
