/**
 * memory-govern-commands —— pi-memory V8（A8）：/memory 命令族全链路治理。
 *
 * 装配：mock-http（llm 通道）——off 前后「请求载荷差异」（注入块有无）与「turn_end
 * 提炼调用有无」都只能在 mock server 的请求记录里对比（faux 无请求观察面）。
 * 单会话单模型（gov-main），队列按到达序逐消费。
 *
 * 命令输出观察面（源码核实）：taiji runtime 以 `--mode rpc` spawn pi，rpc 模式
 * bindExtensions 传入真实 uiContext（pi dist/modes/rpc/rpc-mode.js:83-98 notify →
 * extension_ui_request），故 ctx.hasUI=true——govern/commands.ts 的 emitData/
 * emitAck 走 ctx.ui.notify → runtime event-adapter translateNotifyRequest 广播
 * `extension:notify` WS 帧（payload {sessionId, message, level}）。
 *
 * 路径（对齐设计 §4 V8 步骤原文 + 任务书 A8 断言）：
 *   T1 写数据（memory_save 两级各一条）→ T1.5 普通轮（off 前：注入在场 + turn_end
 *   产生提炼调用）→ /memory list 两级条目 → /memory off（落盘 enabled=false）→
 *   T2（无注入 + 无新提炼）→ /memory on 恢复 → T2.5（注入恢复 + 提炼恢复）→
 *   ext-config 手改文件 enabled=false（热配置）→ T3（无注入——纯文件改动热生效）→
 *   /memory list（改 off 后不经重启 list 仍反映库状态）→ /memory on →
 *   /memory clear user 两阶段（预览不动盘 → confirm 后文件消失 + 索引行消失）。
 *
 * 源码锚（feat-memory-system worktree，2026-11-13 实读）：
 *   - 命令族：src/govern/commands.ts——off/on 经 saveMemoryConfig 落盘（emitAck
 *     notify）；clear 两阶段 = 无 confirm 参数返回预览、`confirm` 字面量再执行；
 *   - 配置：src/govern/config.ts——<agentDir>/config/memory-ext-config.json，
 *     loadMemoryConfig 每次 statSync（mtime+size）检测变化即重读（无 watch 热生效）；
 *   - 提炼跳过门：src/extract/queue.ts——toolResults 含 memory_save 即 already-saved；
 *     用户正文 <3 词即 no-user-text（T2/T3 文案须 ≥3 词，保证唯一变量是 enabled）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 注入块边界标记（inject/block.ts MEMORY_BLOCK_START）。 */
const MEMORY_BLOCK_START = '<memory-context>'
/** 提炼调用 systemPrompt 首句特征（extract/prompt.ts）。 */
const EXTRACT_MARKER = '你是记忆提炼器'
/** notify 广播帧类型（packages/shared/src/extension.ts EXTENSION_EVENTS.NOTIFY）。 */
const NOTIFY_TYPE = 'extension:notify'
/** 两级条目名（memory_save kebab-case 契约）。 */
const USER_ENTRY = 'prefer-concise-chinese'
const PROJECT_ENTRY = 'run-codegen-before-build'

/** 请求体 messages → 可检索文本。 */
function requestText(req) {
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('')
    }
    return ''
  }
  return (req.messages ?? []).map((m) => textOf(m?.content)).join('\n')
}

const SKIP_STEP = { text: '{"operations":[{"op":"skip","reason":"普通对话，无可记内容"}]}', stopReason: 'stop' }

export const meta = {
  id: 'memory-govern-commands',
  priority: 'P0',
  title: 'V8：/memory 命令族全链路（off/on 注入与提炼双停启 + list + clear 两阶段 + ext-config 热生效）',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'session.getCommands', 'chat.send', 'chat.wait'],
  requires: ['mock-http'],
  estimateSec: 240,
  llm: {
    mainModel: 'gov-main',
    models: ['gov-main'],
    responses: {
      // 消费序（实测行为预算，2026-11-13 诊断剧本 memory-diag-requests 实测）：
      // 每个有效 turn（enabled=true 且未被跳过门拦）产生 **2 次**提炼调用——
      // pi agent 循环对同一 turn 既走 finishTurn 扩展边界又 emit 一条
      // toolResults:[] 的内部 turn_end（两路事件的 toolResults 均不含
      // memory_save，already-saved 门真机不命中；已登记 blocker）。队列按
      // 「1 主回复 + 2 SKIP」预算；off/hot-off 后的 turn 0 次提炼。
      'mockllm/gov-main': [
        {
          toolCalls: [
            {
              name: 'memory_save',
              args: {
                name: USER_ENTRY,
                description: '用户偏好简洁的中文回复',
                type: 'user',
                content: '用户偏好简洁的中文回复，不要冗长解释。',
              },
            },
            {
              name: 'memory_save',
              args: {
                name: PROJECT_ENTRY,
                description: '该项目构建前必须先跑 codegen',
                type: 'project',
                content: 'Why: 构建产物依赖 codegen 生成的代码，跳过会构建失败。\n\nHow to apply: 构建前先执行 codegen 脚本再跑 build。',
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: '两条偏好都已保存。', stopReason: 'stop' }, // T1 R2
        SKIP_STEP, // T1 提炼#1
        SKIP_STEP, // T1 提炼#2
        { text: '好的，日志格式记下了。', stopReason: 'stop' }, // T1.5 R
        SKIP_STEP, // T1.5 提炼#1
        SKIP_STEP, // T1.5 提炼#2
        { text: '好的，随便聊聊。', stopReason: 'stop' }, // T2 R（off 后，无提炼）
        { text: '好的，换个话题。', stopReason: 'stop' }, // T2.5 R（on 后）
        SKIP_STEP, // T2.5 提炼#1
        SKIP_STEP, // T2.5 提炼#2
        { text: '好的，收到。', stopReason: 'stop' }, // T3 R（hot-off 后，无提炼）
        SKIP_STEP, // 尾部冗余（防时序抖动多一次提炼调用）
        SKIP_STEP,
      ],
    },
  },
  provable: [
    'T1 memory_save 两级各落一条：user facts + projects/<slug>/facts + 两级 MEMORY.md 索引行',
    '/memory list 输出两级条目列表（notify 帧含 user 1 · project 1 计数与两条目名）',
    '/memory off 落盘 enabled=false；off 后请求载荷无 <memory-context> 且 turn_end 无新提炼调用（对比 off 前 T1.5：注入在场 + 提炼调用在场）',
    '/memory on 恢复 enabled=true；恢复后请求载荷重新含索引块、turn_end 提炼恢复',
    'ext-config 手改文件 enabled=false 后（不经 /memory 命令与重启）：下一请求即无注入、turn_end 无提炼；/memory list 仍列出条目（已有数据不动）',
    '/memory clear user 两阶段：第一次预览（含确认指引、不动磁盘）；confirm 参数后 user 条目文件消失 + 用户级索引行消失；project 条目不受影响',
  ],
  notProvable: [
    '/memory integrate 手动 Dream 触发（V8 步骤④——Dream 整合的 backups 快照与整合结果属 V9/Dream 域，本剧本聚焦命令族治理半边：off/on/list/clear/ext-config）',
    '/memory show 条目详情（list 已覆盖两级清单读取路径；show 为同读侧另一出口）',
    '无 UI 模式的 stderr 降级输出（taiji 恒以 rpc 模式 spawn pi，hasUI=true 走 notify）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const uncovered = []
  const gotchas = [
    'T2/T3 的用户正文必须 ≥3 词（跳过门 no-user-text 在 <3 词时拦下提炼，会让「off 停提炼」断言空洞——唯一变量必须是 enabled）',
    'ext-config 手改文件须整体写完整配置对象且与上次落盘内容 mtime+size 有差（llm-shared loadConfig 以 mtime+size 双 key 缓存，同 size 同 mtime 的改写不触发重读）',
    '命令轮不消费 mock 队列（slash 命令非 LLM 回合）；命令完成信号 = extension:notify 广播帧（waitFor 条件等待，不用固定 sleep）',
    '实测（2026-11-13 诊断剧本 memory-diag-requests）：每个有效 turn 产生 2 次提炼调用（pi agent 循环对同一 turn 双发 turn_end——finishTurn 扩展边界 + 内部 emit toolResults:[]），already-saved 跳过门真机不命中（两路事件的 toolResults 均不含 memory_save）。队列按「1 主回复 + 2 SKIP」预算；该行为已按发现登记 blocker，不影响 V8 断言面（off 后窗口 0 提炼为铁证）',
    'off/hot-off 的「无提炼」断言用窗口内计数（锚点 = 发送前 requests.length 快照）而非全局累计对比——全局对比会把 off 前合法轮次的迟到请求误计入 off 后窗口（首版实测踩坑）',
  ]

  const configPath = path.join(dataDir, 'agent', 'config', 'memory-ext-config.json')
  const memoryDir = path.join(dataDir, 'agent', 'memory')
  const readConfig = () => {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      return null
    }
  }
  const writeConfig = (enabled) => {
    // 与 saveMemoryConfig 同形完整对象（normalize 缺字段回落默认，但显式全写最稳）
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ enabled, indexBudgetBytes: 25000, dreamIntervalMs: 86400000, networkTimeoutMs: 15000, deleteRequiresConfirm: true }, null, 2)}\n`,
      'utf8',
    )
  }

  /** 窗口内主会话非提炼请求中的注入块命中数（锚点 = 发送前 requests 长度快照）。 */
  const injectedIn = (anchor) =>
    instance.mockLlm.requests.slice(anchor).filter(
      (r) => r.model === 'gov-main' && r.status === 200 && !requestText(r).includes(EXTRACT_MARKER) && requestText(r).includes(MEMORY_BLOCK_START),
    ).length
  /** 窗口内提炼调用数（status 200——404 的队列耗尽伪请求不计）。 */
  const extractsIn = (anchor) =>
    instance.mockLlm.requests.slice(anchor).filter(
      (r) => r.model === 'gov-main' && r.status === 200 && requestText(r).includes(EXTRACT_MARKER),
    ).length

  /** 发 slash 命令并等 notify 帧（predicate 命中即返回该帧 payload.message）。 */
  const runCommand = async (sid, command, needle, timeoutMs = 30_000) => {
    const since = protocol.events.length
    await protocol.send(sid, command)
    const evt = await protocol.waitFor(
      (e) => e.type === NOTIFY_TYPE && e.payload?.sessionId === sid && String(e.payload?.message ?? '').includes(needle),
      { since, timeoutMs },
    )
    return String(evt.payload?.message ?? '')
  }

  // ── fixture：非 git 临时目录（cwd 归一 slug 稳定） ─────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mem-gov-'))
  ev.step({ step: 'fixture.tmpdir', command: `mkdtemp ${tmpDir}`, exitCode: 0, stats: { tmpDir } })

  try {
    // ── 会话 ────────────────────────────────────────────────────
    const created = await protocol.call(
      'session.create',
      { cwd: tmpDir, label: 'mem-govern', modelOverride: 'mockllm/gov-main' },
      { timeoutMs: 120_000 },
    )
    const sid = created.session?.id
    ev.assert('B: 治理会话创建', Boolean(sid), {
      channel: 'B',
      expected: 'session.id 非空',
      actual: `sid=${sid}`,
    })
    const cmds = await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 60_000 })
    const memCmd = (cmds.commands ?? []).find((c) => c?.name === 'memory')
    ev.assert('B: /memory 命令注册在场（pi-memory 扩展装载）', Boolean(memCmd), {
      channel: 'B',
      expected: 'commands 含 name=memory',
      actual: `total=${(cmds.commands ?? []).length}`,
    })
    ev.step({ step: 'session.getCommands', command: `session.getCommands ${sid}`, exitCode: memCmd ? 0 : 1, stats: { hasMemory: Boolean(memCmd) } })
    await protocol.subscribe(sid)

    // ── T1：写两级条目（memory_save ×2） ────────────────────────
    let since = protocol.events.length
    await protocol.send(sid, '请记住两条偏好：第一我偏好简洁的中文回复；第二这个项目构建前必须先跑 codegen。')
    let end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: T1 写入轮 message.complete', end.ok, { channel: 'B', expected: 'complete', actual: `${end.type} ${end.payload?.stopReason ?? ''}` })
    ev.step({ step: 'T1.memory-save.turn', channel: 'B', exitCode: end.ok ? 0 : 1, stats: {} })

    const projectsDir = path.join(memoryDir, 'projects')
    let slug = ''
    {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (fs.existsSync(projectsDir)) {
          const dirs = fs.readdirSync(projectsDir).filter((d) => fs.existsSync(path.join(projectsDir, d, 'facts', `${PROJECT_ENTRY}.md`)))
          if (dirs.length > 0) {
            slug = dirs[0]
            break
          }
        }
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    const userFact = path.join(memoryDir, 'facts', `${USER_ENTRY}.md`)
    const projectFact = path.join(projectsDir, slug, 'facts', `${PROJECT_ENTRY}.md`)
    const userIndex = path.join(memoryDir, 'MEMORY.md')
    const projectIndex = path.join(projectsDir, slug, 'MEMORY.md')
    ev.assert(`C: user 级条目落盘 facts/${USER_ENTRY}.md`, fs.existsSync(userFact), {
      channel: 'C',
      expected: userFact,
      actual: `exists=${fs.existsSync(userFact)}`,
    })
    ev.assert(`C: project 级条目落盘 projects/<slug>/facts/${PROJECT_ENTRY}.md`, fs.existsSync(projectFact), {
      channel: 'C',
      expected: projectFact,
      actual: `exists=${fs.existsSync(projectFact)} slug=${slug || '(未出现)'}`,
    })
    const userIndexText = fs.existsSync(userIndex) ? fs.readFileSync(userIndex, 'utf8') : ''
    const projectIndexText = fs.existsSync(projectIndex) ? fs.readFileSync(projectIndex, 'utf8') : ''
    ev.assert('C: 两级 MEMORY.md 各含索引行', userIndexText.includes(`- [${USER_ENTRY}]`) && projectIndexText.includes(`- [${PROJECT_ENTRY}]`), {
      channel: 'C',
      expected: `user 含 ${USER_ENTRY} / project 含 ${PROJECT_ENTRY}`,
      actual: `user=${userIndexText.includes(`- [${USER_ENTRY}]`)} project=${projectIndexText.includes(`- [${PROJECT_ENTRY}]`)}`,
    })
    ev.step({
      step: 'T1.disk',
      channel: 'C',
      exitCode: fs.existsSync(userFact) && fs.existsSync(projectFact) ? 0 : 1,
      stats: { slug, userEntry: fs.existsSync(userFact), projectEntry: fs.existsSync(projectFact) },
    })

    // T1 后注入在场（off 前基线半边）：memory_save 落盘后的续请求载荷含块
    const t1Anchor = 0
    ev.assert('B: off 前基线：T1 续请求载荷含 <memory-context>（两级条目在场）', injectedIn(t1Anchor) >= 1, {
      channel: 'B',
      expected: '≥1',
      actual: `hits=${injectedIn(t1Anchor)}`,
    })

    // ── T1.5：普通轮（off 前注入 + 提炼正向基线窗口） ───────────
    const t15Anchor = instance.mockLlm.requests.length
    since = protocol.events.length
    await protocol.send(sid, '另外再补充一点，我觉得日志格式统一用 JSON 比较好，不要纯文本')
    end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: T1.5 普通轮 message.complete', end.ok, { channel: 'B', expected: 'complete', actual: `${end.type} ${end.payload?.stopReason ?? ''}` })
    // 提炼 fire-and-forget：条件轮询窗口内提炼调用落定（实测每有效 turn 2 次）
    let t15Extracts = 0
    try {
      await protocol.waitFor(() => extractsIn(t15Anchor) >= 1, { timeoutMs: 20_000 })
      await new Promise((r) => setTimeout(r, 1_000)) // 第二次调用紧随第一次（实测间隔 ~4ms），收敛窗口
      t15Extracts = extractsIn(t15Anchor)
    } catch {
      t15Extracts = extractsIn(t15Anchor)
    }
    const t15Injects = injectedIn(t15Anchor)
    ev.assert('B: off 前基线：T1.5 请求载荷含 <memory-context>', t15Injects >= 1, {
      channel: 'B',
      expected: '≥1',
      actual: `hits=${t15Injects}`,
    })
    ev.assert('B: off 前基线：T1.5 turn_end 产生提炼调用（载荷含记忆提炼器）', t15Extracts >= 1, {
      channel: 'B',
      expected: '≥1 次提炼调用',
      actual: `calls=${t15Extracts}（20s 窗口）`,
    })
    ev.step({ step: 'T1.5.baseline', channel: 'B', exitCode: t15Extracts >= 1 && t15Injects >= 1 ? 0 : 1, stats: { injects: t15Injects, extracts: t15Extracts } })

    // ── /memory list：两级条目列表 ──────────────────────────────
    const listMsg = await runCommand(sid, '/memory list', '记忆条目')
    ev.assert('/memory list 输出两级条目列表（user 1 · project 1 + 两条目名）', listMsg.includes('user 1 · project 1') && listMsg.includes(USER_ENTRY) && listMsg.includes(PROJECT_ENTRY), {
      channel: 'B',
      expected: `含 user 1 · project 1 / ${USER_ENTRY} / ${PROJECT_ENTRY}`,
      actual: listMsg.slice(0, 400),
    })
    ev.attach('memory-list-output', listMsg)
    ev.step({ step: 'memory.list', command: '/memory list', exitCode: 0, stats: { lines: listMsg.split('\n').length } })

    // ── /memory off：停注入停提炼 ───────────────────────────────
    const offMsg = await runCommand(sid, '/memory off', '记忆系统已关闭')
    const cfgOff = readConfig()
    ev.assert('C: /memory off 落盘 enabled=false', cfgOff?.enabled === false, {
      channel: 'C',
      expected: 'enabled=false',
      actual: JSON.stringify(cfgOff).slice(0, 200),
    })
    ev.step({ step: 'memory.off', command: '/memory off', exitCode: cfgOff?.enabled === false ? 0 : 1, stats: { notify: offMsg.slice(0, 120) } })

    const t2Anchor = instance.mockLlm.requests.length
    since = protocol.events.length
    await protocol.send(sid, '今天天气不错，我们随便聊聊放松一下') // ≥3 词：唯一变量是 enabled
    end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: T2 off 后轮 message.complete', end.ok, { channel: 'B', expected: 'complete', actual: `${end.type} ${end.payload?.stopReason ?? ''}` })
    // 无新提炼：等一个明确窗口后窗口计数为 0（提炼在 turn_end 即 fire，实测 ms 级到达）
    await new Promise((r) => setTimeout(r, 5_000))
    const t2Extracts = extractsIn(t2Anchor)
    const t2Injects = injectedIn(t2Anchor)
    ev.assert('B: off 后请求载荷无 <memory-context>（对比 off 前窗口有）', t2Injects === 0, {
      channel: 'B',
      expected: '窗口内 0 个含块请求',
      actual: `hits=${t2Injects}`,
    })
    ev.assert('B: off 后 turn_end 无新提炼调用（对比 off 前窗口有）', t2Extracts === 0, {
      channel: 'B',
      expected: '窗口内 0 次提炼调用',
      actual: `calls=${t2Extracts}`,
    })
    ev.step({
      step: 'T2.off-effects',
      channel: 'B',
      exitCode: t2Injects === 0 && t2Extracts === 0 ? 0 : 1,
      stats: { injects: t2Injects, extracts: t2Extracts },
    })

    // ── /memory on：恢复 ────────────────────────────────────────
    const onMsg = await runCommand(sid, '/memory on', '记忆系统已开启')
    const cfgOn = readConfig()
    ev.assert('C: /memory on 落盘 enabled=true', cfgOn?.enabled === true, {
      channel: 'C',
      expected: 'enabled=true',
      actual: JSON.stringify(cfgOn).slice(0, 200),
    })
    ev.step({ step: 'memory.on', command: '/memory on', exitCode: cfgOn?.enabled === true ? 0 : 1, stats: { notify: onMsg.slice(0, 120) } })

    const t25Anchor = instance.mockLlm.requests.length
    since = protocol.events.length
    await protocol.send(sid, '继续聊聊别的什么话题好呢，最近在忙什么项目')
    end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: T2.5 on 后轮 message.complete', end.ok, { channel: 'B', expected: 'complete', actual: `${end.type} ${end.payload?.stopReason ?? ''}` })
    let t25Extracts = 0
    try {
      await protocol.waitFor(() => extractsIn(t25Anchor) >= 1, { timeoutMs: 20_000 })
      await new Promise((r) => setTimeout(r, 1_000))
      t25Extracts = extractsIn(t25Anchor)
    } catch {
      t25Extracts = extractsIn(t25Anchor)
    }
    const t25Injects = injectedIn(t25Anchor)
    ev.assert('B: on 后注入恢复（请求载荷重新含 <memory-context>）', t25Injects >= 1, {
      channel: 'B',
      expected: '窗口内 ≥1 个含块请求',
      actual: `hits=${t25Injects}`,
    })
    ev.assert('B: on 后 turn_end 提炼恢复', t25Extracts >= 1, {
      channel: 'B',
      expected: '窗口内 ≥1 次提炼调用',
      actual: `calls=${t25Extracts}`,
    })
    ev.step({
      step: 'T2.5.on-effects',
      channel: 'B',
      exitCode: t25Injects >= 1 && t25Extracts >= 1 ? 0 : 1,
      stats: { injects: t25Injects, extracts: t25Extracts },
    })

    // ── ext-config 热配置：手改文件 enabled=false ───────────────
    writeConfig(false)
    ev.step({ step: 'ext-config.write', command: `write ${configPath} enabled=false`, exitCode: 0, stats: { config: readConfig() } })

    const t3Anchor = instance.mockLlm.requests.length
    since = protocol.events.length
    await protocol.send(sid, '热配置关闭之后我们再随便聊一句试试看效果')
    end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: T3 热配置轮 message.complete', end.ok, { channel: 'B', expected: 'complete', actual: `${end.type} ${end.payload?.stopReason ?? ''}` })
    await new Promise((r) => setTimeout(r, 5_000))
    const t3Injects = injectedIn(t3Anchor)
    const t3Extracts = extractsIn(t3Anchor)
    ev.assert('B: ext-config 改文件后下一请求即无注入（热生效，不经命令与重启）', t3Injects === 0, {
      channel: 'B',
      expected: '窗口内 0 个含块请求',
      actual: `hits=${t3Injects}`,
    })
    ev.assert('B: ext-config 改文件后 turn_end 无提炼', t3Extracts === 0, {
      channel: 'B',
      expected: '窗口内 0 次提炼调用',
      actual: `calls=${t3Extracts}`,
    })
    ev.step({
      step: 'T3.hot-config-effects',
      channel: 'B',
      exitCode: t3Injects === 0 && t3Extracts === 0 ? 0 : 1,
      stats: { injects: t3Injects, extracts: t3Extracts },
    })

    // 改 off 后不经重启 /memory list 仍反映库状态（已有数据不动）
    const listAfterHot = await runCommand(sid, '/memory list', '记忆条目')
    ev.assert('/memory list 在热配置 off 下仍列出两级条目（数据不动）', listAfterHot.includes('user 1 · project 1') && listAfterHot.includes(USER_ENTRY), {
      channel: 'B',
      expected: `仍含 user 1 · project 1 / ${USER_ENTRY}`,
      actual: listAfterHot.slice(0, 400),
    })
    ev.step({ step: 'memory.list.after-hot-off', command: '/memory list', exitCode: 0, stats: {} })

    // 恢复 on（回到默认态，后续 clear 断言不受开关态影响）
    await runCommand(sid, '/memory on', '记忆系统已开启')
    ev.step({ step: 'memory.on.restore', command: '/memory on', exitCode: readConfig()?.enabled === true ? 0 : 1, stats: {} })

    // ── /memory clear user 两阶段确认 ───────────────────────────
    const previewMsg = await runCommand(sid, '/memory clear user', '将删除')
    ev.assert('clear 阶段一：预览输出条目与确认指引（含 confirm 指引）', previewMsg.includes(`将删除 user 级全部 1 条记忆`) && previewMsg.includes(USER_ENTRY) && previewMsg.includes('/memory clear user confirm'), {
      channel: 'B',
      expected: `含「将删除 user 级全部 1 条记忆」+ ${USER_ENTRY} + 确认指引`,
      actual: previewMsg.slice(0, 400),
    })
    ev.attach('clear-preview-output', previewMsg)
    ev.assert('C: clear 阶段一不动磁盘（user 条目文件仍在）', fs.existsSync(userFact), {
      channel: 'C',
      expected: `${userFact} 仍存在`,
      actual: `exists=${fs.existsSync(userFact)}`,
    })
    ev.step({ step: 'memory.clear.preview', command: '/memory clear user', exitCode: 0, stats: { fileStillThere: fs.existsSync(userFact) } })

    const confirmMsg = await runCommand(sid, '/memory clear user confirm', '已清除')
    const userFactGone = !fs.existsSync(userFact)
    const userIndexAfter = fs.existsSync(userIndex) ? fs.readFileSync(userIndex, 'utf8') : ''
    ev.assert('C: clear 阶段二：user 条目文件消失', userFactGone, {
      channel: 'C',
      expected: `${userFact} 不存在`,
      actual: `gone=${userFactGone}`,
    })
    ev.assert('C: clear 阶段二：用户级索引行消失', !userIndexAfter.includes(`- [${USER_ENTRY}]`), {
      channel: 'C',
      expected: `MEMORY.md 无 ${USER_ENTRY} 行`,
      actual: userIndexAfter.split('\n').filter((l) => l.startsWith('- ')).join(' | ').slice(0, 200) || '(无条目行)',
    })
    ev.assert('C: clear user 不影响 project 条目', fs.existsSync(projectFact) && fs.readFileSync(projectIndex, 'utf8').includes(`- [${PROJECT_ENTRY}]`), {
      channel: 'C',
      expected: `project 条目与索引行仍在`,
      actual: `fact=${fs.existsSync(projectFact)}`,
    })
    ev.step({
      step: 'memory.clear.confirm',
      command: '/memory clear user confirm',
      exitCode: userFactGone ? 0 : 1,
      stats: { notify: confirmMsg.slice(0, 120), userFactGone },
    })
    // 清除后的 list 反映新状态（user 0 · project 1）——第二视角复核
    const listAfterClear = await runCommand(sid, '/memory list', '记忆条目')
    ev.assert('clear 后 /memory list 反映 user 0 · project 1', listAfterClear.includes('user 0 · project 1'), {
      channel: 'B',
      expected: 'user 0 · project 1',
      actual: listAfterClear.slice(0, 200),
    })
    ev.step({ step: 'memory.list.after-clear', command: '/memory list', exitCode: 0, stats: {} })

    log(`done slug=${slug} t15=(inject ${t15Injects}/extract ${t15Extracts}) t2=(inject ${t2Injects}/extract ${t2Extracts}) t25=(inject ${t25Injects}/extract ${t25Extracts}) t3=(inject ${t3Injects}/extract ${t3Extracts})`)
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不阻塞证据收尾 */
    }
    ev.step({ step: 'fixture.cleanup', command: `rm -rf ${tmpDir}`, exitCode: fs.existsSync(tmpDir) ? 1 : 0, stats: { cleaned: !fs.existsSync(tmpDir) } })
  }

  return { uncovered, gotchas }
}
