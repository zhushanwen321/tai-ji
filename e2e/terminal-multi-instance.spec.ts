/**
 * 终端多实例端到端验收 —— 真实 app 轨（L2，零 token，无任何 LLM 调用）。
 *
 * 覆盖设计 `.tmp/tech-design/terminal-multi-instance.md` §4 T1-T13 中**可脚本化**的部分
 * （逐条对应见各 test 标题的 T 号标注）：
 *
 * - T1 双终端并行（脚本化部分）：⌃`/StatusBar 开底部抽屉 → 「终端 1」→ 「+」→ 两条目 →
 *   两实例各自跑命令并断言**输出**可见 → 切换来回各自历史在屏（分区隔离）→ 不可见实例隐藏期
 *   到达的新输出在切回时回放上屏（T1_C 隐藏期累积锚，见下）
 * - T2 关闭隔离：关第二个实例 → 条目恢复 1 个、关闭按钮回禁用态、终端 2 的 PTY shell 进程
 *   消失（真机进程级断言）、焦点落相邻的终端 1（activeElement 断言）、终端 1 仍可写（进程存活）
 * - T4 会话级联：多实例会话 → `session.delete` → runtime 实例清单空 + PTY shell 进程消失
 *   （进程级断言，无孤儿）；本 spec 未覆盖的会话删除 UI 交互归 D3 verify 剧本
 * - T8 序号不复用：关「终端 2」→「+」→ 新条目序号为 3、输出区空白
 * - T9 最后实例自然退出：唯一实例敲 `exit` → 空态 + 「+」可用 → 新建得序号 2（不回落 1）
 * - T10 runtime 重启边界：杀 runtime → supervisor 重生（token 变化 = 世代变更）→ App.vue
 *   非 connected 态整壳替换 AppShell（TerminalView 卸载）→ 重连后重挂载，挂载腿对账得空清单
 *   自动新建本世代默认实例 → 恰 1 条实例且编号 = `term:<sid>:1`（世代重置证据）→ 回显命令
 *   输出正常、无上一世代串入
 * - T13 跨会话不误清：会话 A 双实例 → 切 B（触发 B 的 terminal.list 对账）→ 切回 A →
 *   A 的条目 / 分区 / 历史输出保持
 *
 * 不在本 spec 覆盖（归属声明，防重复劳动）：
 * - T3 刷新恢复 / T5 单实例无感：L4 真机走查（impl-plan §4.4 A3/A5；刷新后进程存活的
 *   前提 P3 已由 u0-probe 探针核实成立）
 * - T6 幂等防御 / T7 最后实例保护 / T11 同世代闪断 / T12 非世代广播沿：L1 单测
 *   （u1 runtime 协议测试 + u3-bar 组件测试 + u2「世代与对账」测试）
 * - T1/T2 的「三腿资源释放 / 滞留命令提示」与 T10 的 write-queue 重置细节：artefact 单测
 *   承载（impl-plan §4.4）；「焦点落相邻」在 T2 做真机 activeElement 断言（impl-plan §4.4
 *   A2 明列的 L3 可脚本化判据），不由单测承载
 *
 * 运行（开发阶段按改动范围空载串行，禁全量扫跑——项目 AGENTS.md e2e 执行准则）：
 *   VITE_E2E=true pnpm run build:e2e   # real renderer bundle（不带 VITE_MOCK）
 *   npx playwright test e2e/terminal-multi-instance.spec.ts
 *
 * 轨道自保护（沿用 workflow-disconnect-recovery.spec.ts 的 skip 门惯例）：当前 renderer
 * 产物是 mock bundle 时 skip 不 fail（real 轨需 real bundle）；`--list` 不受影响。
 */
import { test, expect, type Page } from '@playwright/test'
import { launchRealApp, waitForRuntime, wsRoundTrip, type WsFrame } from './fixtures/launch-app-real'
// 轨道判据共享（launch-app-real.ts assertRealRendererBundle 同源导出）：mock/real 两轨共用
// apps/electron/renderer/dist，MOCK_BUNDLE_MARKER 是「当前产物是 mock 构建」的判据
import { RENDERER_DIST_ASSETS, MOCK_BUNDLE_MARKER } from './fixtures/launch-app'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

// ── 超时/节奏常量（全部走 deadline 轮询，禁固定 waitForTimeout）──────────────
const RUNTIME_START_TIMEOUT_MS = 30_000
const SESSION_VISIBLE_TIMEOUT_MS = 30_000
const INSTANCE_SETTLE_TIMEOUT_MS = 30_000
const OUTPUT_TIMEOUT_MS = 20_000
const GENERATION_CHANGE_TIMEOUT_MS = 90_000
const TOKEN_POLL_INTERVAL_MS = 300

/** 输出断言标记（命令行里不出现标记字面量，防「命令回显」冒充「命令输出」）。 */
const T1_A = { cmd: 'echo T1A-$((12*34))', out: 'T1A-408' }
const T1_B = { cmd: 'echo T1B-$((56*78))', out: 'T1B-4368' }
// 隐藏期累积锚：命令在终端 1 可见时发出、输出在终端 1 被隐藏期间到达，切回后才断言新标记——
// 只在「不可见实例订阅保持 + 分区累积 + 切回回放」全链成立时可见（单测 RT-1 只证 data 帧按
// terminalId 落分区，不覆盖 WS 实链路 + 隐藏期累积）。延迟量级须显著大于中间步骤耗时
// （createInstance → 切终端 2 → 跑 T1_B → 两条 exclude 断言，实测约 1.5-3s），保证 T1_C 在隐藏
// 期已上屏；sleep 10 对中间步骤留足余量，不得缩小到同量级（否则输出可能晚于切回终端 1，
// 排除断言仍绿但隐藏期累积未被真正覆盖）。
const T1_C = { cmd: 'sleep 10; echo T1C-$((7*7))', out: 'T1C-49' }
const T2_MARK = { cmd: 'echo T2R-$((25*2))', out: 'T2R-50' }
const T8_MARK = { cmd: 'echo T8C-$((9*91))', out: 'T8C-819' }
const T8_UNIQ = { cmd: 'echo T8U-$((3*3))', out: 'T8U-9' }
const T10_MARK = { cmd: 'echo T10-$((77*3))', out: 'T10-231' }
const T13_A1 = { cmd: 'echo T13A-$((31*2))', out: 'T13A-62' }
const T13_A2 = { cmd: 'echo T13B-$((32*2))', out: 'T13B-64' }

// ── 轨道自保护门 ──────────────────────────────────────────────────────────

/** 当前 renderer 产物是 mock bundle 时返回 skip 原因；否则 null（real 轨可跑）。 */
function mockBundleSkipReason(): string | null {
  if (!fs.existsSync(RENDERER_DIST_ASSETS)) return null
  const mockAsset = fs
    .readdirSync(RENDERER_DIST_ASSETS)
    .filter((f) => f.endsWith('.js'))
    .find((f) => fs.readFileSync(path.join(RENDERER_DIST_ASSETS, f), 'utf8').includes(MOCK_BUNDLE_MARKER))
  if (!mockAsset) return null
  return (
    `轨道自保护：当前 renderer 产物是 mock bundle（assets/${mockAsset} 含 mock fixture 标记），` +
    '本终端多实例轨为真实 app 轨，需 real bundle——rebuild with: VITE_E2E=true pnpm run build:e2e（不传 VITE_MOCK）后再跑'
  )
}

// ── 启动 / 会话 / UI 驱动 helper ──────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 本 spec 的测试替身形状（非契约接口——无实现方/被实现语义，故用类型别名）。 */
type AppHarness = {
  page: Page
  cleanup: () => Promise<void>
  dataDir: string
  port: number
}

/** 启动真实 app（无 LLM：faux responses 空脚本）+ 等 runtime 健康 + 开临时 dataDir。 */
async function launchHarness(): Promise<AppHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-term-multi-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: [] } })
  await expect(page).toHaveTitle(/太极/)
  const port = await waitForRuntime(dataDir, RUNTIME_START_TIMEOUT_MS)
  return { page, cleanup, dataDir, port }
}

/** 关闭 app + 清理自建临时 dataDir（mkdtemp 自建自删红线）。 */
async function teardownHarness(h: AppHarness): Promise<void> {
  await h.cleanup()
  fs.rmSync(h.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/**
 * 通过 WS 建会话（OS 原生选目录 dialog 不可自动化，TEST-STRATEGY 约定 WS 直连触发等效业务
 * 动作）。runtime 经 `broadcastSessionList` 全量刷新列表，renderer 侧栏随即可见。
 */
async function createSession(port: number, id: string, label: string): Promise<string> {
  const reply = await wsRoundTrip(
    port,
    { type: 'session.create', id, payload: { cwd: SAMPLE_PROJECT, label } },
    id,
  )
  expect(reply.type, `session.create 应回 session.created（${label}）`).toBe('session.created')
  return (reply.payload?.session as { id: string }).id
}

/** 在侧栏选中会话（面板 leaf 绑定该 session → 底抽屉的终端面板随之激活该会话）。 */
async function selectSessionInSidebar(page: Page, label: string): Promise<void> {
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: SESSION_VISIBLE_TIMEOUT_MS })
  await item.click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: SESSION_VISIBLE_TIMEOUT_MS })
}

/** 打开底抽屉（StatusBar 终端开关；⌃` 的鼠标等价入口，设计 §3.3 双入口）。幂等。 */
async function openTerminalDrawer(page: Page): Promise<void> {
  const toggle = page.getByTestId('statusbar-terminal-toggle')
  await expect(toggle).toBeVisible({ timeout: SESSION_VISIBLE_TIMEOUT_MS })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click()
  }
  await expect(page.getByTestId('terminal-view')).toBeVisible({ timeout: INSTANCE_SETTLE_TIMEOUT_MS })
}

/** 终端条目集合（切换条内每个实例一条）。 */
function instanceItems(page: Page) {
  return page.getByTestId('terminal-instance-item')
}

/** 等实例条目数到达期望值（切换条内容随 ack / 对账建立，属异步链路）。 */
async function expectInstanceCount(page: Page, count: number, timeoutMs = INSTANCE_SETTLE_TIMEOUT_MS): Promise<void> {
  await expect(instanceItems(page)).toHaveCount(count, { timeout: timeoutMs })
}

/** 第 index 条实例的编号（`term:<sid>:<seq>`）。 */
async function terminalIdAt(page: Page, index: number): Promise<string> {
  const id = await instanceItems(page).nth(index).getAttribute('data-terminal-id')
  expect(id, `第 ${index} 条实例应有 data-terminal-id`).toBeTruthy()
  return id as string
}

/** 从编号解析会话内序号（`: <n>` 尾段）。 */
function seqOf(terminalId: string): number {
  const m = /:(\d+)$/.exec(terminalId)
  return m ? Number(m[1]) : -1
}

/**
 * 点第 index 条实例切换当前显示终端，并**等视图真正切过去**再返回（防“先在旧 xterm 上敲键”）。
 * xterm 视图随 active 变化重建，重建完成的判据用目标分区的可见文本：
 * - excludeText：目标实例为空时，等旧实例的标记从屏幕消失；
 * - expectText：目标实例有历史输出时，等该输出重新回放上屏。
 */
async function selectInstance(
  page: Page,
  index: number,
  opts: { expectText?: string; excludeText?: string } = {},
): Promise<void> {
  await instanceItems(page).nth(index).click()
  await expect(instanceItems(page).nth(index)).toHaveAttribute('data-active', 'true', {
    timeout: INSTANCE_SETTLE_TIMEOUT_MS,
  })
  if (opts.excludeText) await expectTerminalTextExcludes(page, opts.excludeText)
  if (opts.expectText) await expectTerminalOutput(page, opts.expectText)
}

/** 点「+」新建实例。 */
async function createInstance(page: Page): Promise<void> {
  await page.getByTestId('terminal-instance-create').click()
}

/** 关闭指定编号的实例（切换条悬停关闭按钮）。 */
async function closeInstance(page: Page, terminalId: string): Promise<void> {
  const closeBtn = page.locator(`[data-testid="terminal-instance-close"][data-terminal-id="${terminalId}"]`)
  await expect(closeBtn).toBeVisible({ timeout: INSTANCE_SETTLE_TIMEOUT_MS })
  await closeBtn.click()
}

/**
 * 当前显示终端的可见文本（xterm 默认 DOM 渲染器，视口行文本在 `.xterm-rows`）。
 * 渲染器若换 canvas/webgl，此读取面需同步改为 buffer 读取——本 spec 以 DOM 文本为断言面。
 */
async function readTerminalText(page: Page): Promise<string> {
  const rows = page.locator('[data-testid="terminal-xterm"] .xterm-rows')
  if ((await rows.count()) === 0) return ''
  return rows.innerText()
}

/**
 * 在终端里跑一条命令：点 xterm 屏幕聚焦输入区 → 逐字键入 → 回车（走真实用户输入链路）。
 * 用 click（而非 textarea.focus）——切换实例时 xterm 视图会重建，click 会自动重解析并
 * 重试，避免押在切瞬时的旧/新 textarea 上。
 */
async function runInTerminal(page: Page, command: string): Promise<void> {
  const screen = page.locator('[data-testid="terminal-xterm"] .xterm-screen')
  await screen.click({ position: { x: 12, y: 12 } })
  const textarea = page.locator('[data-testid="terminal-xterm"] .xterm-helper-textarea')
  await expect(textarea).toBeFocused({ timeout: 5_000 })
  await page.keyboard.type(command, { delay: 10 })
  await page.keyboard.press('Enter')
}

/** 等命令**输出**可见（输出标记不出现在命令行字面量中 → 只有真执行才会出现）。 */
async function expectTerminalOutput(page: Page, marker: string): Promise<void> {
  await expect
    .poll(() => readTerminalText(page), { timeout: OUTPUT_TIMEOUT_MS, intervals: [200, 500, 1000] })
    .toContain(marker)
}

/** 当前显示终端不应包含某文本（切换实例后分区隔离 / 新实例输出区空白断言）。 */
async function expectTerminalTextExcludes(page: Page, marker: string): Promise<void> {
  await expect
    .poll(() => readTerminalText(page), { timeout: OUTPUT_TIMEOUT_MS, intervals: [200, 500, 1000] })
    .not.toContain(marker)
}

// ── 进程级 helper（T2 / T4 / T10）──────────────────────────────────────────

/** 监听指定端口的进程 pid（runtime = WS server）。空数组 = 未找到。 */
function pidsListeningOnPort(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n))
  } catch {
    return []
  }
}

function commandOfPid(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** runtime 进程 pid（唯一监听端口的进程）。 */
function runtimePidOnPort(port: number): number {
  const pids = pidsListeningOnPort(port)
  expect(pids.length, `端口 ${port} 应有唯一监听进程（runtime）`).toBeGreaterThan(0)
  return pids[0]
}

/** runtime 直接子进程中的 shell（PTY 宿主：node-pty forkpty 的子进程）。 */
function ptyShellPids(runtimePid: number): number[] {
  let children: number[] = []
  try {
    children = execFileSync('pgrep', ['-P', String(runtimePid)], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n))
  } catch {
    // pgrep 无匹配时 exit 1 → 无子进程
    return []
  }
  return children.filter((pid) => /(?:^|[\s/-])(?:zsh|bash|sh)(?:\s|$)/.test(commandOfPid(pid)))
}

/**
 * 轮询等 runtime 的 PTY shell 子进程数达到期望值，返回末次采样的 pid 列表。
 * spawn 后 forkpty 建 shell 与 ack / 条目建立之间有极短窗口，立即读会漏采（漏采会让
 * 「进程消失」断言证明力不足——本 helper 是 T2 实例归属与 T4 全杀断言的共同前置）。
 */
async function waitForPtyShellCount(runtimePid: number, count: number): Promise<number[]> {
  let pids: number[] = []
  await expect
    .poll(
      () => {
        pids = ptyShellPids(runtimePid)
        return pids.length
      },
      { timeout: INSTANCE_SETTLE_TIMEOUT_MS, intervals: [100, 200, 500, 1000] },
    )
    .toBe(count)
  return pids
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `terminal.list` 查询（对账口径：范围 = 被查会话）。返回实例编号清单。 */
async function listInstancesViaWs(port: number, sessionId: string): Promise<string[]> {
  const id = `terminal-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reply: WsFrame = await wsRoundTrip(port, { type: 'terminal.list', id, payload: { sessionId } }, id)
  const instances = (reply.payload?.instances ?? []) as { terminalId?: string }[]
  return instances.map((i) => i.terminalId ?? '')
}

/** 读 runtime auth token 文件（世代核对判据操作数；缺失返回空串）。 */
function readRuntimeToken(dataDir: string): string {
  try {
    return fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 等 runtime 世代变更（每次 spawn 重新生成 token；旧 token 消失 = 新 runtime 已就绪）。 */
async function waitForGenerationChange(dataDir: string, previousToken: string): Promise<void> {
  const deadline = Date.now() + GENERATION_CHANGE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = readRuntimeToken(dataDir)
    if (current !== '' && current !== previousToken) return
    await sleep(TOKEN_POLL_INTERVAL_MS)
  }
  throw new Error(`runtime token 未刷新（${GENERATION_CHANGE_TIMEOUT_MS}ms）——supervisor 未重启 runtime？`)
}

/** 建一个已激活的会话 + 打开终端抽屉 + 等默认实例（返回 sessionId 与第 0 条编号）。 */
async function openSessionWithTerminal(h: AppHarness, label: string): Promise<{ sessionId: string; firstTerminalId: string }> {
  const sessionId = await createSession(h.port, `create-${label}`, label)
  await selectSessionInSidebar(h.page, label)
  await openTerminalDrawer(h.page)
  await expectInstanceCount(h.page, 1)
  return { sessionId, firstTerminalId: await terminalIdAt(h.page, 0) }
}

// ── T1 双终端并行（脚本化部分）──────────────────────────────────────────

test('T1: 双终端并行——「+」新建第二实例、两实例各自输出独立推进、切换来回历史在屏', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(180_000)
  const h = await launchHarness()
  try {
    await openSessionWithTerminal(h, 'term-t1')

    // 终端 1 跑命令 → 输出可见（输出标记不在命令行字面量里，证明是命令执行结果）
    await runInTerminal(h.page, T1_A.cmd)
    await expectTerminalOutput(h.page, T1_A.out)

    // 隐藏期累积锚（设计 §3.1 成功路径「另一实例日志也在各自推进」/ §4 T1「两实例输出独立推进」）：
    // 切走终端 1 前发一条延迟出标记的命令——Enter 后 10s 才输出（量级须显著大于中间步骤耗时，
    // 保证 T1_C 在隐藏期已上屏），期间界面已切到终端 2（下方
    // 新建 → 切到终端 2 → 跑 T1_B 恰好覆盖这段窗口）；该标记不出现在命令行字面量里，故只有
    // 真执行才出现。切回终端 1 时断言它上屏 = 封闭「不可见实例在新输出到达时累积 → 切回回放」链。
    await runInTerminal(h.page, T1_C.cmd)

    // 「+」新建 → 条目变为两个，且编号序号递增（runtime 分配，经 ack 回传）
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)
    const id2 = await terminalIdAt(h.page, 1)
    expect(seqOf(id2), '新建实例应为终端 2').toBe(2)

    // 新建即进入可写态：切到终端 2（等视图切过去），敲命令有回显、输出独立推进
    await selectInstance(h.page, 1, { excludeText: T1_A.out })
    await runInTerminal(h.page, T1_B.cmd)
    await expectTerminalOutput(h.page, T1_B.out)
    // 分区隔离：终端 2 看不到终端 1 的输出历史
    await expectTerminalTextExcludes(h.page, T1_A.out)
    // 终端 1 隐藏期到达的 T1_C 输出也不得串入当前显示的终端 2 分区（应落在终端 1 分区）
    await expectTerminalTextExcludes(h.page, T1_C.out)

    // 切回终端 1：历史输出完整在屏（设计 §1 目标 2）；且不含终端 2 输出
    await selectInstance(h.page, 0, { expectText: T1_A.out })
    await expectTerminalTextExcludes(h.page, T1_B.out)
    // 隐藏期累积锚的收口断言：终端 1 不可见期间到达的 T1_C 输出已在切回时回放上屏（新标记，
    // 非切换前就在屏的旧标记 T1_A）——不可见实例的输出在此前全程无断言（切回只断旧标记时，
    // 隐藏期丢输出仍全绿）
    await expectTerminalOutput(h.page, T1_C.out)

    // 再切回终端 2：其历史同样在屏
    await selectInstance(h.page, 1, { expectText: T1_B.out })
  } finally {
    await teardownHarness(h)
  }
})

// ── T2 关闭隔离（+ T7 最后实例关闭按钮禁用态）────────────────────────────

test('T2: 关闭隔离——关第二实例后其进程消失、条目回 1、关闭按钮禁用、焦点落终端 1', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(180_000)
  const h = await launchHarness()
  try {
    await openSessionWithTerminal(h, 'term-t2')

    // 终端 1 留下历史输出
    await runInTerminal(h.page, T1_A.cmd)
    await expectTerminalOutput(h.page, T1_A.out)

    // 进程级锚准备（设计 §4 T2「终端 2 进程消失、终端 1 的进程存活」）：runtime 是 PTY shell
    // 的直接父进程；此刻只有终端 1 的 shell，先记下它作「未被波及」的对照（新建前后差集即
    // 终端 2 的 shell，不靠命令行文本归属）。
    const runtimePid = runtimePidOnPort(h.port)
    const [pid1] = await waitForPtyShellCount(runtimePid, 1)
    if (pid1 === undefined) throw new Error('终端 1 的 PTY shell 子进程未出现（进程级锚准备失败）')

    // 终端 2 起一个长命令（关闭 = 杀进程）
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)
    const id2 = await terminalIdAt(h.page, 1)
    await selectInstance(h.page, 1, { excludeText: T1_A.out })
    await runInTerminal(h.page, 'sleep 300')

    const pid2 = (await waitForPtyShellCount(runtimePid, 2)).find((pid) => pid !== pid1)
    if (pid2 === undefined) throw new Error('终端 2 的 PTY shell 子进程未出现（进程级锚准备失败）')

    // 关闭终端 2 → 条目恢复 1 个
    await closeInstance(h.page, id2)
    await expectInstanceCount(h.page, 1)

    // T7 禁用态：只剩一个实例时关闭按钮 disabled（UI 供养规则，防误触破坏性关闭）
    await expect(h.page.locator('[data-testid="terminal-instance-close"]')).toBeDisabled()
    // 「+」始终可用
    await expect(h.page.getByTestId('terminal-instance-create')).toBeEnabled()

    // 焦点规则（设计 §3.3「焦点规则」/ §4 T2「焦点落相邻实例」）：关掉右侧的终端 2 后焦点落
    // 其右侧相邻（无右取左）= 仅剩的终端 1 的输入区（xterm helper textarea；impl-plan §4.4 A2
    // 明列的 activeElement 断言在此落地）。
    await expect(h.page.locator('[data-testid="terminal-xterm"] .xterm-helper-textarea')).toBeFocused({
      timeout: INSTANCE_SETTLE_TIMEOUT_MS,
    })

    // 进程级断言（本轨的真机锚，补 u1 单测只验 mock pty.kill 调用的盲区）：终端 2 的 shell 进程
    // 已消失，终端 1 的 shell 仍存活、PTY 集合恰好回到 1（关闭未波及终端 1）
    await expect
      .poll(() => isProcessAlive(pid2), { timeout: INSTANCE_SETTLE_TIMEOUT_MS, intervals: [200, 500, 1000] })
      .toBe(false)
    expect(isProcessAlive(pid1), '终端 1 的 shell 进程应存活（关闭终端 2 未波及）').toBe(true)
    expect(await waitForPtyShellCount(runtimePid, 1)).toEqual([pid1])

    // 终端 1 输出连续：再跑一条命令仍有输出
    await expectTerminalOutput(h.page, T1_A.out)
    await runInTerminal(h.page, T2_MARK.cmd)
    await expectTerminalOutput(h.page, T2_MARK.out)

    // 关闭沿滞留命令提示 / 三腿资源释放细节由 u2 单测承载（impl-plan §4.4 A2）；本轨锚用户可见面
    // + 真机进程级（上）与 activeElement（上）两处 L3 判据
  } finally {
    await teardownHarness(h)
  }
})

// ── T4 会话级联（无孤儿进程）────────────────────────────────────────────

test('T4: 会话级联——删除多实例会话后 runtime 实例清单空 + PTY shell 进程消失（无孤儿）', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(180_000)
  const h = await launchHarness()
  try {
    const { sessionId } = await openSessionWithTerminal(h, 'term-t4')
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)

    // 会话删除前：记录 runtime 下的 PTY shell 进程——两实例各一个，等第二个 shell 也起来
    // 再采集（只捕到部分 shell 会让下面的「全杀」断言证明力不足）
    const runtimePid = runtimePidOnPort(h.port)
    const shellPids = await waitForPtyShellCount(runtimePid, 2)
    expect(new Set(shellPids).size, '双实例会话应有两个各不相同的 PTY shell 子进程').toBe(2)

    // 删除会话（WS 直连等效业务动作；UI 右键删除路径归 D3 verify 剧本）
    const reply = await wsRoundTrip(h.port, { type: 'session.delete', id: 't4-del', payload: { sessionId } }, 't4-del')
    expect(reply.type).toBe('session.deleted')

    // runtime 注册表：该会话实例清单归零（u4 destroySessionPties 扇出）
    await expect
      .poll(() => listInstancesViaWs(h.port, sessionId), { timeout: INSTANCE_SETTLE_TIMEOUT_MS, intervals: [200, 500, 1000] })
      .toEqual([])

    // 进程级断言：删除前捕获的 PTY shell 全部消失（无孤儿进程）
    await expect
      .poll(() => shellPids.filter(isProcessAlive).length, { timeout: INSTANCE_SETTLE_TIMEOUT_MS, intervals: [200, 500, 1000] })
      .toBe(0)

    // UI：会话从侧栏消失
    await expect(h.page.locator('.session-item').filter({ hasText: 'term-t4' })).toHaveCount(0, {
      timeout: SESSION_VISIBLE_TIMEOUT_MS,
    })
  } finally {
    await teardownHarness(h)
  }
})

// ── T8 序号不复用 ──────────────────────────────────────────────────────

test('T8: 关最后一个实例后新建不复用序号——新条目为终端 3 且输出区空白', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(180_000)
  const h = await launchHarness()
  try {
    await openSessionWithTerminal(h, 'term-t8')
    // 终端 1 留下输出，作为后续切实例时「视图已真正切过去」的判据
    await runInTerminal(h.page, T8_UNIQ.cmd)
    await expectTerminalOutput(h.page, T8_UNIQ.out)
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)
    const id2 = await terminalIdAt(h.page, 1)
    expect(seqOf(id2)).toBe(2)

    // 在被关闭的实例里留下输出（用于验证新实例输出区空白，无历史串入）
    await selectInstance(h.page, 1, { excludeText: T8_UNIQ.out })
    await runInTerminal(h.page, T8_MARK.cmd)
    await expectTerminalOutput(h.page, T8_MARK.out)

    // 关闭终端 2 → 「+」新建 → 序号必须递增为 3（死绝 / 关闭后序号不回落、不复用）
    await closeInstance(h.page, id2)
    await expectInstanceCount(h.page, 1)
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)
    const ids = [await terminalIdAt(h.page, 0), await terminalIdAt(h.page, 1)]
    const seqs = ids.map(seqOf).sort((a, b) => a - b)
    expect(seqs, '新建实例应为终端 3，不复用终端 2').toEqual([1, 3])

    // 新实例输出区空白：无被关实例的历史输出串入（exclude T8_UNIQ = 已切到终端 3 视图）
    await selectInstance(h.page, 1, { excludeText: T8_UNIQ.out })
    await expectTerminalTextExcludes(h.page, T8_MARK.out)
  } finally {
    await teardownHarness(h)
  }
})

// ── T9 最后实例自然退出归零 ──────────────────────────────────────────────

test('T9: 最后实例自然退出——exit 后空态 + 「+」可用、新建得序号 2（不回落 1）', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(180_000)
  const h = await launchHarness()
  try {
    await openSessionWithTerminal(h, 'term-t9')

    // 唯一实例里敲 exit（自然退出 = 关闭沿同语义）
    await runInTerminal(h.page, 'exit')
    // 空态：切换条占位 + 「+」常驻可用
    await expect(h.page.getByTestId('terminal-instance-empty')).toBeVisible({ timeout: INSTANCE_SETTLE_TIMEOUT_MS })
    await expectInstanceCount(h.page, 0)
    await expect(h.page.getByTestId('terminal-instance-create')).toBeEnabled()

    // 新建 → 序号不回落（沿用会话计数器，得终端 2 而非终端 1）
    await createInstance(h.page)
    await expectInstanceCount(h.page, 1)
    const id = await terminalIdAt(h.page, 0)
    expect(seqOf(id), '唯一实例自然退出后新建应得终端 2（序号不回落）').toBe(2)
  } finally {
    await teardownHarness(h)
  }
})

// ── T10 runtime 重启边界（世代变更重置）─────────────────────────────────

test('T10: runtime 重启边界——杀 runtime 后世代重置为终端 1、回显正常无串入', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(240_000)
  const h = await launchHarness()
  try {
    // 双实例各有输出（旧世代痕迹，用于「无串入」负向断言）
    const { sessionId } = await openSessionWithTerminal(h, 'term-t10')
    await runInTerminal(h.page, T1_A.cmd)
    await expectTerminalOutput(h.page, T1_A.out)
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)
    await selectInstance(h.page, 1, { excludeText: T1_A.out })
    await runInTerminal(h.page, T1_B.cmd)
    await expectTerminalOutput(h.page, T1_B.out)

    // 杀 runtime（SIGKILL）→ supervisor 自动重启（世代变更 = auth token 刷新）
    const previousToken = readRuntimeToken(h.dataDir)
    expect(previousToken, '重启前应能读到 runtime token（世代核对旧值）').not.toBe('')
    const runtimePid = runtimePidOnPort(h.port)
    // 重挂载判据的操作数：记录旧 AppShell 的 terminal-view 节点（同一 DOM 节点不跨重挂载复用）
    const preRestartTerminalView = await h.page.getByTestId('terminal-view').elementHandle()
    expect(preRestartTerminalView, '重启前 terminal-view 应在场（重挂载判据操作数）').not.toBeNull()
    process.kill(runtimePid, 'SIGKILL')
    await waitForGenerationChange(h.dataDir, previousToken)

    // 世代变更 → App.vue 非 connected 态整壳替换 AppShell（App.vue:7），TerminalView 随之卸载。
    // **「条目数 0」不能作「重置已发生」的判据**：整壳卸载期 `terminal-instance-item` 不存在，
    // `toHaveCount(0)` 恒真（实测 6.5ms 即通过）——必须先等旧 AppShell 卸载（旧 terminal-view
    // 节点 detach；ElementHandle 的 'hidden' 对已 detach 节点同样成立）→ 再等重挂载后的
    // terminal-view 可见，此后条目数才反映新 runtime 的真实注册表。
    await preRestartTerminalView?.waitForElementState('hidden', { timeout: GENERATION_CHANGE_TIMEOUT_MS })
    await expect(h.page.getByTestId('terminal-view')).toBeVisible({ timeout: GENERATION_CHANGE_TIMEOUT_MS })
    // 重挂载后抽屉保持打开（面板 store 跨整壳替换存活）；本调用幂等，兼作兜底
    await openTerminalDrawer(h.page)

    // 重置的可观测终态：空态在本链路不可稳定观测——重连 remount 触发 TerminalView 挂载腿
    // `reconcileInstances → 空清单 → spawnWithFeedback` 自动新建本世代默认实例（u2 既定行为），
    // 空态窗口 ~50-150ms 短于 100ms 起的轮询间隔 → 不断言空态，断言终态：恰 1 条实例且编号
    // = `term:<sid>:1`（新世代序号从 1 重新起算 = 世代重置证据；上一世代为 2 条、编号 :1/:2）。
    await expectInstanceCount(h.page, 1, GENERATION_CHANGE_TIMEOUT_MS)
    const id = await terminalIdAt(h.page, 0)
    expect(id, '新世代重建实例应为 term:<sid>:1（序号从 1 重新起算）').toBe(`term:${sessionId}:1`)

    // 全链正向锚：重建实例敲键回显正常显示（重置 → 挂载腿 ack 建档 → 订阅建立 → 输出可达）
    await runInTerminal(h.page, T10_MARK.cmd)
    await expectTerminalOutput(h.page, T10_MARK.out)
    // 无上一世代输出串入
    await expectTerminalTextExcludes(h.page, T1_A.out)
    await expectTerminalTextExcludes(h.page, T1_B.out)
  } finally {
    await teardownHarness(h)
  }
})

// ── T13 跨会话不误清 ────────────────────────────────────────────────────

test('T13: 跨会话不误清——A 双实例切 B 触发对账后切回 A，条目与历史输出保持', async () => {
  const skip = mockBundleSkipReason()
  test.skip(skip !== null, skip ?? '')
  test.setTimeout(240_000)
  const h = await launchHarness()
  try {
    // 会话 A：双实例各有输出
    const aLabel = 'term-t13-a'
    const bLabel = 'term-t13-b'
    const { sessionId: sidA, firstTerminalId: idA1 } = await openSessionWithTerminal(h, aLabel)
    await runInTerminal(h.page, T13_A1.cmd)
    await expectTerminalOutput(h.page, T13_A1.out)
    await createInstance(h.page)
    await expectInstanceCount(h.page, 2)
    const idA2 = await terminalIdAt(h.page, 1)
    await selectInstance(h.page, 1, { excludeText: T13_A1.out })
    await runInTerminal(h.page, T13_A2.cmd)
    await expectTerminalOutput(h.page, T13_A2.out)

    // 会话 B（无终端）：切换即触发 B 的 terminal.list 对账（会话激活腿）
    const sidB = await createSession(h.port, 'create-t13-b', bLabel)
    await selectSessionInSidebar(h.page, bLabel)
    await openTerminalDrawer(h.page)
    // B 对账返回空清单 → 首开自动新建 B 的默认实例（B 侧空态正常）
    await expectInstanceCount(h.page, 1)
    const idB1 = await terminalIdAt(h.page, 0)
    expect(idB1.startsWith(`term:${sidB}:`), 'B 显示的是 B 自己的实例').toBe(true)

    // 切回 A：A 的两条实例、编号、历史输出全部保持（对账范围 = 被查会话，不触达 A）
    await selectSessionInSidebar(h.page, aLabel)
    await openTerminalDrawer(h.page)
    await expectInstanceCount(h.page, 2)
    const backIds = [await terminalIdAt(h.page, 0), await terminalIdAt(h.page, 1)]
    expect(backIds[0]).toBe(idA1)
    expect(backIds[1]).toBe(idA2)
    expect(backIds.every((id) => id.startsWith(`term:${sidA}:`)), 'A 的条目仅含 A 的实例').toBe(true)
    // 历史输出保持：分别切到两个实例断言各自输出仍在屏
    await selectInstance(h.page, 0, { expectText: T13_A1.out })
    await selectInstance(h.page, 1, { expectText: T13_A2.out })
  } finally {
    await teardownHarness(h)
  }
})
