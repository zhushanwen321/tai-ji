/**
 * skill-reload SPAWN-RACE real E2E（S2 reload 撞 spawn 窗口竞态，
 * 设计 .tmp/tech-design/skill-reload-nondestructive.md §4 S2 + §3.3 D4/探针清单末行）。
 *
 * faux LLM 轨（L2.5，选型理由见 e2e-map.json E2E-SKILLRELOAD-03 note）。派发后台 workflow
 * run 后 <1s（setTimeout 控制）写项目 skill 触发 reload——命中「record 已建 / 引擎子进程
 * spawn 进行中」的竞态窗口（reload 决策在主 turn 生成期落 queued、message.complete 后消费，
 * 或 turn 已结束则 immediate，两形态均为设计内合法路径）。
 *
 * 通过标准（设计 S2 + reload-closeout-reliability §4 A1 断言升级）：
 * - run 收口确定：done 为 faux 主预期断言面（≤30s done-latency 必达；helpers 的
 *   awaitWorkflowDoneTimed 只断 status === 'done'）；done,failed 分支的用户可见性 =
 *   S3 单测契约 + 同一 workflowUpdate 通道（真机无法安全伪造 adoption 失败，非本 spec
 *   通过分支）；
 * - 无状态分裂：主 session JSONL 可读回末条 workflow-record 终态（store 与内存一致，
 *   W17 权威 entry last-wins）；
 * - G1 必达窗口（A1 新断言，2026-09-19）：run 完成（JSONL 终态 done 落盘）后 ≤30s
 *   `session.workflowUpdate` done 帧到达 spec WS（agent_settled 腿秒级 / 15s 定时腿最坏
 *   ≈15s+单轮，30s = 2x 余量）；
 * - 无孤儿进程：session.delete 真杀级联后引擎执行树（引擎 CLI / relay / 真实 pi）ps 归零；
 * - reload 确实发生：`[skill-reload] dir=project:` 归因行在场。
 *
 * 断言样本来源见 e2e/fixtures/skill-reload-real-helpers.ts 文件头。
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
  writeProjectSkill,
  writeUserWorkflowScripts,
  readExtensionLogs,
  parseLastPreserved,
  waitForLogLine,
  runtimeLogLines,
  engineTreePids,
  waitForEngineTreeGone,
  awaitWorkflowDoneTimed,
  WORKFLOW_DONE_MAX_LATENCY_MS,
  DONE_TIMING_OBSERVE_SLACK_MS,
} from './fixtures/skill-reload-real-helpers'

const SESSION_LABEL = 'skill-reload-spawn-race'

function makeStreamText(tag: string): string {
  const unit = `${tag} spawn-race probe stream line. `
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

test('S2: 派发后 <1s 写 skill 触发 reload → run 确定收口 + JSONL 可读回终态 + 无孤儿', async () => {
  test.setTimeout(420_000)
  const projectDir = makeTempDir('taiji-skillreload-race-proj-')
  const dataDir = makeTempDir('taiji-skillreload-race-data-')
  process.env.TAIJI_AGENT_DEBUG = '1'
  let listenWs: import('ws').default | null = null
  let appCleanup: (() => Promise<void>) | null = null
  let reachedEnd = false // test.info().status 在 finally 不可靠（实测恒 'passed'），用确定性末行标志
  try {
    writeProjectSkill(projectDir, 'demo-a', 'Use this skill when the user asks for demo-alpha tasks.')
    const probeName = 'spawn-race-probe'
    const [probePath] = writeUserWorkflowScripts(dataDir, [
      { name: probeName, source: makeSurvivalProbeSource(probeName, SUB_MODEL_A, 'spawn race probe') },
    ])
    const { page, cleanup } = await launchRealApp({
      dataDir,
      faux: {
        responses: {
          'faux/faux-1': mainDispatchSteps([probePath], 'workflow 已在后台启动。'),
          ...survivorSteps(SUB_MODEL_A, makeStreamText('R')),
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
      id: 's2-create',
      payload: { cwd: projectDir, label: SESSION_LABEL },
    }, 's2-create')
    expect(createReply.type).toBe('session.created')
    expect(createReply.payload, 'session.created 应带 payload').toBeDefined()
    const session = createReply.payload!.session as { id: string; sessionFile?: string }
    const sessionId = session.id
    const sessionFile = session.sessionFile ?? null
    await selectSessionInSidebar(page, SESSION_LABEL)
    const listen = await openListenWs(port, sessionId)
    listenWs = listen.ws

    // ── 竞态注入：派发 ack 后 <1s 写项目 skill（引擎 CLI spawn 尚在进行中）──
    const sendAck = wsRoundTrip(port, {
      type: 'message.send',
      id: 's2-send',
      payload: { sessionId, content: '运行 spawn-race 探针脚本。' },
    }, 's2-send', 30_000)
    const raceWrite = sendAck.then(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        writeProjectSkill(projectDir, 'race-skill', 'Use this skill when the user asks for race checks.')
        resolve()
      }, 400)
    }))
    await raceWrite
    console.log('[S2] skill 写入完成（派发 ack +400ms，命中 spawn 窗口）')

    // ── reload 确实发生（dir=project 归因行 + preserved 行；决策行 queued/immediate 均合法）──
    const d8a = await waitForLogLine(
      () => runtimeLogLines(dataDir).join('\n'),
      (l) => l.includes('[skill-reload] dir=project:') && l.includes(`affectedSessions=[${sessionId}`),
      20_000,
    )
    expect(d8a, '竞态写入应触发 dir=project 归因行').not.toBeNull()
    const decision = await waitForLogLine(
      () => runtimeLogLines(dataDir).join('\n'),
      (l) => l.includes(`[reload-orchestrator] sessionId=${sessionId} decision=`),
      20_000,
    )
    expect(decision, '应出现 reload 决策行（生成期 queued / 空闲 immediate 两形态均合法）').not.toBeNull()
    const preservedLine = await waitForLogLine(
      () => readExtensionLogs(dataDir),
      (l) => l.includes('session_shutdown reason=reload preserved={'),
      20_000,
    )
    expect(preservedLine, 'preserved 归因行应出现（reload 分支执行）').not.toBeNull()
    const preserved = parseLastPreserved(readExtensionLogs(dataDir))
    expect(preserved?.records, 'preserved records ≥1（在飞 subagent 被接管）').toBeGreaterThanOrEqual(1)

    // ── run 确定收口：workflowUpdate done 广播 + JSONL 终态（双锚计时，A1 断言升级）──
    // awaitWorkflowDoneTimed 内全量遍历（禁 find 的卡帧教训注释在 helpers 文件）；runId 取
    // 首条 workflowUpdate 帧（running 帧——run 启动即广播，harness 防重播种后单 run）。
    // 必须等终态帧：拿到 running 帧就往下走会让 JSONL 锚在 60s 长流式未结束时恒为
    // running（假失败）——helper 返回即双锚（终态帧 + JSONL 终态）都已见。
    expect(sessionFile, '主 session JSONL 路径应存在').toBeTruthy()
    const timing = await awaitWorkflowDoneTimed(listen.events, sessionFile)
    expect(timing, 'run 应有终态广播 + JSONL 终态 done（正常完成或 done,failed，同通道用户可见）').not.toBeNull()
    const runId = timing!.runId
    // G1 必达窗口（设计 §4 A1 新断言，S2 同款）：完成锚（JSONL 终态落盘）→ 到达锚（done
    // 帧到 spec WS）≤30s。负时差钳 0 + 观测容差语义见 helpers awaitWorkflowDoneTimed 注释。
    const latency = Math.max(0, timing!.tFrameSeen - timing!.tDoneRecord)
    console.log(`[S2] run ${runId} 完成→done 帧到达延迟 ${latency}ms`)
    expect(
      latency,
      `run ${runId} 完成后 ≤${WORKFLOW_DONE_MAX_LATENCY_MS}ms workflowUpdate 帧应到达 spec WS`,
    ).toBeLessThanOrEqual(WORKFLOW_DONE_MAX_LATENCY_MS + DONE_TIMING_OBSERVE_SLACK_MS)

    // ── 无孤儿：session.delete 真杀级联后引擎执行树归零 ──
    const treeBaseline = engineTreePids()
    await wsRoundTrip(port, {
      type: 'session.delete',
      id: 's2-delete',
      payload: { sessionId },
    }, 's2-delete', 30_000)
    const orphans = await waitForEngineTreeGone(treeBaseline, 20_000)
    expect(orphans, '竞态收口 + session 删除后应无残留引擎执行树进程').toEqual([])

    listenWs?.close()
    console.log('[S2] 通过：reload 命中 spawn 窗口 / run 确定收口 / 终态可读回 / 无孤儿 / ≤30s 必达')
    reachedEnd = true
  } finally {
    delete process.env.TAIJI_AGENT_DEBUG
    // 失败取证放最前（appCleanup 之前）：logs 拷到固定路径，规避后续清理丢失现场
    if (!reachedEnd) {
      const keep = `/tmp/s2-failed-${Date.now()}`
      try {
        fs.mkdirSync(keep, { recursive: true })
        fs.cpSync(path.join(dataDir, 'logs'), path.join(keep, 'logs'), { recursive: true })
        fs.cpSync(path.join(dataDir, 'agent', 'logs'), path.join(keep, 'agent-logs'), { recursive: true })
        fs.cpSync(path.join(dataDir, 'agent', 'sessions'), path.join(keep, 'agent-sessions'), { recursive: true })
        console.log(`[S2] 失败取证：logs -> ${keep}（dataDir=${dataDir}）`)
      } catch (e) {
        console.log(`[S2] 失败取证拷贝失败：${e}（dataDir=${dataDir}）`)
      }
    }
    listenWs?.close()
    if (appCleanup) await appCleanup()
    if (reachedEnd) {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }
})
