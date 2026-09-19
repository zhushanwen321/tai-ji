/**
 * skill-reload ASKUSER real E2E（S1b 双 session 并发放大 + ask_user 反向请求，
 * 设计 .tmp/tech-design/skill-reload-nondestructive.md §4 S1b）。
 *
 * faux LLM 轨（L2.5，选型理由见 e2e-map.json E2E-SKILLRELOAD-02 note）。两个 session
 * （同一 mkdtemp 项目 cwd）各派一个会触发 ask_user 的后台 workflow run（faux 槽位演员：
 * 长流式响应保持 run 在飞跨越「编辑全局 skill → 双 session reload → adoption」，随后
 * ask_user toolCall 在 reload 完成之后才触发——D3 host-ui-endpoint 槽现读的真机窗口）。
 * 编辑面取**全局** skill 目录（<dataDir>/agent/skills，resolveGlobalSkillDirs 首项），
 * 驱动全部活跃 session 并发 reload+adoption。
 *
 * 通过标准（设计 S1b + reload-closeout-reliability §4 A1 断言升级）：
 * - 两 session 的 run 都存活（各自 preserved 归因行 records=1 + 双 done 广播 + 无
 *   `connection lost`/`code=143`）；
 * - D8-a dir=global 归因行 affectedSessions 同时列出两个 sid；D8-b 双 decision 行；
 * - reload 完成后触发的 ask_user 反向请求正常送达 UI 且可应答（form-overlay 渲染 →
 *   选项 → submit → overlay 关闭；pi 恢复 turn 由 run 后续 faux 步骤继续消费证明）——
 *   无静默取消（静默取消 = {cancelled:true}，overlay 根本不渲染，本断言直接击穿）；
 * - G1 必达窗口（A1 新断言，2026-09-19）：run 完成（主 session JSONL 终态 done 落盘）
 *   后 ≤30s `session.workflowUpdate` done 帧到达 spec WS——agent_settled 对账腿秒级 /
 *   15s 定时腿最坏 ≈15s+单轮，30s = 2x 余量。按 u0 报告 §5 分派：断点在当前 HEAD
 *   零复现（②段全链健康 0/6），按「守卫/发布门跳 = 水位」主形态编写，不预设 bus
 *   内部分支预期红。
 *
 * 断言顺序契约（u0 报告 §1.1，spec 断言竞态解耦）：dialog 阶段 select 后必须先
 * answerOverlay 再断言 composer——FormOverlay 与 composer 互斥（Panel.vue：overlay
 * 挂起时 composer 不在 DOM），目标 session 的 ask_user 若在 select 前已触发，
 * 先断言 composer 会 30s 扑空（2026-09-19 复跑运行 2 实证的假失败形态，非产品缺陷）。
 *
 * L2 dialog 队列按 pi 进程分域（DialogGlobalQueue 进程级单例，每 session 独立 pi 进程），
 * 两个 dialog 相互独立送达——先切 A 应答，再切 B 应答，无跨 session 串行依赖。
 *
 * 测试红线：全局 skill 写入用唯一临时名（e2e-global-<随机>），finally 显式删除（dataDir
 * 整树删除是兜底）。断言样本来源见 e2e/fixtures/skill-reload-real-helpers.ts 文件头。
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
  makeTempDir,
  makeSurvivalProbeSource,
  mainDispatchSteps,
  writeProjectSkill,
  writeUserWorkflowScripts,
  seedSubagentExtension,
  readExtensionLogs,
  parseLastPreserved,
  waitForLogLine,
  runtimeLogLines,
  writeGlobalSkill,
  awaitWorkflowDoneTimed,
  WORKFLOW_DONE_MAX_LATENCY_MS,
  DONE_TIMING_OBSERVE_SLACK_MS,
} from './fixtures/skill-reload-real-helpers'

const PROJ_LABEL = 'skill-reload-askuser-proj'
const SESSION_A_LABEL = 's1b-session-a'
const SESSION_B_LABEL = 's1b-session-b'
const PRE_ASK_STREAM_CHARS = 1600 // ≈40s @ tps 10：留足「编辑→reload→adoption→日志断言」余量后才触发 ask_user

/** ask_user 工具参数（≥2 选项，满足 ask-user validateInput 与 overlay 渲染断言） */
const ASK_USER_TOOL_ARGS = {
  questions: [{
    question: 'reload 后方向请求是否送达？',
    options: [
      { label: '已送达', description: 'G2 反向请求不静默取消' },
      { label: '未送达', description: '不应出现' },
    ],
  }],
}

function makeAskRunnerScript(name: string): string {
  // 长流式（跨 reload 窗口）→ ask_user（反向请求）→ 收尾文本（应答后消费 = pi 恢复 turn 证据）
  const unit = 'askuser probe stream line. '
  const streamText = unit.repeat(Math.ceil(PRE_ASK_STREAM_CHARS / unit.length))
  return [
    `// ${name} — skill-reload S1b 探针（e2e 运行期生成）`,
    '/* @pi-meta',
    `name: ${name}`,
    `description: reload 后触发 ask_user 反向请求的探针`,
    'phases: ["probe"]',
    '*/',
    '',
    'phase("probe");',
    '',
    `const outcome = await agent({`,
    '  prompt: "Stream the text, then ask the user, then confirm.",',
    `  model: "${SUB_MODEL_A}",`,
    `  description: "${name}",`,
    '});',
    '',
    '// subagent 响应队列（faux/faux-1-b 槽位）在上方 agent() 内消费——本 run 的',
    '// ask_user 触发面由 subagent 的 faux 脚本承接：长流式 → ask_user → 收尾。',
    `return { done: outcome !== undefined, name: "${name}" };`,
    '',
  ].join('\n')
}

/** subagent 槽位演员队列：长流式（≈40s，跨 reload 窗口）→ ask_user toolCall → 应答后收尾文本 */
function askSurvivorSteps(): Record<string, import('./fixtures/launch-app-real').FauxStep[]> {
  const unit = 'askuser survivor stream line. '
  const streamText = unit.repeat(Math.ceil(PRE_ASK_STREAM_CHARS / unit.length))
  return {
    [SUB_MODEL_A]: [
      // 长流式文本与 ask_user 调用必须同一步（faux 语义：toolCalls 步自动 stopReason=toolUse，
      // 流式输出完成后同一响应携带 toolCall → pi 执行 ask_user → 下一轮请求消费收尾步）。
      // 拆成「text 步 + toolCalls 步」不成立：纯 text 步 stop 即 turn 终，后续步永不消费；
      // text 步显式 toolUse 又无工具内容 = 引擎重派。
      { text: streamText, toolCalls: [{ name: 'ask_user', args: ASK_USER_TOOL_ARGS }] },
      { text: '已收到应答，反向请求未静默取消。' },
    ],
  }
}

async function selectSessionInSidebar(page: Page, label: string): Promise<void> {
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 30_000 })
}

/** 应答当前 panel 上的提问表单 overlay（选第一项 → submit → overlay 关闭） */
async function answerOverlay(page: Page): Promise<void> {
  const overlay = page.getByTestId('form-overlay')
  await expect(overlay, 'ask_user 反向请求应送达 UI（overlay 渲染，无静默取消）').toBeVisible({ timeout: 60_000 })
  const option = page.locator('[data-testid^="form-option-"]').first()
  await option.click()
  await page.getByTestId('form-submit').click()
  await expect(overlay, '应答后 overlay 应关闭').toBeHidden({ timeout: 15_000 })
}

/**
 * dialog 阶段的 session 切换 + 应答（u0 §1.1 断言竞态解耦后的顺序契约）：
 * 点击侧栏 → answerOverlay → 断言 composer 回归。
 *
 * 必须先 overlay 后 composer：FormOverlay 挂起时 composer 不在 DOM（互斥），目标
 * session 的 ask_user 可能在 select 前已触发（对端 overlay 等待窗把本次 select 推进
 * 本 session 的 overlay 窗口），先断言 composer 必然 30s 扑空。应答关闭后 composer
 * 回归 = 激活成功 + 输入可用的原断言面（时点后移，强度不变）。
 */
async function selectAndAnswerOverlay(page: Page, label: string): Promise<void> {
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  await answerOverlay(page)
  await expect(page.getByTestId('composer-box'), 'overlay 应答关闭后 composer 应回归').toBeVisible({ timeout: 15_000 })
}

test('S1b: 双 session 并发 reload 存活 + 全局 skill 归因行列双 sid + ask_user 送达可应答', async () => {
  test.setTimeout(420_000)
  // 前缀须短：<dataDir>/run/relay-<pid>.sock 受 macOS UDS 路径 104B 上限约束，
  // 长前缀（taiji-skillreload-askuser-*）在 os.tmpdir() 深路径下 bind EINVAL，runtime 直接起不来
  const projectDir = makeTempDir('taiji-sr-ask-proj-')
  const dataDir = makeTempDir('taiji-sr-ask-data-')
  process.env.TAIJI_AGENT_DEBUG = '1'
  let globalSkillDir: string | null = null
  let listenWsA: import('ws').default | null = null
  let listenWsB: import('ws').default | null = null
  let appCleanup: (() => Promise<void>) | null = null
  let reachedEnd = false // test.info().status 在 finally 不可靠（实测恒 'passed'），用确定性末行标志
  try {
    writeProjectSkill(projectDir, 'demo-a', 'Use this skill when the user asks for demo-alpha tasks.')
    // subagent pi 孙进程的 ask_user 工具来自 ask-user extension，孙进程只走
    // <agentDir>/extensions/ 自动发现（TAIJI_EXTENSION_PATHS 不透传孙进程），必须先种入
    seedSubagentExtension(dataDir, 'pi-ask-user')
    // 预创建全局 skill 根目录：setupGlobalWatcher 启动时按 existsSync 过滤 watch 列表，
    // 启动后才首建的目录不被 watch——本 spec 靠「编辑全局 skill」触发全 session reload，
    // 目录必须先于 app 启动存在（writeGlobalSkill 是运行中段首次写入）。
    fs.mkdirSync(path.join(dataDir, 'agent', 'skills'), { recursive: true })
    const [probeA, probeB] = writeUserWorkflowScripts(dataDir, [
      { name: 'askuser-probe-a', source: makeAskRunnerScript('askuser-probe-a') },
      { name: 'askuser-probe-b', source: makeAskRunnerScript('askuser-probe-b') },
    ])
    const survivor = askSurvivorSteps()
    const { page, cleanup } = await launchRealApp({
      dataDir,
      faux: {
        responses: {
          'faux/faux-1': mainDispatchSteps([probeA], 'workflow 已在后台启动。'),
          ...survivor,
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

    // ── 双 session（同 worktree cwd）创建 + 各自派发 run ──
    const created: Array<{ id: string; file: string | null }> = []
    for (const [idx, label] of [[0, SESSION_A_LABEL], [1, SESSION_B_LABEL]] as const) {
      const reply = await wsRoundTrip(port, {
        type: 'session.create',
        id: `s1b-create-${idx}`,
        payload: { cwd: projectDir, label },
      }, `s1b-create-${idx}`)
      expect(reply.type).toBe('session.created')
      expect(reply.payload, 'session.created 应带 payload').toBeDefined()
      const s = reply.payload!.session as { id: string; sessionFile?: string }
      created.push({ id: s.id, file: s.sessionFile ?? null })
    }
    const [sidA, sidB] = [created[0].id, created[1].id]

    // A 激活 → 派发 A（B 的 run 派发走 B 的 pi 进程，faux 队列 per 进程独立消费）
    await selectSessionInSidebar(page, SESSION_A_LABEL)
    const listenA = await openListenWs(port, sidA)
    listenWsA = listenA.ws
    await wsRoundTrip(port, { type: 'message.send', id: 's1b-send-a', payload: { sessionId: sidA, content: '运行 askuser 探针 A。' } }, 's1b-send-a', 30_000)
    await selectSessionInSidebar(page, SESSION_B_LABEL)
    const listenB = await openListenWs(port, sidB)
    listenWsB = listenB.ws
    await wsRoundTrip(port, { type: 'message.send', id: 's1b-send-b', payload: { sessionId: sidB, content: '运行 askuser 探针 B。' } }, 's1b-send-b', 30_000)

    // 双 run 在飞确认：两 session 的 workflow 托盘按钮均亮（切 B 时 B 面板可见）
    const workflowBtn = page.locator('[data-testid="tray-builtin-button"][data-kind="workflow"]')
    await expect(workflowBtn).toHaveAttribute('data-state', 'running', { timeout: 60_000 })

    // ── 编辑全局 skill（唯一临时名；触发全部活跃 session reload）──
    globalSkillDir = writeGlobalSkill(dataDir, `e2e-global-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, 'Use this skill when the user asks for global reload check.')

    // ── D8-a：dir=global 归因行同时列出两个 sid（顺序不定，双查）──
    const d8a = await waitForLogLine(
      () => runtimeLogLines(dataDir).join('\n'),
      (l) => l.includes('[skill-reload] dir=global event=')
        && l.includes(sidA) && l.includes(sidB),
      20_000,
    )
    expect(d8a, 'dir=global 归因行应同时列出两个 session').not.toBeNull()

    // ── D8-b：双 session 各有决策行；preserved 行 ≥2 条（每 pi 进程一条）且 records=1 ──
    for (const sid of [sidA, sidB]) {
      const decision = await waitForLogLine(
        () => runtimeLogLines(dataDir).join('\n'),
        (l) => l.includes(`[reload-orchestrator] sessionId=${sid} decision=`),
        20_000,
      )
      expect(decision, `session ${sid} 应有 reload 决策行`).not.toBeNull()
    }
    const preservedDeadline = Date.now() + 20_000
    let preservedLines: string[] = []
    while (Date.now() < preservedDeadline) {
      preservedLines = readExtensionLogs(dataDir).split('\n').filter((l) => l.includes('session_shutdown reason=reload preserved={'))
      if (preservedLines.length >= 2) break
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(preservedLines.length, '两个 session 各应有一条 preserved 归因行').toBeGreaterThanOrEqual(2)
    const parsed = preservedLines.map((l) => parseLastPreserved(l))
    for (const p of parsed) {
      expect(p?.records, '每 session preserved records 应 = 1 个在飞 subagent').toBe(1)
    }

    // ── 存活反证：无断连杀链（必须在 run 在飞窗口内断言）──
    // 位置契约与 survival 同款：reload 窗口 + run 在飞期间 relay 不得 kill-on-disconnect。
    // 不能移到 done 之后——两 run 终态后完成通知 triggerTurn 命中 faux 队列耗尽（防重播种
    // 守卫的预期形态）→ 主 pi turn 收尾与引擎子进程退场存在时序竞态，收尾兜底
    // 「connection lost, killing child (code=143)」会在 run 已终态、数据无损后落盘，
    // 属设计内收尾形态，非「在飞 run 被误杀」——done 后再查必然误红（2026-09-19 复验实证）。
    const runtimeLogInflight = runtimeLogLines(dataDir).join('\n')
    expect(runtimeLogInflight.includes('connection lost'), '不应出现 relay kill-on-disconnect').toBe(false)
    expect(runtimeLogInflight.includes('code=143'), '不应出现 code=143').toBe(false)

    // ── A 的 dialog：切回 A，reload 后触发的 ask_user 送达 UI → 应答 → 关闭 ──
    // 顺序契约（u0 §1.1）：select 后先 answerOverlay 再断言 composer（见 helper 注释）
    await selectAndAnswerOverlay(page, SESSION_A_LABEL)

    // ── B 的 dialog：切到 B，同样送达可应答（双 session 各自独立 L2 队列域）──
    await selectAndAnswerOverlay(page, SESSION_B_LABEL)

    // ── 双 run 自然完成：done 帧到达 + 各自主 session JSONL 终态 entry（双锚计时）──
    for (const c of created) {
      expect(c.file, '主 session JSONL 路径应存在').toBeTruthy()
    }
    const [timingA, timingB] = [
      await awaitWorkflowDoneTimed(listenA.events, created[0].file),
      await awaitWorkflowDoneTimed(listenB.events, created[1].file),
    ]
    expect(timingA, 'session A 的 run 应自然完成（done 帧到达 + JSONL 终态 done）').not.toBeNull()
    expect(timingB, 'session B 的 run 应自然完成（done 帧到达 + JSONL 终态 done）').not.toBeNull()
    // G1 必达窗口（设计 §4 A1 新断言）：完成锚（JSONL 终态落盘）→ 到达锚（done 帧到
    // spec WS）≤30s。负时差钳 0（帧先于文件 flush 被观测 = 收敛更早，仍满足必达）；
    // +DONE_TIMING_OBSERVE_SLACK_MS = 双锚各一次轮询观测粒度。
    for (const t of [timingA!, timingB!]) {
      const latency = Math.max(0, t.tFrameSeen - t.tDoneRecord)
      console.log(`[S1b] run ${t.runId} 完成→done 帧到达延迟 ${latency}ms`)
      expect(
        latency,
        `run ${t.runId} 完成后 ≤${WORKFLOW_DONE_MAX_LATENCY_MS}ms workflowUpdate 帧应到达 spec WS`,
      ).toBeLessThanOrEqual(WORKFLOW_DONE_MAX_LATENCY_MS + DONE_TIMING_OBSERVE_SLACK_MS)
    }

    listenWsA?.close()
    listenWsB?.close()
    console.log('[S1b] 通过：双 session 存活 / dir=global 双 sid / dialog 双送达可应答 / 终态 entry / ≤30s 必达')
    reachedEnd = true
  } finally {
    delete process.env.TAIJI_AGENT_DEBUG
    // 失败取证放最前（appCleanup 之前）：logs 拷到固定路径，规避后续清理/挂起丢失现场
    if (!reachedEnd) {
      const keep = `/tmp/s1b-failed-${Date.now()}`
      try {
        fs.mkdirSync(keep, { recursive: true })
        fs.cpSync(path.join(dataDir, 'logs'), path.join(keep, 'logs'), { recursive: true })
        fs.cpSync(path.join(dataDir, 'agent', 'logs'), path.join(keep, 'agent-logs'), { recursive: true })
        console.log(`[S1b] 失败取证：logs -> ${keep}（dataDir=${dataDir}）`)
      } catch (e) {
        console.log(`[S1b] 失败取证拷贝失败：${e}（dataDir=${dataDir}）`)
      }
    }
    if (globalSkillDir !== null) {
      // 全局 skill 目录写入红线：finally 显式清理（dataDir 整树删除是兜底）
      fs.rmSync(globalSkillDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    listenWsA?.close()
    listenWsB?.close()
    if (appCleanup) await appCleanup()
    if (reachedEnd) {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }
})
