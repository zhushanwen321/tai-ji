/**
 * skill-reload SURVIVAL real E2E（S1 主场景，设计 .tmp/tech-design/skill-reload-nondestructive.md §4 S1）。
 *
 * faux LLM 轨（L2.5，同 real 轨全族 2026-09-15 翻轨口径）：真实 Electron app + 真实 runtime +
 * 真实 pi 子进程 + 真实 watcher/reload/adoption 链路；LLM 轮次 faux 脚本化（workflow toolCall
 * 确定性触发，subagent 长流式响应以 TAIJI_FAUX_TPS 拉长保持 run 在飞）。被测对象是
 * 「skill 编辑 → reload → 在飞 run 存活」的机制链，非模型智能——选型理由登记于
 * e2e-map.json E2E-SKILLRELOAD-01 note。
 *
 * 场景（对应 impl-plan B5 / 设计 S1 四条通过标准）：
 *   建 session（cwd = mkdtemp 临时项目，含 .pi/skills/demo-a）→ 派发两个后台 workflow run
 *   （各 1 个 background subagent，长流式）→ 托盘运行计数 =2 → 编辑项目 skill（新增 demo-b +
 *   改 demo-a description）→ 断言：
 *   ① 编辑后 2s 内 composer skill 浮层含 demo-b 且 demo-a 新 description 生效（G1 panel 候选
 *      即时性 + panel cwd 接线；不等 reload 完成）；
 *   ② run 全程存活：托盘计数不变、runtime 日志无 `connection lost`/`code=143`、引擎 CLI pid
 *      reload 前后不变（D2b）、`[skill-reload]` 三段归因行齐备且 preserved 计数吻合（D8，
 *      runs=2/records=2 = 派发数）；
 *   ③ run 自然完成后主 session JSONL 有两个 runId 的终态 workflow-record entry（W17）；
 *   ④ S5 收尾段：session.delete 真杀路径照常 + 引擎执行树无孤儿进程。
 *
 * S5 的 /new 偏差说明：runtime WS 面无 new_session 命令（transport/session-message-handler.ts
 * 命令枚举核实），且 pi RPC prompt('/new') 不执行内置命令（内置斜杠命令仅 TUI 模式处理，
 * pi 0.84.4 dist/modes/rpc/rpc-mode.js + dist/core/agent-session.js prompt() 核实）——automatable
 * 等价面取 session.delete（removeSessionEntry 销毁收敛链，真会话离开语义），/new 手工项归 B5b
 * 真机手工段。
 *
 * 断言样本来源逐条见 e2e/fixtures/skill-reload-real-helpers.ts 文件头。
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
  SUB_MODEL_B,
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
  engineCliPids,
  engineTreePids,
  waitForEngineTreeGone,
} from './fixtures/skill-reload-real-helpers'

const SESSION_LABEL = 'skill-reload-survival'
const DEMO_A_DESC_V1 = 'Use this skill when the user asks for demo-alpha tasks.'
const DEMO_A_DESC_V2 = 'Use this skill when the user asks for demo-alpha tasks AFTER the reload edit.'

/** 长流式文本：chars/(4×tps) ≈ 60s，覆盖「派发→编辑→reload→adoption→断言」全窗口 */
function makeStreamText(tag: string): string {
  const unit = `${tag} reload-survival probe stream line. `
  return unit.repeat(Math.ceil(SUBAGENT_STREAM_CHARS / unit.length))
}

/** UI 切 session（real 轨范式，ask-user-real selectSessionInSidebar 同款） */
async function selectSessionInSidebar(page: Page, label: string): Promise<void> {
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 30_000 })
}

/** 打开 composer skill 浮层（行中空白后 `/` → skill 段）并断言候选行可见 */
async function expectSkillRow(page: Page, text: string, timeoutMs: number): Promise<void> {
  const row = page.locator('.cmd-row', { hasText: text }).first()
  await expect(row, `skill 浮层应含候选「${text}」`).toBeVisible({ timeout: timeoutMs })
}

test('S1: 编辑项目 skill 时在飞 run 存活 + 面板即时 + 归因日志 + 终态 entry + 无孤儿', async () => {
  test.setTimeout(420_000)
  const projectDir = makeTempDir('taiji-skillreload-proj-')
  const dataDir = makeTempDir('taiji-skillreload-data-')
  // preserved 归因行走 extension-logger 文件通道，必须在 app 启动前开启（helpers 文件头）
  process.env.TAIJI_AGENT_DEBUG = '1'
  const probeNames = ['survival-probe-a', 'survival-probe-b']
  let listenWs: import('ws').default | null = null
  let appCleanup: (() => Promise<void>) | null = null
  let reachedEnd = false // test.info().status 在 finally 不可靠（实测恒 'passed'），用确定性末行标志
  try {
    // ── 装配：项目 skill（demo-a）+ user 级 workflow 探针 + faux 脚本 ──
    writeProjectSkill(projectDir, 'demo-a', DEMO_A_DESC_V1)
    const probePaths = writeUserWorkflowScripts(dataDir, [
      { name: probeNames[0], source: makeSurvivalProbeSource(probeNames[0], SUB_MODEL_A, 'reload survival probe A') },
      { name: probeNames[1], source: makeSurvivalProbeSource(probeNames[1], SUB_MODEL_B, 'reload survival probe B') },
    ])
    const { page, cleanup } = await launchRealApp({
      dataDir,
      faux: {
        responses: {
          'faux/faux-1': mainDispatchSteps(probePaths, '两个 workflow 已在后台启动。'),
          ...survivorSteps(SUB_MODEL_A, makeStreamText('A')),
          ...survivorSteps(SUB_MODEL_B, makeStreamText('B')),
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

    // ── session 创建（cwd = 临时项目）+ UI 激活 + 监听 ──
    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's1-create',
      payload: { cwd: projectDir, label: SESSION_LABEL },
    }, 's1-create')
    expect(createReply.type).toBe('session.created')
    expect(createReply.payload, 'session.created 应带 payload').toBeDefined()
    const session = createReply.payload!.session as { id: string; sessionFile?: string }
    const sessionId = session.id
    const sessionFile = session.sessionFile ?? null
    await selectSessionInSidebar(page, SESSION_LABEL)
    const listen = await openListenWs(port, sessionId)
    listenWs = listen.ws
    const sessionEvents = listen.events

    // ── 派发：两个后台 workflow run（faux 主队列确定性触发）──
    await wsRoundTrip(port, {
      type: 'message.send',
      id: 's1-send',
      payload: { sessionId, content: '请依次运行两个 workflow 探针脚本。' },
    }, 's1-send', 30_000)

    // 托盘 workflow 按钮亮起计数 2（计数源 useTrayCounts → workflowStore，ComposerTray.vue）
    const workflowBtn = page.locator('[data-testid="tray-builtin-button"][data-kind="workflow"]')
    await expect(workflowBtn).toBeVisible({ timeout: 60_000 })
    await expect(workflowBtn.getByTestId('tray-builtin-count')).toHaveText('2', { timeout: 30_000 })
    await expect(workflowBtn).toHaveAttribute('data-state', 'running')

    // 引擎 CLI pid 基线（D2b 断言面：reload 前后同集合）
    const pidsBefore = engineCliPids()
    expect(pidsBefore.length, 'run 派发后应有引擎 CLI 进程').toBeGreaterThan(0)

    // ── G1：编辑前浮层基线（demo-a 可见 = panel cwd 接线 + .pi/skills 扫描集对账生效）──
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially(' /')
    await expectSkillRow(page, 'demo-a', 15_000)

    // ── 编辑：新增 demo-b + 改 demo-a description（浮层保持打开，断言 2s 窗口）──
    writeProjectSkill(projectDir, 'demo-b', 'Use this skill when the user asks for demo-beta tasks.')
    writeProjectSkill(projectDir, 'demo-a', DEMO_A_DESC_V2)
    const editAt = Date.now()
    await expectSkillRow(page, 'demo-b', 2_000)
    await expectSkillRow(page, DEMO_A_DESC_V2, 2_000)
    console.log(`[S1] 面板候选刷新耗时（含两次 expect 轮询启动）≈ ${Date.now() - editAt}ms`)

    // ── D8-a：watcher 批归因行（runtime log）──
    const d8a = await waitForLogLine(
      () => runtimeLogLines(dataDir).join('\n'),
      (l) => l.includes('[skill-reload] dir=project:') && l.includes(`affectedSessions=[${sessionId}`),
      15_000,
    )
    expect(d8a, '应出现 [skill-reload] dir=project 归因行且 affectedSessions 含本 session').not.toBeNull()

    // ── D8-b + preserved：决策行与 reload 分支归因（immediate 为主预期；queued 必有消费行）──
    const decision = await waitForLogLine(
      () => runtimeLogLines(dataDir).join('\n'),
      (l) => l.includes(`[reload-orchestrator] sessionId=${sessionId} decision=`),
      15_000,
    )
    expect(decision, '应出现 reload-orchestrator 决策行').not.toBeNull()
    const preservedLine = await waitForLogLine(
      () => readExtensionLogs(dataDir),
      (l) => l.includes('session_shutdown reason=reload preserved={'),
      15_000,
    )
    expect(preservedLine, 'TAIJI_AGENT_DEBUG=1 下应出现 preserved 归因行（agent/logs/subagents-*.log）').not.toBeNull()
    const preserved = parseLastPreserved(readExtensionLogs(dataDir))
    expect(preserved, 'preserved 计数应可解析').not.toBeNull()
    expect(preserved!.runs, 'preserved runs 应 = 派发的 2 个 run').toBe(2)
    expect(preserved!.records, 'preserved records 应 = 2 个 background subagent（calls.size）').toBe(2)
    expect(preserved!.stores, 'preserved stores 应 = 1 个 session 条目').toBe(1)

    // ── D2b：引擎 CLI pid reload 前后不变（同集合 = 单例未被 dispose 重建）──
    const pidsAfter = engineCliPids()
    expect(pidsAfter, 'reload 后引擎 CLI pid 集合应不变（D2b 幂等重注册）').toEqual(pidsBefore)

    // ── 存活反证：无断连杀链 ──
    const runtimeLog = runtimeLogLines(dataDir).join('\n')
    expect(runtimeLog.includes('connection lost'), '不应出现 relay kill-on-disconnect').toBe(false)
    expect(runtimeLog.includes('code=143'), '不应出现 code=143（SIGTERM 连坐）').toBe(false)

    // ── run 自然完成：两个 workflowUpdate done（runId 互异）──
    const doneUpdates = await (async (): Promise<Array<{ runId: string }>> => {
      const deadline = Date.now() + 150_000
      const found = new Map<string, { runId: string }>()
      while (Date.now() < deadline && found.size < 2) {
        for (const e of sessionEvents) {
          if (e.type !== 'session.workflowUpdate') continue
          const update = e.payload?.update as { status?: unknown; runId?: unknown } | undefined
          if (update?.status === 'done' && typeof update.runId === 'string') {
            found.set(update.runId, { runId: update.runId })
          }
        }
        if (found.size < 2) await new Promise((r) => setTimeout(r, 1000))
      }
      return [...found.values()]
    })()
    expect(doneUpdates.length, '应收到两个 run 的 done 广播').toBe(2)

    // ── W17：主 session JSONL 两个 runId 均有终态 workflow-record entry ──
    let mainFile = sessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在（session.created reply）').toBeTruthy()
    for (const { runId } of doneUpdates) {
      let rec = lastWorkflowRecordFor(mainFile!, runId)
      const recDeadline = Date.now() + 15_000
      while ((rec === null || rec.status !== 'done') && Date.now() < recDeadline) {
        await new Promise((r) => setTimeout(r, 1000))
        rec = lastWorkflowRecordFor(mainFile!, runId)
      }
      expect(rec?.status, `run ${runId} 的末条 workflow-record 应为终态 done`).toBe('done')
    }

    // ── 托盘收口：run 结束后 workflow 按钮归 idle、计数消失（归零不虚亮）──
    // 长窗轮询（120s = 单 run 全生命周期 + 完成通知 triggerTurn 余量）：不假设「done 广播后
    // 无后续派发」，窗口内全部 run 落终态托盘即归 idle，命中即返回不空耗
    await expect(workflowBtn).toHaveAttribute('data-state', 'idle', { timeout: 120_000 })
    await expect(workflowBtn.getByTestId('tray-builtin-count')).toHaveCount(0)

    // ── S5 收尾段：session.delete 真杀路径 + 无孤儿（/new 偏差见文件头）──
    const treeBaseline = engineTreePids()
    await wsRoundTrip(port, {
      type: 'session.delete',
      id: 's1-delete',
      payload: { sessionId },
    }, 's1-delete', 30_000)
    const orphans = await waitForEngineTreeGone(treeBaseline, 20_000)
    expect(orphans, 'session 删除后引擎执行树应无残留进程').toEqual([])

    listenWs?.close()
    console.log('[S1] 通过：面板 2s 刷新 / run 存活 / 三段归因 / 终态 entry / 无孤儿')
    reachedEnd = true
  } finally {
    delete process.env.TAIJI_AGENT_DEBUG
    // 失败取证放最前（appCleanup 之前）：logs 拷到固定路径，规避后续清理丢失现场。
    // agent/sessions 一并拷贝——W17 断言面（主 session JSONL 的 workflow-record entry）在这里
    if (!reachedEnd) {
      const keep = `/tmp/s1-failed-${Date.now()}`
      try {
        fs.mkdirSync(keep, { recursive: true })
        fs.cpSync(path.join(dataDir, 'logs'), path.join(keep, 'logs'), { recursive: true })
        fs.cpSync(path.join(dataDir, 'agent', 'logs'), path.join(keep, 'agent-logs'), { recursive: true })
        fs.cpSync(path.join(dataDir, 'agent', 'sessions'), path.join(keep, 'agent-sessions'), { recursive: true })
        console.log(`[S1] 失败取证：logs -> ${keep}（dataDir=${dataDir}）`)
      } catch (e) {
        console.log(`[S1] 失败取证拷贝失败：${e}（dataDir=${dataDir}）`)
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
