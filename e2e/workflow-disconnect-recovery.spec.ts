/**
 * workflow 断连恢复语义 E2E（A2，设计 .tmp/tech-design/reload-closeout-reliability.md §4 A2）。
 *
 * faux LLM 轨（L2.5，零 token）。场景：WS 断开期间 run 完成 → 重连 → 收敛。
 * 验证对象 = 传输兜底面回归（G2 覆盖矩阵「publish 之后的传输跳」分治）：断连下 publish
 * 正常完成并推进水位、重连后 diff 空——水位结构性不触发，恢复只能来自既有传输兜底
 * （stateSnapshot 回放 / 冷拉）。水位的直接证明在 A3 单测轨 + A1 e2e 轨（S1b/S2 的
 * ≤30s 帧到达断言），不在本用例。
 *
 * 断连的实现载体（u3a 裁决，deviations 登记）：spec 自备 WS 客户端扮演断连者——它与
 * renderer 走完全相同的协议面（auth 握手 + session.subscribe + stateSnapshot 回放，
 * packages/core/src/coordination/subscription-state.ts resubscribeAll 同一 reply 消费
 * 通路）。不强制 renderer 侧断网（CDP emulateNetworkConditions 在 Electron e2e 未经
 * 验证，本单元只编写不执行，不押注未验证工具行为）；renderer 全程在线，其 GUI 收敛
 * 经 live 帧达成，本 spec 以托盘终态断言锚定用户可见结果。
 *
 * 通过标准（设计 A2）：
 * - 断连窗口真实：spec WS 关闭时 run 仍在飞（JSONL 末条 workflow-record 非 done）；
 * - 断连期间 run 完成：主 session JSONL 终态 done 落盘（权威 record，无需任何 WS 观察者）；
 * - 恢复来源①（stateSnapshot 回放帧）：重连 re-subscribe 的 reply.stateSnapshot 携带
 *   该 run 的 session.workflowUpdate done last-value 帧（message-bus 既有机制：
 *   state topic 写快照、subscribe 回放，断连空投不碍快照写入）；
 * - 恢复来源②（冷拉）：session.getWorkflows RPC 返回该 run 终态 done 记录
 *   （renderer WS 重连冷拉同一 RPC，useSidebar.onConnected → loadWorkflows）；
 * - GUI 收敛：run 完成后托盘 workflow 条目 data-state 回 idle（≤30s，G1 用户可见窗口）；
 * - 重连稳态：不出现重复的 done workflowUpdate live 帧（断连空投下 publish 已完成、
 *   重连后 diff 恒空——A3 单测锁定结构属性的 e2e 面防回归）。
 *
 * 断言样本来源见 e2e/fixtures/skill-reload-real-helpers.ts 文件头（workflow-record 读取
 * 形态 / 托盘 testid）；subscribe reply 形状 = transport/session-message-handler.ts
 * handleSessionSubscribe（payload { snapshot, stateSnapshot, lastSeq, gap }）。
 */
import { test, expect, type Page } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  waitForExtensionsReady,
} from './fixtures/launch-app-real'
import fs from 'node:fs'
import path from 'node:path'
import {
  FAUX_TPS,
  SUB_MODEL_A,
  SUBAGENT_STREAM_CHARS,
  makeTempDir,
  makeSurvivalProbeSource,
  mainDispatchSteps,
  survivorSteps,
  writeUserWorkflowScripts,
  lastWorkflowRecordFor,
} from './fixtures/skill-reload-real-helpers'

const SESSION_LABEL = 'wf-disconnect-recovery'

/** 稳态观察窗：覆盖一个完整 15s 对账定时腿周期 + 1s 余量（u1 落地后定时腿周期；当前 HEAD 无水位机制，窗口空过） */
const STEADY_WINDOW_MS = 16_000

function makeStreamText(tag: string): string {
  const unit = `${tag} disconnect probe stream line. `
  return unit.repeat(Math.ceil(SUBAGENT_STREAM_CHARS / unit.length))
}

async function selectSessionInSidebar(page: Page, label: string): Promise<void> {
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 30_000 })
}

test('A2: WS 断开期间 run 完成 → 重连后 stateSnapshot 回放/冷拉恢复 + GUI 收敛', async () => {
  test.setTimeout(300_000)
  // 前缀须短：<dataDir>/run/relay-<pid>.sock 受 macOS UDS 路径 104B 上限约束（S1b 同款教训）
  const projectDir = makeTempDir('taiji-wf-disc-proj-')
  const dataDir = makeTempDir('taiji-wf-disc-data-')
  let listenWs2: import('ws').default | null = null
  let appCleanup: (() => Promise<void>) | null = null
  let reachedEnd = false // test.info().status 在 finally 不可靠，用确定性末行标志
  try {
    const probeName = 'disconnect-recovery-probe'
    const [probePath] = writeUserWorkflowScripts(dataDir, [
      { name: probeName, source: makeSurvivalProbeSource(probeName, SUB_MODEL_A, 'disconnect recovery probe') },
    ])
    const { page, cleanup } = await launchRealApp({
      dataDir,
      faux: {
        responses: {
          'faux/faux-1': mainDispatchSteps([probePath], 'workflow 已在后台启动。'),
          ...survivorSteps(SUB_MODEL_A, makeStreamText('D')),
        },
        tps: FAUX_TPS,
      },
    })
    appCleanup = cleanup

    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const resolved = await waitForExtensionsReady(dataDir)
    if (resolved === 0) console.log('[warn] extensions not ready within timeout, continue anyway')

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 'a2-create',
      payload: { cwd: projectDir, label: SESSION_LABEL },
    }, 'a2-create')
    expect(createReply.type).toBe('session.created')
    const session = createReply.payload!.session as { id: string; sessionFile?: string }
    const sessionId = session.id
    const sessionFile = session.sessionFile ?? null
    expect(sessionFile, '主 session JSONL 路径应存在').toBeTruthy()

    await selectSessionInSidebar(page, SESSION_LABEL)
    // 先 listen 再发 prompt（broadcast 时序竞争，00-overview §4 通用范式）
    const listen1 = await openListenWs(port, sessionId)
    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a2-send',
      payload: { sessionId, content: '运行断连恢复探针脚本。' },
    }, 'a2-send', 30_000)

    // ── run 在飞确认：running 增量信号帧到 spec WS + 托盘 running ──
    const workflowBtn = page.locator('[data-testid="tray-builtin-button"][data-kind="workflow"]')
    await expect(workflowBtn).toHaveAttribute('data-state', 'running', { timeout: 60_000 })
    let runId = ''
    const runningDeadline = Date.now() + 30_000
    while (Date.now() < runningDeadline && runId === '') {
      for (const e of listen1.events) {
        if (e.type !== 'session.workflowUpdate') continue
        const update = e.payload?.update as { runId?: unknown } | undefined
        if (typeof update?.runId === 'string') {
          runId = update.runId // 首条（running）帧即目标 run——单 run 场景
          break
        }
      }
      if (runId === '') await new Promise((r) => setTimeout(r, 500))
    }
    expect(runId, 'spec WS 应收到 run 的 running 增量信号帧（断连前在飞确认）').not.toBe('')

    // ── 断连：spec WS 关闭时 run 必须仍在飞（窗口真实，非空转）──
    const recAtDisconnect = lastWorkflowRecordFor(sessionFile!, runId)
    expect(
      recAtDisconnect?.status ?? 'running',
      '断连时 run 应仍在飞（JSONL 末条 workflow-record 非 done；null=running record 未 flush 同样在飞）',
    ).not.toBe('done')
    listen1.ws.close()
    console.log(`[A2] spec WS 已断连（runId=${runId}，run 在飞中）`)

    // ── 断连期间 run 完成：权威 record 落盘，无需任何 WS 观察者 ──
    const doneDeadline = Date.now() + 150_000
    let tDoneRecord = 0
    while (Date.now() < doneDeadline) {
      if (lastWorkflowRecordFor(sessionFile!, runId)?.status === 'done') {
        tDoneRecord = Date.now()
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(tDoneRecord, '断连期间 run 应完成（主 session JSONL 终态 done）').not.toBe(0)

    // ── GUI 收敛（用户可见）：run 完成后托盘 workflow 条目回 idle（≤30s）──
    await expect(
      workflowBtn,
      'GUI 收敛：run 完成后托盘 workflow 条目回 idle（G1 用户可见窗口）',
    ).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })

    // ── 恢复来源①：重连 re-subscribe → reply.stateSnapshot 回放 done last-value 帧 ──
    // 断连空投不碍快照写入（message-bus publishState 无条件写 stateSnapshot，与订阅者
    // 存在与否无关）——重连客户端经回放拿到终态，这是断连场景的第一恢复层（D5）。
    const subReply = await wsRoundTrip(port, {
      type: 'session.subscribe',
      id: 'a2-resubscribe',
      payload: { sessionId },
    }, 'a2-resubscribe')
    const stateSnapshot = (subReply.payload?.stateSnapshot ?? []) as Array<{
      type?: string
      payload?: Record<string, unknown>
    }>
    const replayed = stateSnapshot.find((f) => {
      if (f.type !== 'session.workflowUpdate') return false
      const update = f.payload?.update as { runId?: unknown; status?: unknown } | undefined
      return update?.runId === runId && update?.status === 'done'
    })
    expect(
      replayed,
      '恢复来源①（stateSnapshot 回放帧）：重连 re-subscribe reply 应携带该 run 的 done workflowUpdate last-value 帧',
    ).toBeDefined()

    // ── 恢复来源②：冷拉 RPC 返回终态记录（renderer WS 重连冷拉同一 RPC）──
    const wfReply = await wsRoundTrip(port, {
      type: 'session.getWorkflows',
      id: 'a2-coldpull',
      payload: { sessionId },
    }, 'a2-coldpull')
    const workflows = (wfReply.payload?.workflows ?? []) as Array<{
      runId?: unknown
      status?: unknown
    }>
    expect(
      workflows.some((w) => w.runId === runId && w.status === 'done'),
      '恢复来源②（冷拉）：session.getWorkflows RPC 应返回该 run 的终态 done 记录',
    ).toBe(true)

    // ── 重连稳态：无重复 done live 帧（水位 diff 恒空的结构属性，A3 单测的 e2e 面）──
    // 断连下 publish 已正常完成 → 水位已推进 → 重连后 diff 恒空 → 回放是唯一送达（已在
    // subscribe reply 一次性交付，live 通道静默）。若未来出现重发回归（水位误滞留补发），
    // 此处将捕获到重复 live 帧。窗口覆盖一个完整 15s 定时腿周期。
    const listen2 = await openListenWs(port, sessionId)
    listenWs2 = listen2.ws
    await new Promise((r) => setTimeout(r, STEADY_WINDOW_MS))
    const dupLive = listen2.events.filter((e) => {
      if (e.type !== 'session.workflowUpdate') return false
      const update = e.payload?.update as { runId?: unknown; status?: unknown } | undefined
      return update?.runId === runId && update?.status === 'done'
    })
    expect(
      dupLive,
      '重连后稳态不应出现重复 done workflowUpdate live 帧（回放已在 subscribe reply 交付，live 通道静默）',
    ).toHaveLength(0)

    listenWs2?.close()
    listenWs2 = null
    console.log('[A2] 通过：断连期间完成 / stateSnapshot 回放 / 冷拉终态 / GUI 收敛 / 稳态无重复帧')
    reachedEnd = true
  } finally {
    // 失败取证放最前（appCleanup 之前）：logs 拷到固定路径，规避后续清理丢失现场
    if (!reachedEnd) {
      const keep = `/tmp/a2-failed-${Date.now()}`
      try {
        fs.mkdirSync(keep, { recursive: true })
        fs.cpSync(path.join(dataDir, 'logs'), path.join(keep, 'logs'), { recursive: true })
        fs.cpSync(path.join(dataDir, 'agent', 'logs'), path.join(keep, 'agent-logs'), { recursive: true })
        console.log(`[A2] 失败取证：logs -> ${keep}（dataDir=${dataDir}）`)
      } catch (e) {
        console.log(`[A2] 失败取证拷贝失败：${e}（dataDir=${dataDir}）`)
      }
    }
    listenWs2?.close()
    if (appCleanup) await appCleanup()
    if (reachedEnd) {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }
})
