/**
 * skill-reload SPAWN-RACE real E2E（S2 reload 撞 spawn 窗口竞态，
 * 设计 .tmp/tech-design/skill-reload-nondestructive.md §4 S2 + §3.3 D4/探针清单末行）。
 *
 * faux LLM 轨（L2.5，选型理由见 e2e-map.json E2E-SKILLRELOAD-03 note）。派发后台 workflow
 * run 后 <1s（setTimeout 控制）写项目 skill 触发 reload——命中「record 已建 / 引擎子进程
 * spawn 进行中」的竞态窗口（reload 决策在主 turn 生成期落 queued、message.complete 后消费，
 * 或 turn 已结束则 immediate，两形态均为设计内合法路径）。
 *
 * 通过标准（设计 S2）：
 * - run 收口确定：正常完成（faux 确定性主预期）或落 done,failed 且用户可见——两者共享同一
 *   用户可见通道（session.workflowUpdate 广播 → 托盘/Turn 渲染；失败分支可见性 = S3 单测
 *   契约 + 同通道，设计 §4 S3 已明示真机无法安全伪造 adoption 失败）；
 * - 无状态分裂：主 session JSONL 可读回末条 workflow-record 终态（store 与内存一致，
 *   W17 权威 entry last-wins）；
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
  lastWorkflowRecordFor,
  engineTreePids,
  waitForEngineTreeGone,
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

    // ── run 确定收口：workflowUpdate done 广播（用户可见通道；失败分支同通道可见，见文件头）──
    let runId = ''
    let updateStatus = ''
    const doneDeadline = Date.now() + 150_000
    while (Date.now() < doneDeadline && runId === '') {
      const hit = listen.events.find((e) => e.type === 'session.workflowUpdate')
      const update = hit?.payload?.update as { status?: unknown; runId?: unknown } | undefined
      if (update !== undefined && typeof update.runId === 'string') {
        runId = update.runId
        updateStatus = String(update.status)
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(runId, 'run 应有终态广播（正常完成或 done,failed，用户可见）').not.toBe('')
    console.log(`[S2] run 终态广播: runId=${runId} status=${updateStatus}`)

    // ── 无状态分裂：主 session JSONL 可读回末条 workflow-record 终态 ──
    let mainFile = sessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    let rec = lastWorkflowRecordFor(mainFile!, runId)
    const recDeadline = Date.now() + 15_000
    while ((rec === null || rec.status !== 'done') && Date.now() < recDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
      rec = lastWorkflowRecordFor(mainFile!, runId)
    }
    expect(rec?.status, '末条 workflow-record 应为可读回的终态 done（store 与内存一致）').toBe('done')

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
    console.log('[S2] 通过：reload 命中 spawn 窗口 / run 确定收口 / 终态可读回 / 无孤儿')
  } finally {
    delete process.env.TAIJI_AGENT_DEBUG
    listenWs?.close()
    if (appCleanup) await appCleanup()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
