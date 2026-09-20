/**
 * ask-user REAL E2E —— 真实 runtime + pi 子进程 + faux LLM 演员（L2.5 翻轨，2026-09-15）。
 *
 * 验证目标（设计文档 /tmp/e2e-real-test-design-askuser-thinkinglevel.md §3）：
 * - A1 协议透传：真实 ask_user tool 调用 → extension.ui_request 广播
 *   （comment 删除回归核心：askUserQuestions 无 allowComment 字段）+ 回写闭环（pi 恢复 turn）
 * - A2 UI 渲染：FormOverlay 在真实 page 渲染（Playwright DOM 断言），
 *   Other 保留（form-option-__other__）+ 页面无 comment 字样
 * - A3 交互回写：Playwright 操作真实 UI（选 Other → 填自由文本 → submit），
 *   断言 overlay 关闭 + pi 恢复 turn。注：ui_response 帧内容不可捕获——
 *   routeWebSocket 实测无法拦截 Electron renderer 的 WS（Playwright 限制），
 *   answers 无 __comment key 由 A1 + 组件层 FormOverlay.test.ts 覆盖
 *
 * ── 协议事实（读代码确认，非猜测）──
 * - wire 帧（双形态，event-adapter 互斥 marker 分支）：
 *   - form 帧（现行）：select + UI_FORM_MARKER → tryTranslateFormSelect 透传 payload
 *     { sessionId, requestId, method:'select', form:true, formQuestions, allowCancel }
 *     （builtin ask-user 统一表单协议迁移，uiFormInteract + allowOther 固定 true）
 *   - legacy 帧（版本偏斜窗口旧 npm 扩展仍可能发）：select + ASK_USER_MARKER →
 *     { sessionId, requestId, method:'select', askUser:true, askUserQuestions, allowCancel }
 *   断言按双读兼容：形态判定 form===true || askUser===true，问题列表
 *   formQuestions ?? askUserQuestions（两种帧语义同构，只做形态双读不降断言强度）。
 * - FormQuestion / AskUserQuestion（@zhushanwen/extension-protocol）：header/question/
 *   context/options/multiSelect/allowOther —— 无 allowComment（commit 74a0b1001 删除
 *   字段 + UI + __comment key）。faux 轨 dev 装配下 mandatory 扩展经源码目录加载
 *   （extensions/universal/ask-user = 统一表单协议版），不再 symlink npm 目录绕开
 *   registry 旧版；FormAnswers key = header ?? question，与旧 AskUserAnswers 一致
 *   （回写 result 序列化格式不变）。
 * - FormOverlay.vue onSubmit：Other 文本写独立 `${key}__other` 键，主 key 值过滤
 *   OTHER_VALUE 占位符（不留占位值），不产生 `__comment` key
 * - extension.ui_response 不广播：回写闭环以「pi 恢复 turn 的广播事件」为断言面
 * - pi 恢复 turn 事件：message.message_start / message.complete（ServerMessageType）
 *
 * faux 翻轨要点：ask_user 触发改脚本化 toolCall（faux 队列步骤 1）——确定性触发，
 * 原「真实 LLM 不调 ask_user → flaky skip」的容忍层全部移除；UI/DOM 断言语义不动。
 * 回写后 pi 恢复 turn 消费队列步骤 2（stop 文本）。
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
} from './fixtures/launch-app-real'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')
const SESSION_LABEL = 'askuser-e2e-sample'
/** A3 Other 自由文本（playwright fill 直接设 value，无 IME 风险） */
const OTHER_TEXT = 'custom answer from e2e'

/** ask_user 的 faux toolCall 参数（双选项，满足 ask-user validateInput + A1 的 ≥2 选项断言） */
const ASK_USER_ARGS = {
  questions: [{
    question: '选择 A 还是 B？',
    options: [
      { label: '选项 A', description: '走 A 方案' },
      { label: '选项 B', description: '走 B 方案' },
    ],
  }],
}

/** faux 队列：ask_user toolCall（→ ui_request）→ 回写后 pi 恢复 turn 的 stop 文本 */
const FAUX_SCRIPT = [
  { toolCalls: [{ name: 'ask_user', args: ASK_USER_ARGS }] },
  { text: '已收到答复，继续执行。' },
]

/** flaky 容忍层已移除（faux 确定性触发）；失败诊断落盘保留 */
function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[diag] ${name} → /tmp/${name}`)
}

/**
 * 通过 WS 创建 session。faux 轨 dev 装配下 mandatory 扩展（含 pi-ask-user）经源码目录
 * 加载（无 npm 安装等待），仍以 resolver 日志信号确认就绪（防 session.create 过早）。
 * OS 原生目录选择 dialog 不可自动化，TEST-STRATEGY 约定用 WS 直连触发等效业务动作。
 */
async function createSession(port: number, dataDir: string): Promise<string> {
  const resolved = await waitForExtensionsReady(dataDir)
  if (resolved === 0) {
    console.log('[warn] extensions not ready within timeout, continue anyway')
  }
  const createReply = await wsRoundTrip(port, {
    type: 'session.create',
    id: 'askuser-real-create',
    payload: { cwd: SAMPLE_PROJECT, label: SESSION_LABEL },
  }, 'askuser-real-create')
  expect(createReply.type).toBe('session.created')
  return (createReply.payload.session as { id: string }).id
}

/**
 * UI 切 session（新范式：real 轨首次操作真实 page）。
 *
 * WS create 后 config.sessions 广播 → sidebar 列表出现该 session → Playwright
 * 点 sidebar 会话列表项（session.switch RPC + panel 绑定）→ composer 出现即 Panel
 * 已挂载该 session（useExtensionUI 订阅 extension.ui_request 就绪）。
 * 不涉及 OS dialog（dialog 只在新建任务选目录时出现，切已有 session 不需要）。
 */
async function selectSessionInSidebar(page: import('@playwright/test').Page, label: string): Promise<void> {
  // 启动竞态防护：main 的 getRuntimePort IPC 在 runtime 就绪前可能返回空 → renderer 用
  // fallback 端口首次连接失败 → ws-client 指数退避重连。必须先等连接稳定再操作 sidebar。
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  const tab = page.getByRole('button', { name: /^会话/ })
  await tab.click({ timeout: 10_000 }).catch(() => {})
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 30_000 })
}

/**
 * 轮询广播事件里第一个 ask-user 富交互请求（extension.ui_request + 富交互标记）。
 * 双读形态判定：form === true（统一表单帧，现行）或 askUser === true（legacy 帧，
 * 版本偏斜窗口旧扩展）——两种帧 event-adapter 侧互斥分支产出，语义同构。
 */
async function waitForAskUserRequest(events: any[], deadlineMs: number): Promise<any | undefined> {
  while (Date.now() < deadlineMs) {
    const evt = events.find(
      (e) => e.type === 'extension.ui_request'
        && (e.payload?.form === true || e.payload?.askUser === true),
    )
    if (evt) return evt
    await new Promise((r) => setTimeout(r, 1000))
  }
  return undefined
}

/** 找问题列表[0]（formQuestions ?? askUserQuestions 双读；用类型守卫收窄 unknown[]） */
function firstQuestion(askUserReq: any): { header?: string; question: string; options?: unknown[] } {
  const qs = (askUserReq.payload?.formQuestions ?? askUserReq.payload?.askUserQuestions) as unknown[] | undefined
  const q = Array.isArray(qs) && qs.length > 0 ? qs[0] : undefined
  expect(q, 'payload.formQuestions[0] / payload.askUserQuestions[0] 应存在（协议透传）').toBeDefined()
  expect(typeof (q as { question?: unknown }).question).toBe('string')
  return q as { header?: string; question: string; options?: unknown[] }
}

/** 在 events 中找 idx 之后出现的 pi 恢复产出事件（message_start / complete） */
function findTurnResumeAfter(events: any[], idx: number): { type: string } | undefined {
  for (let i = idx + 1; i < events.length; i++) {
    const t = events[i].type
    if (t === 'message.message_start' || t === 'message.complete') {
      return { type: t }
    }
  }
  return undefined
}

// ── A1: 协议透传（comment 删除回归核心） ─────────────────────────────

test('A1: ask_user 调用 → ui_request 广播含 formQuestions/askUserQuestions，问题无 allowComment 字段，回写后 pi 恢复 turn', async () => {
  test.setTimeout(120_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-askuser-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: FAUX_SCRIPT } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const sessionId = await createSession(port, dataDir)

    // 先开监听 WS 再发 prompt，避免 broadcast 时序竞争（R2/R3 范式）
    const { ws: listenWs, events } = await openListenWs(port, sessionId)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a1-send',
      payload: { sessionId, content: '请用 ask_user tool 问用户：选择 A 还是 B？' },
    }, 'a1-send', 30_000)

    const askUserReq = await waitForAskUserRequest(events, Date.now() + 60_000)
    if (!askUserReq) {
      listenWs.close()
      writeDiag('askuser-a1-diag.json', {
        eventCount: events.length,
        eventTypes: [...new Set(events.map((e) => e.type))],
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(askUserReq, 'faux toolCall ask_user → ui_request 应确定性到达').toBeDefined()

    // ── 断言 1：协议透传结构完整 ──
    const payload = askUserReq!.payload
    expect(payload.sessionId).toBe(sessionId)
    expect(payload.requestId, 'ui_request 应带 requestId（回写用）').toBeTruthy()
    expect(payload.method).toBe('select')
    // 形态双读（不降强度）：统一表单帧 form===true 或 legacy 帧 askUser===true，
    // event-adapter 互斥 marker 分支保证两键恰一为真
    expect(
      payload.form === true || payload.askUser === true,
      'ui_request 应带富交互标记（form:true 统一表单帧 / askUser:true legacy 帧）',
    ).toBe(true)
    const q = firstQuestion(askUserReq!)
    expect(q.question.length).toBeGreaterThan(0)
    expect(Array.isArray(q.options) && q.options.length >= 2,
      '问题应带 ≥2 个选项（脚本双选项）').toBe(true)

    // ── 断言 2（comment 删除回归核心）：问题对象无 allowComment 字段 ──
    const keys = Object.keys(q)
    expect(keys).not.toContain('allowComment')
    expect(keys.some((k) => k.includes('comment')),
      '问题对象不应含任何 comment 相关字段').toBe(false)

    // ── 断言 3（回写闭环）：发 ui_response → pi 收到后恢复 turn ──
    // extension.ui_response 无 reply（fire-and-forget），直接 listenWs.send。
    // result = JSON.stringify(AskUserAnswers)（与前端 onSubmit 的 emit 格式一致）
    const qKey = q.header ?? q.question
    const uiReqIdx = events.indexOf(askUserReq!)
    listenWs.send(JSON.stringify({
      type: 'extension.ui_response',
      payload: {
        sessionId,
        requestId: payload.requestId,
        method: 'select',
        result: JSON.stringify({ [qKey]: 'A' }),
      },
    }))

    const resumeDeadline = Date.now() + 60_000
    let resume: { type: string } | undefined
    while (Date.now() < resumeDeadline && !resume) {
      resume = findTurnResumeAfter(events, uiReqIdx)
      if (!resume) await new Promise((r) => setTimeout(r, 1000))
    }
    if (!resume) {
      writeDiag('askuser-a1-resume.json', {
        eventsAfterRequest: events.slice(uiReqIdx).map((e) => e.type),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(resume, '回写后 pi 应恢复 turn（message.message_start / message.complete）').toBeDefined()
    listenWs.close()
    console.log(`[A1] 协议透传验证通过：question="${q.question}"，options=${(q.options ?? []).length}，无 allowComment，回写后恢复 turn via ${resume?.type}`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// ── A2: UI 渲染（Playwright 操作 real page） ─────────────────────────

test('A2: ask-user overlay 真实渲染 — overlay/Other 保留，页面无 comment 字样', async () => {
  test.setTimeout(120_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-askuser-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: FAUX_SCRIPT } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const sessionId = await createSession(port, dataDir)

    // UI 切 session（必须先于 prompt：useExtensionUI 按 Panel 的 sessionId 订阅）
    await selectSessionInSidebar(page, SESSION_LABEL)

    const { ws: listenWs, events } = await openListenWs(port, sessionId)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a2-send',
      payload: { sessionId, content: '请用 ask_user tool 问用户：选择 A 还是 B？' },
    }, 'a2-send', 30_000)

    const askUserReq = await waitForAskUserRequest(events, Date.now() + 60_000)
    if (!askUserReq) {
      listenWs.close()
      writeDiag('askuser-a2-diag.json', { eventCount: events.length, eventTypes: [...new Set(events.map((e) => e.type))] })
    }
    expect(askUserReq, 'faux toolCall ask_user → ui_request 应确定性到达').toBeDefined()
    listenWs.close()

    // ── 断言 1：overlay 真实渲染在 page DOM ──
    const overlay = page.getByTestId('form-overlay')
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    const q = firstQuestion(askUserReq!)
    expect(q.question.length).toBeGreaterThan(0)

    // ── 断言 2：Other 保留（comment 删除不影响 Other 自由输入）──
    await expect(page.getByTestId('form-option-__other__')).toBeVisible({ timeout: 5_000 })

    // ── 断言 3：overlay UI 无 comment 字样（comment UI/i18n 已删除）──
    // 注意：不能断言全页 —— 消息流可能渲染含 "comment" 的自由文本（faux 回复文本受控，
    // 但 overlay 内部才是「comment UI 删除」的正确回归面，与原轨保持同一断言语义）。
    const overlayText = (await overlay.textContent()) ?? ''
    expect(overlayText.toLowerCase().includes('comment'),
      'overlay UI 文本不应含 "comment"（comment UI + i18n key 已删除）').toBe(false)
    console.log(`[A2] overlay 渲染验证通过：question="${q.question}"，Other 保留，overlay 无 comment`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// ── A3: 交互回写（真实 UI 操作 + pi 恢复 turn 断言） ─────────────────────

test('A3: 选 Other 填自由文本提交 → overlay 关闭 + pi 恢复 turn（真实 UI 交互闭环）', async () => {
  test.setTimeout(120_000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-askuser-'))
  const { page, cleanup } = await launchRealApp({ dataDir, faux: { responses: FAUX_SCRIPT } })
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    const sessionId = await createSession(port, dataDir)

    await selectSessionInSidebar(page, SESSION_LABEL)

    const { ws: listenWs, events } = await openListenWs(port, sessionId)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a3-send',
      payload: { sessionId, content: '请用 ask_user tool 问用户：选择 A 还是 B？' },
    }, 'a3-send', 30_000)

    const askUserReq = await waitForAskUserRequest(events, Date.now() + 60_000)
    if (!askUserReq) {
      listenWs.close()
      writeDiag('askuser-a3-diag.json', { eventCount: events.length, eventTypes: [...new Set(events.map((e) => e.type))] })
    }
    expect(askUserReq, 'faux toolCall ask_user → ui_request 应确定性到达').toBeDefined()

    // ── 真实 UI 交互：点 Other → 填自由文本 → submit ──
    const q = firstQuestion(askUserReq!)
    const qKey = q.header ?? q.question
    const uiReqIdx = events.indexOf(askUserReq!)

    await expect(page.getByTestId('form-overlay')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('form-option-__other__').click()
    const otherInput = page.getByTestId(`form-other-${qKey}`)
    await expect(otherInput).toBeVisible({ timeout: 5_000 })
    await otherInput.fill(OTHER_TEXT)
    await page.getByTestId('form-submit').click()

    // ── 断言 1：overlay 关闭（前端 onSubmit 回写成功信号）──
    await expect(page.getByTestId('form-overlay')).toBeHidden({ timeout: 15_000 })

    // ── 断言 2：pi 收到响应后恢复 turn（message_start / complete）──
    const resumeDeadline = Date.now() + 60_000
    let resume: { type: string } | undefined
    while (Date.now() < resumeDeadline && !resume) {
      resume = findTurnResumeAfter(events, uiReqIdx)
      if (!resume) await new Promise((r) => setTimeout(r, 1000))
    }
    listenWs.close()
    if (!resume) {
      writeDiag('askuser-a3-resume.json', {
        eventsAfterRequest: events.slice(uiReqIdx).map((e) => e.type),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(resume, '回写后 pi 应恢复 turn（message.message_start / message.complete）').toBeDefined()
    console.log(`[A3] UI 交互闭环验证通过：qKey="${qKey}"，Other 文本="${OTHER_TEXT}"，overlay 关闭，pi 恢复 turn via ${resume?.type}`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
