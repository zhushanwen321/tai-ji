/**
 * btw S7 真实进程 e2e —— 主 turn 进行中 btw 连发 3 条：主 turn 无 abort / 无 steer 注入 / 主流历史不含 btw 内容。
 *
 * 登记：E2E-BTW-01（docs/testing/e2e-map.json，R2 按改动面 on-diff，serial 空载串行，L3 真实 LLM）。
 * 来源：btw-question 设计 §4 S7 负面场景 + impl-plan 验收计划 A7（L3 脚本）。
 * 通过标准（设计 S7 原文口径）：主 turn 全程无 abort / 无 steer 注入；主流历史不含 btw 内容（滚动检查）。
 *
 * 执行侧六要素（与 e2e-map E2E-BTW-01.note 同步维护，改其一须同 commit 改另一）：
 * - 触发：scope diff 命中（btw 会话生命周期 / 消息路由 / 协议帧 / vid 工厂 + spec 自身）时开发期
 *   按改动面执行；双凭证门 = env TAIJI_PI_LIVE=1 + 本机 provider 凭证（缺一 skip 不 fail——防
 *   `--project=electron` 全量扫跑烧 token，CI/PR/merge 门禁不跑本轨，AGENTS.md e2e 执行准则）。
 *   前置：real renderer bundle（`VITE_E2E=true pnpm run build:e2e`，不带 VITE_MOCK；mock 轨跑过
 *   之后必须重建——launch-real pre-flight 会 fail-fast 并给出重建命令）。
 * - 预算：test.setTimeout 300s；**主 turn 在飞窗口旋钮 = MAIN_PROMPT 里的 bash `sleep 40`**
 *   （真实 LLM 三轮 btw 问答须在窗口内完成；窗口不足属预算校准 → 调 sleep 秒数，禁止放宽断言
 *   或膨胀其他预算换绿灯）；单事件等待 30-90s。
 * - 事件：listen WS 订阅 mainSid 与 btw vid 的 message.message_start / message.complete；负向监听
 *   message.error / send.rejected / session.exited。失败打印 seen types（AGENTS 准则：区分
 *   「LLM 在推进但慢」与「真死锁」）。
 * - 断言（S7 三条 + 正面对照）：
 *   ① 主 turn 正常 complete 且 stopReason≠aborted，且第 3 轮 btw complete 时主 turn 尚未
 *      complete（窗口重叠 = 连发确实发生在主 turn 进行中）；
 *   ② 主会话 pi session JSONL 全文无 steer/abort 痕迹（MAIN 哨兵恰 1 次 = 无重复投递；无
 *      "stopReason":"aborted"；监听窗内无 message.error / send.rejected / session.exited 帧）；
 *   ③ 主流历史不含三问哨兵（滚动检查 = JSONL 全文扫描，强于 UI 滚动目检）；
 *      正面对照 = btw 线会话文件含三问哨兵（问题确实落线，缺席主流才有意义）。
 * - 失败归档：writeDiag 落 /tmp/s7-*.json（事件类型序 + seen types + runtime/pi 日志尾 + 目录清单）
 *   + playwright trace/screenshot/video（config retain-on-failure）+ <dataDir>/logs/（pi stdout tee，
 *   pi 卡死时唯一证据）。
 * - 重试禁令：失败先读 trace/diag 归因（窗口不足 → 调 sleep 旋钮；事件缺席 → seen types 分诊），
 *   禁止不归因直接重试、禁止放宽断言或膨胀预算换绿灯（AGENTS.md e2e 执行准则）。
 *
 * 形态说明：
 * - WS 直连驱动（TEST-STRATEGY 既定约定：UI/OS dialog 不可自动化处用 WS 触发等效业务动作）：
 *   session.create → message.send（主长 turn）→ btw.create → message.send × 3（vid 串行）。
 *   S7 断言面全部落在事件帧与 pi session JSONL，不依赖 DOM。
 * - L3 真实 LLM（impl-plan A7 方式列）：faux 统一队列无法表达「主长 turn × btw 三短问」的进程间
 *   异构节奏（两进程独立 shift 同一序列、turn 边界结构性对齐），model-keyed 分道被 btw spawn 的
 *   inheritSessionModel（model: undefined，argv 无 --model）挡死——不翻 L2.5，理由登记 e2e-map note。
 * - 凭证播种：拷本机真实 provider 配置（models.json/auth.json）+ settings 最小面（defaultProvider/
 *   defaultModel/retry）进临时 dataDir——刻意剥 packages/skills，防用户扩展/skill 清单漂移进 e2e
 *   （pi-fixture「不拷 settings 全量」同款理由）。只读源目录，不触碰真实数据目录（写删全在 tmp）。
 *
 * M4-b 只交付可运行资产 + 登记，不执行真机跑（执行 = 阶段 5 验收 A7 行）。
 */
import { test, expect } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  readRuntimeLogs,
  readPiLogs,
  waitForExtensionsReady,
  type WsFrame,
} from './fixtures/launch-app-real'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')
const SESSION_LABEL = 's7-btw-isolation'

/** 哨兵三件套：主流不含 Q 哨兵 = S7 ③；Q 哨兵在 btw 线文件 = 正面对照。 */
const MAIN_MARKER = 'TAIJI-S7-MAIN-7291'
const BTW_MARKERS = ['TAIJI-S7-Q1-7291', 'TAIJI-S7-Q2-7291', 'TAIJI-S7-Q3-7291'] as const

/** 主 turn 在飞窗口旋钮（六要素「预算」）：bash sleep 秒数，三轮 btw 问答须落其内。 */
const MAIN_TURN_SLEEP_S = 40
const MAIN_PROMPT =
  `S7 main-turn task: first use the bash tool to run exactly \`sleep ${MAIN_TURN_SLEEP_S}\`, ` +
  `wait for it to finish, then reply with only MAIN-DONE. Do not use any other tools. [${MAIN_MARKER}]`
const BTW_ROUNDS = BTW_MARKERS.length
function btwPrompt(i: number): string {
  return `Reply with exactly: PONG-${i + 1} and nothing else. Do not use any tools. [${BTW_MARKERS[i]}]`
}

/** 事件等待预算（六要素「预算」）；单轮超时即归因点，不盲目重试（六要素「重试禁令」）。 */
const EVT_TIMEOUT_MS = 60_000
const MAIN_COMPLETE_TIMEOUT_MS = 90_000
const JSONL_FLUSH_TIMEOUT_MS = 20_000

// ── 凭证门与播种（只读源 = 本机真实数据目录；写 = 临时 dataDir） ─────────────

/** 本机 provider 凭证源目录（taiji 数据目录的 agent 子树，运行时动态推导）。 */
function sourceAgentDir(): string {
  return path.join(os.homedir(), '.taiji', 'agent')
}

/** 凭证 + 默认模型门：任一 source 在位且有非空 key 才可跑（缺 → skip 理由，不 fail）。 */
function realCredentialSkipReason(): string | null {
  const src = sourceAgentDir()
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(src, 'auth.json'), 'utf8')) as Record<string, { key?: unknown }>
    if (Object.values(auth).some((c) => typeof c?.key === 'string' && c.key.trim() !== '')) return null
  } catch {
    console.warn(`[s7] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[s7] models.json 不可读：${src}`)
  }
  return `${src} 的 auth.json / models.json 均无非空 key（本机 provider 凭证缺失）`
}

/**
 * 播种临时 dataDir 的 agent 子树：拷 models.json/auth.json（存在才拷）+ 写 settings 最小面
 * （defaultProvider/defaultModel——过 runtime getDefaultModel 门禁；retry 关闭保预算确定性）。
 * 刻意剥 packages/skills：用户扩展/skill 清单不进 e2e（pi-fixture 同款防漂移理由）。
 */
function seedRealCredentials(dataDir: string): void {
  const src = sourceAgentDir()
  const dst = path.join(dataDir, 'agent')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['models.json', 'auth.json']) {
    const p = path.join(src, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, f))
  }
  let source: Record<string, unknown> = {}
  try {
    source = JSON.parse(fs.readFileSync(path.join(src, 'settings.json'), 'utf8')) as Record<string, unknown>
  } catch {
    console.warn(`[s7] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(
      `[s7] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`,
    )
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify(
      { defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } },
      null,
      2,
    ),
  )
}

// ── 诊断与轮询 helpers（失败归档 = 六要素 ⑤） ─────────────────────────────

/** 失败诊断落盘（ask-user-real 同款范式）：事件类型序 + seen types + 日志尾。 */
function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[s7] diag → /tmp/${name}`)
}

function countOf(events: WsFrame[], type: string): number {
  return events.filter((e) => e.type === type).length
}

function seenTypes(events: WsFrame[]): string[] {
  return [...new Set(events.map((e) => String(e.type)))]
}

/** 轮询等待（规范 2：真实外部事件必须轮询 + deadline，禁固定 sleep 硬等）。 */
async function waitUntil(pred: () => boolean, deadlineMs: number, intervalMs = 200): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return pred()
}

/** 递归找含哨兵的 .jsonl（主会话 / btw 线会话同款；depth 防失控）。 */
function findJsonlWithMarker(root: string, marker: string, depth = 0): string | undefined {
  if (depth > 6 || !fs.existsSync(root)) return undefined
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      const hit = findJsonlWithMarker(p, marker, depth + 1)
      if (hit) return hit
    } else if (name.endsWith('.jsonl')) {
      try {
        if (fs.readFileSync(p, 'utf8').includes(marker)) return p
      } catch {
        console.warn(`[s7] jsonl 不可读（跳过）：${p}`)
      }
    }
  }
  return undefined
}

function listJsonlUnder(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6 || !fs.existsSync(root)) return acc
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    if (fs.statSync(p).isDirectory()) listJsonlUnder(p, depth + 1, acc)
    else if (name.endsWith('.jsonl')) acc.push(p)
  }
  return acc
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// ── S7 主用例 ────────────────────────────────────────────────────────────

test('S7 (btw real): 主 turn 进行中 btw 连发 3 条 → 主 turn 无 abort / 无 steer / 主流历史不含 btw 内容', async () => {
  test.setTimeout(300_000)

  // 凭证双门（六要素「触发」）：真实 LLM 轨只在显式授权 + 本机凭证齐备时执行
  test.skip(
    process.env['TAIJI_PI_LIVE'] !== '1',
    '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则——开发期按改动面手动触发，CI/门禁不跑）',
  )
  const credSkip = realCredentialSkipReason()
  test.skip(credSkip !== null, credSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-s7-btw-'))
  seedRealCredentials(dataDir)

  const { page, cleanup } = await launchRealApp({ dataDir })
  let mainListen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  let vidListen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    // extension resolver 就绪信号（防 session.create 过早；0 = 超时继续，best-effort）
    const resolved = await waitForExtensionsReady(dataDir)
    if (resolved === 0) console.warn('[s7] extensions not ready within timeout, continue anyway')

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's7-create',
      payload: { cwd: SAMPLE_PROJECT, label: SESSION_LABEL },
    }, 's7-create')
    expect(createReply.type).toBe('session.created')
    const mainSid = (createReply.payload.session as { id: string }).id

    // 先订阅再发 prompt（broadcast 早于订阅丢消息的时序竞争防护，R2/R3 范式）
    const mainSub = await openListenWs(port, mainSid)
    mainListen = mainSub
    const mainEvents = mainSub.events

    // ── 主长 turn 起飞 ──
    const sendReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: 's7-main-send',
      payload: { sessionId: mainSid, content: MAIN_PROMPT },
    }, 's7-main-send', 30_000)
    expect(sendReply.type, '主 prompt message.send 应被接受（非 error / send.rejected）')
      .not.toBe('error')

    const started = await waitUntil(() => countOf(mainEvents, 'message.message_start') > 0, EVT_TIMEOUT_MS)
    if (!started) writeDiag('s7-main-start.json', { seen: seenTypes(mainEvents), runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000) })
    expect(started, `主 turn 未在 ${EVT_TIMEOUT_MS}ms 内 message_start（seen types: ${seenTypes(mainEvents).join(', ')}）`).toBe(true)

    // ── btw 线创建（主 turn 进行中 fork）──
    const createBtw = await wsRoundTrip(port, {
      type: 'btw.create',
      id: 's7-btw-create',
      payload: { mainSid },
    }, 's7-btw-create', 30_000)
    expect(createBtw.type).toBe('btw.create')
    const vid = createBtw.payload.vid as string
    expect(vid.startsWith('btw:'), `btw.create reply vid 应为两段式 btw: 形态，收到 "${vid}"`).toBe(true)
    console.log(`[s7] btw 线创建：vid=${vid} forkState=${String(createBtw.payload.forkState)}`)

    const vidSub = await openListenWs(port, vid)
    vidListen = vidSub
    const vidEvents = vidSub.events

    // ── 串行连发 3 条（每轮等 message.complete 再发下一轮）──
    for (let i = 0; i < BTW_ROUNDS; i++) {
      const before = countOf(vidEvents, 'message.complete')
      const roundReply = await wsRoundTrip(port, {
        type: 'message.send',
        id: `s7-q${i + 1}`,
        payload: { sessionId: vid, content: btwPrompt(i) },
      }, `s7-q${i + 1}`, 30_000)
      expect(roundReply.type, `btw 第 ${i + 1} 轮 message.send 应被接受`).not.toBe('error')
      const roundDone = await waitUntil(
        () => countOf(vidEvents, 'message.complete') > before,
        EVT_TIMEOUT_MS,
      )
      if (!roundDone) {
        writeDiag(`s7-round-${i + 1}.json`, {
          round: i + 1,
          seen: seenTypes(vidEvents),
          runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
          piLogsTail: readPiLogs(dataDir).slice(-3000),
        })
      }
      expect(
        roundDone,
        `btw 第 ${i + 1} 轮未在 ${EVT_TIMEOUT_MS}ms 内 message.complete（seen types: ${seenTypes(vidEvents).join(', ')}）`,
      ).toBe(true)
    }

    // ── 断言 ①（窗口重叠）：第 3 轮完成时主 turn 仍在飞 ──
    const mainDoneBeforeRound3End = countOf(mainEvents, 'message.complete') > 0
    if (mainDoneBeforeRound3End) {
      writeDiag('s7-window.json', {
        hint: `主 turn 在三轮完成前已结束——在飞窗口不足，调 MAIN_PROMPT sleep（当前 ${MAIN_TURN_SLEEP_S}s），不放宽断言`,
        mainEventTypes: seenTypes(mainEvents),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(
      mainDoneBeforeRound3End,
      `第 3 轮 btw complete 时主 turn 已 message.complete——S7 窗口重叠断言失败（预算旋钮 = MAIN_TURN_SLEEP_S=${MAIN_TURN_SLEEP_S}）`,
    ).toBe(false)

    // ── 断言 ①（无 abort）：等主 turn 正常收口 ──
    const mainDone = await waitUntil(
      () => countOf(mainEvents, 'message.complete') > 0,
      MAIN_COMPLETE_TIMEOUT_MS,
    )
    if (!mainDone) writeDiag('s7-main-complete.json', { seen: seenTypes(mainEvents), piLogsTail: readPiLogs(dataDir).slice(-3000) })
    expect(mainDone, `主 turn 未在 ${MAIN_COMPLETE_TIMEOUT_MS}ms 内 message.complete（seen types: ${seenTypes(mainEvents).join(', ')}）`).toBe(true)
    const mainComplete = mainEvents.filter((e) => e.type === 'message.complete').at(-1)
    const mainStopReason = mainComplete?.payload?.['stopReason']
    expect(mainStopReason, `主 turn stopReason 应非 aborted（收到 "${String(mainStopReason)}"）`).not.toBe('aborted')
    expect(mainStopReason, `主 turn stopReason 应非 error（收到 "${String(mainStopReason)}"）`).not.toBe('error')

    // ── 断言 ②（事件面负向）：监听窗内无 error / rejected / exited 帧 ──
    const badMainFrames = mainEvents.filter((e) =>
      e.type === 'message.error' || e.type === 'send.rejected' || e.type === 'session.exited')
    if (badMainFrames.length > 0) {
      writeDiag('s7-main-bad-frames.json', { frames: badMainFrames, allTypes: seenTypes(mainEvents) })
    }
    expect(
      badMainFrames.map((e) => e.type),
      '主会话监听窗内不应出现 message.error / send.rejected / session.exited（= steer/abort/失败 注入面）',
    ).toEqual([])

    mainSub.ws.close()
    vidSub.ws.close()
    mainListen = undefined
    vidListen = undefined

    // ── 断言 ②③（持久面）：pi session JSONL 全文滚动检查 ──
    const agentDir = path.join(dataDir, 'agent')
    const found = await waitUntil(
      () => fs.existsSync(path.join(agentDir, 'sessions'))
        && fs.readdirSync(path.join(agentDir, 'sessions')).some((f) => f.endsWith('.jsonl')),
      JSONL_FLUSH_TIMEOUT_MS,
    )
    expect(found, `主会话 JSONL 应已落盘（${path.join(agentDir, 'sessions')}）`).toBe(true)

    const mainFile = await (async () => {
      const hit = await waitUntil(
        () => findJsonlWithMarker(path.join(agentDir, 'sessions'), MAIN_MARKER) !== undefined,
        JSONL_FLUSH_TIMEOUT_MS,
      )
      return hit ? findJsonlWithMarker(path.join(agentDir, 'sessions'), MAIN_MARKER) : undefined
    })()
    if (!mainFile) {
      writeDiag('s7-main-file-missing.json', {
        sessionsDir: listJsonlUnder(path.join(agentDir, 'sessions')),
        btwDir: listJsonlUnder(path.join(agentDir, 'btw')),
      })
    }
    expect(mainFile, '含 MAIN 哨兵的主会话 JSONL 应可定位（零直写约束下由 pi 自己落盘）').toBeDefined()

    const mainText = fs.readFileSync(mainFile!, 'utf8')
    // ② steer/重复投递面：MAIN 哨兵恰 1 次 + 全文无 aborted
    expect(
      countOccurrences(mainText, MAIN_MARKER),
      '主会话 JSONL 中 MAIN 哨兵应恰 1 次（>1 = 主 prompt 被重复投递/steer 注入痕迹）',
    ).toBe(1)
    expect(mainText.includes('"stopReason":"aborted"'), '主会话 JSONL 不应含 aborted 终态（= 无 abort）').toBe(false)
    // ③ 主流历史不含 btw 内容（滚动检查 = 全文扫描三问哨兵）
    const leaked = BTW_MARKERS.filter((m) => mainText.includes(m))
    if (leaked.length > 0) writeDiag('s7-leak.json', { leaked, mainFile })
    expect(leaked, '主会话 JSONL 全文不应含任何 btw 问哨兵（= 主流历史不含 btw 内容）').toEqual([])

    // 正面对照：三问确实落进 btw 线会话文件（缺席主流才有意义）
    const btwFile = findJsonlWithMarker(path.join(agentDir, 'btw'), BTW_MARKERS[0])
    if (!btwFile) {
      writeDiag('s7-btw-file-missing.json', { btwDir: listJsonlUnder(path.join(agentDir, 'btw')) })
    }
    expect(btwFile, 'btw 线会话文件（<agentDir>/btw/<encodeCwd>/<mainSid>/）应含三问哨兵').toBeDefined()
    const btwText = fs.readFileSync(btwFile!, 'utf8')
    for (const m of BTW_MARKERS) {
      expect(btwText.includes(m), `btw 线文件应含哨兵 ${m}（正面对照）`).toBe(true)
    }

    console.log(`[s7] PASS：主 turn 无 abort/无 steer、主流历史不含 btw 内容（mainFile=${mainFile}）`)
  } finally {
    try {
      mainListen?.ws.close()
      vidListen?.ws.close()
    } finally {
      await cleanup()
      if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    }
  }
})
