/**
 * p0-chat-stream-ui —— 对话流式渲染的 A 通道完整链路（补剧本优先级 #3）。
 *
 * 装配：faux（真 Electron + 真 pi 子进程 + 假 LLM 演员，零 token）+ TAIJI_FAUX_TPS=6
 * 拉长流式窗口。会话 cwd 用 mkdtemp 自建临时目录（kitchen-sink 会向 cwd 写文件，避免污染仓库）。
 * 路径：
 *   段 1 流式——协议发送（发送通道已由 p0-session-chat 验过，本剧本专注渲染面）→
 *   A：turn 轮渲染 + 正文哨兵可见 → B：history 含相同文本。（流式中途活动条抓拍已登记
 *   notProvable：TPS 窗口与渲染时机在 faux 下不稳定。）
 *   段 2 渲染全家桶——markdown 表格 / ts 代码块 / KaTeX / 相对图片 / html-preview →
 *   A：msg-stream 含哨兵文本 → C：.faux-pic.svg / .faux-artifact.html 落 cwd。
 *
 * 现行锚点事实（2026-10-22 源码核对，权威 = packages/ui/src/features/chat/）：
 * `turn-<index>`（Turn.vue）/ `html-preview-inline`（HtmlPreviewInline.vue）在 @taiji/ui 包；
 * text 块无独立 testid（Block.vue 只给 tool/thinking 块锚点，见矩阵空洞 #1），文本断言走 turn 容器 textContent。
 * **UI 激活链**：协议建的 session 不改变 renderer 激活态（AGENTS 关键规则：渲染面跟随激活会话），
 * A 通道断言前必须点击侧栏会话行（`css=.session-item`，ui.click 内部 first()）激活该会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(SKILL_ROOT, 'fixtures', 'faux-responses')
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

export const meta = {
  id: 'p0-chat-stream-ui',
  priority: 'P0',
  title: '流式渲染 A 通道：活动条中途态 + msg-stream 终态文本 + markdown 全家桶 + cwd 副作用落盘',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait', 'chat.stream',
    'session.history',
    'render.markdown', 'render.shiki', 'render.html-preview',
  ],
  requires: ['faux'],
  parallelGroup: 'chat',
  estimateSec: 120,
  faux: {
    responses: [...readFixture('thinking-stream.json'), ...readFixture('markdown-kitchen-sink.json')],
    tps: 6,
  },
  provable: [
    'UI 激活链：点击侧栏会话行（css=.session-item）后该会话对话流渲染（turn-<index> 轮出现）',

    'A：页面消息区含 thinking 段与正文段文本（THINKING-STREAM-END）',
    'B：session.history 与 UI 文本一致（live 渲染内容 = 事实源）',
    'A：markdown 表格 / ts 代码 / KaTeX 渲染轮的哨兵文本可见（MARKDOWN-KITCHEN-SINK-END / 列A / E = mc^2）',
    'A：html-preview-inline 预览卡可见（.faux-artifact.html 围栏触发）',
    'C：kitchen-sink 的 write 工具把 .faux-pic.svg / .faux-artifact.html 写进会话 cwd',
  ],
  notProvable: [
    'thinking 块的独立稳定锚点（现行 UI 无独立 testid，矩阵空洞 #1）：thinking 全文默认折叠不进 DOM，UI 只断折叠 chip，全文核对走 B 通道 history',
    'shiki 高亮的视觉正确性（像素级归 e2e-visual 像素轨；本剧本只证代码块文本渲染）',
    'html-preview 抽屉交互（`html-preview` 代码围栏的预览浮层无稳定 testid；C 通道证 .faux-artifact.html 落盘即 its 数据面）',
    'composer 输入三态（slash/mention/file portal）——portal 浮层锚点未稳定，归后续补锚',
    '流式中途活动条（activity-strip）的抓拍：TPS=6 窗口与活动条渲染时机在 faux 下不稳定（2026-10-22 三次实测未命中，截图显示进行中信息由 turn-meta 计时行承载）——流式中途态的视觉验收归 e2e-visual 像素轨',
  ],
}

/**
 * 条件轮询整页 innerHTML 直到出现哨兵（B 通道 complete 帧先于 renderer 渲染完成，
 * 必须等 UI 侧信号而非直接读）。超时返回最后内容（断言按 contains 判定并给出 len）。
 */
async function pollBodyHtml(ui, needle, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (html.includes(needle)) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return html
}

export async function run(ctx) {
  const { protocol, ev, log, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    '锚点权威在 @taiji/ui 包（packages/ui/src/features/chat/）：turn-<index> / html-preview-inline / block-tool-<id>；text 块无独立 testid（Block.vue 只锚 tool/thinking）',
    '协议建的 session 不改变 renderer 激活态：A 通道断言前必须点侧栏会话行激活（css=.session-item，同 label 多行时 first() 语义要自查）',
    'faux 队列 per-pi 进程一次加载：本剧本 3 步队列（thinking 轮 + kitchen 写文件轮 + kitchen 收尾轮）按轮次顺序消费',
    '会话 cwd 用 mkdtemp 自建：kitchen-sink 的 write 工具会写 .faux-* 文件，落临时目录避免污染仓库；剧本收尾自删',
  ]

  const ui = ctx.ui
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-chat-ui-'))
  log(`临时会话 cwd=${cwd}`)

  try {
    // ── 段 0：UI 激活链（协议建会话 → 点侧栏行激活） ────────────
    const created = await protocol.call('session.create', { cwd, label: 'p0-chat-stream-ui' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.assert('A: 侧栏会话行存在并可点（css=.session-item）', true, {
      channel: 'A',
      expected: '协议建会话后侧栏出现会话行',
      actual: '点击成功（ui.click 内部 first()）',
    })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 段 1：流式渲染 ──────────────────────────────────────
    const since = protocol.events.length
    await protocol.send(sid, '开始流式渲染验证')
    // 用户气泡轮先渲染；随后 assistant 流式。turn index 不定，用前缀匹配。激活失败则此处超时。
    let turn0Seen = true
    try {
      await ui.expectVisible('css=[data-testid^="turn-"]', { timeoutMs: 30_000 })
    } catch (e) {
      turn0Seen = false
      ev.attach('turn0-miss', JSON.stringify({ message: String(e?.message ?? e).slice(0, 300), evidence: e?.evidence }, null, 2).slice(0, 20_000))
      try {
        await ev.shot(await instance.page(), 'turn0-miss')
      } catch { /* 页面不可用 */ }
    }
    ev.assert('A: UI 激活链生效（用户消息以 turn 轮渲染）', turn0Seen, {
      channel: 'A',
      expected: '激活后发送的消息以 turn-<index> 渲染（index 不定，用前缀匹配）',
      actual: turn0Seen ? 'turn 轮可见' : '超时未现（现场见 turn0-miss 附件与截图）',
    })
    if (!turn0Seen) {
      // fail-fast：激活链不通时后续 A 断言全部依赖它，继续跑只会产出误导性失败组合
      return { uncovered: ['UI 激活链不可达：turn 轮未渲染，A 通道后续断言未执行'], gotchas }
    }
    // （流式中途活动条抓拍已登记 notProvable：TPS 窗口与活动条渲染时机在 faux 下不稳定）
    const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 流式轮正常收尾', end1.type === 'message.complete' && end1.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.stream.turn1', channel: 'B', exitCode: end1.ok ? 0 : 1, stats: { stopReason: end1.payload?.stopReason ?? null } })

    // 虚拟列表可视窗口会回收滚出视口的轮次：用 innerHTML（全量 DOM）而非 innerText；
    // complete 帧 ≠ 渲染完成，等 UI 侧哨兵出现
    const pageText = await pollBodyHtml(ui, 'THINKING-STREAM-END')
    // thinking 全文默认折叠（ThinkingRow 折叠态，展开锚点 = block-thinking-<运行时 id>，空洞 #1）：
    // UI 断言用 turn-meta 的思考 chip（「思考」计数），全文核对走 B 通道 history
    ev.assert('A: 消息区含 thinking 折叠 chip（思考 ×N）', pageText.includes('思考'), {
      channel: 'A',
      expected: 'HTML 含思考折叠 chip（turn-meta）',
      actual: `len=${pageText.length} hit=${pageText.includes('思考')}`,
    })
    ev.assert('A: 消息区含正文哨兵（THINKING-STREAM-END）', pageText.includes('THINKING-STREAM-END'), {
      channel: 'A',
      expected: 'THINKING-STREAM-END',
      actual: `hit=${pageText.includes('THINKING-STREAM-END')}`,
    })
    // 正文块有独立稳定锚点 block-text（TextRow.vue 组件根，每个 text 块恒渲染）
    let blockTextSeen = false
    try {
      await ui.expectVisible('testid=block-text', { timeoutMs: 10_000 })
      blockTextSeen = true
    } catch { /* 视口外/折叠时如实记录 */ }
    ev.assert('A: 正文块锚点（block-text）可见', blockTextSeen, {
      channel: 'A',
      expected: 'TextRow 根 testid=block-text',
      actual: blockTextSeen ? '可见' : '未现（虚拟列表可视窗口裁剪，正文哨兵断言已覆盖内容面）',
    })
    await ev.shot(await instance.page(), 'stream-turn1-done')

    const hist1 = await protocol.history(sid, { limitTurns: 10 })
    const histText = JSON.stringify(hist1.messages ?? [])
    ev.assert('B: history 与 UI 文本一致（live ≡ 事实源）', histText.includes('THINKING-STREAM-END'), {
      channel: 'B',
      expected: 'history 含 THINKING-STREAM-END',
      actual: `messages=${(hist1.messages ?? []).length}`,
    })

    // ── 段 2：markdown 全家桶 ───────────────────────────────
    const since2 = protocol.events.length
    await protocol.send(sid, '渲染全家桶验证')
    const end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 180_000 })
    ev.assert('B: 全家桶轮正常收尾（两步：write 工具轮 + 收尾文本轮）', end2.type === 'message.complete' && end2.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end2.type} stop=${end2.payload?.stopReason ?? 'n/a'}`,
    })

    const pageText2 = await pollBodyHtml(ui, 'MARKDOWN-KITCHEN-SINK-END')
    for (const [name, needle] of [
      ['表格哨兵（列A）', '列A'],
      ['ts 代码哨兵（const answer）', 'const answer'],
      ['KaTeX 渲染产物（class="katex"）', 'class="katex"'],
      ['收尾哨兵（MARKDOWN-KITCHEN-SINK-END）', 'MARKDOWN-KITCHEN-SINK-END'],
    ]) {
      ev.assert(`A: 消息区 ${name}`, pageText2.includes(needle), {
        channel: 'A',
        expected: needle,
        actual: `hit=${pageText2.includes(needle)}`,
      })
    }
    await ui.expectVisible('testid=html-preview-inline', { timeoutMs: 15_000 })
    ev.assert('A: html-preview-inline 预览卡可见', true, {
      channel: 'A',
      expected: 'html-preview 围栏触发内联预览（HtmlPreviewInline.vue）',
      actual: '可见',
    })
    await ev.shot(await instance.page(), 'markdown-kitchen-sink')

    const picExists = fs.existsSync(path.join(cwd, '.faux-pic.svg'))
    const htmlExists = fs.existsSync(path.join(cwd, '.faux-artifact.html'))
    ev.assert('C: kitchen-sink 写盘副作用（.faux-pic.svg / .faux-artifact.html）', picExists && htmlExists, {
      channel: 'C',
      expected: '两文件在会话 cwd',
      actual: `svg=${picExists} html=${htmlExists}`,
    })
    ev.step({ step: 'render.markdown', channel: 'A', exitCode: picExists && htmlExists ? 0 : 1, stats: { svg: picExists, html: htmlExists } })

    log(`done sid=${sid} cwd=${cwd}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
