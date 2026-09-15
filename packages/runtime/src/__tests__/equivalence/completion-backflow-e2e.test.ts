/**
 * sd-u6 完成回流真机 e2e（S2 场景，U6-S2）— design.md §4 S2 / §3.1 调用方 C 的机器化。
 *
 * 与 sd-u4 e2e-scheduler-s4.sh（裸 pi 挂 extension，pi 进程内自含）不同：回流编排
 * （completion-backflow）在 taiji runtime 侧组合根，裸 pi CLI 没有这条腿——本 e2e 的形态是
 * 「最小驱动器模拟 runtime 组合」：spawn 两个真实 pi rpc 子进程（父/子），驱动器接上
 * **真实** completion-backflow 模块 + **真实** SessionDeliveryRegistry（真 delivery 内核），
 * 仅 SessionService / ProcessManager 由驱动器以最小实现替换（内存态 views + 事件流分发）。
 * 「create+send」由驱动器执行（打标 spawnSource/parentAgentSessionId 模拟 session-lifecycle
 * 打标腿；子 pi prompt 模拟 handleSend send 腿）——被测物是回流链本身。
 *
 * 断言链（事件同步，禁固定 sleep）：
 * 子 pi 短任务 settled（waitForEvent agent_settled）→ 驱动器分发 settled 多播 →
 * backflow 查打标 → 父 delivery（真内核）→ 父 pi prompt(steer) → 父无人工输入自动开新 turn
 * （waitForEvent agent_start）→ get_entries(父) 校验通知文案含 label/status/`Full transcript:` 指针行。
 *
 * 环境约定照抄 equivalence 族（pi-fixture.ts）。faux LLM 轨（L2.5 翻轨）：被测对象是
 * 回流编排链（settled 边沿 → 打标查询 → 父 delivery → 父自动开新 turn），子任务只需
 * settle（bash ls 真实执行 + 文本定局，脚本固定）；父 pi 的回流 turn 消费一步脚本回复。
 * 门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/completion-backflow-e2e.test.ts
 * 入口脚本：bash scripts/e2e-s2-backflow.sh（标记行 U6_BACKFLOW_E2E PASS|FAIL）
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDeliveryRegistry } from '../../services/session/session-delivery-registry.js'
import { createCompletionBackflow } from '../../services/session/completion-backflow.js'
import { applySessionOccupancyTransition } from '../../services/session/event-interpreter.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import { PiSessionStore } from '../../infra/pi/session-store.js'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

/** 单步等待上限（任务护栏：每步最多 60s，真实 LLM 轮次余量） */
const STEP_TIMEOUT_MS = 60_000
/** 固定子 session label（断言锚点） */
const CHILD_LABEL = 'u6-child'

/** 驱动器内存态 view（session-lifecycle 打标字段的宿主） */
interface DriverView extends IManagedSessionView {
  spawnSource?: 'user' | 'agent'
  parentAgentSessionId?: string
}

function makeView(id: string, cwd: string, label: string, sessionFilePath?: string): DriverView {
  return {
    id,
    cwd,
    label,
    modelId: 'xiaomi-token-plan-cn/mimo-v2.5-pro',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    sessionFilePath,
  }
}

describe.skipIf(!FAUX_PI_READY)(`completion backflow e2e faux pi${FAUX_PI_READY ? '' : `（skip：${FAUX_PI_SKIP_REASON}）`}`, () => {
  it('U6-S2 子 session 短任务完成 → 父 session 无人工输入自动开新 turn，上下文含完成通知（label/status/Full transcript 指针）', { timeout: 150_000 }, async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'u6-backflow-'))
    let parentFx: PiFixture | undefined
    let childFx: PiFixture | undefined
    try {
      // ── 1. 两个真实 pi（父/子，各自独立 session-dir 隔离上下文）──
      // fixture 显式 sessionDir 不负责建目录（spawn cwd 需已存在，U9 e2e 同款先例）。
      // faux 轨：子 = bash ls 真实执行 + U6-DONE 定局（脚本固定，settle 即回流触发前提）；
      // 父 = 回流 steer turn 消费一步脚本回复（新 turn 的 message_end 断言锚）
      const parentDir = join(dataRoot, 'parent')
      const childDir = join(dataRoot, 'child')
      mkdirSync(parentDir, { recursive: true })
      mkdirSync(childDir, { recursive: true })
      parentFx = await spawnPiFixture({ sessionDir: parentDir, fauxResponses: [{ text: 'noted' }] })
      childFx = await spawnPiFixture({
        sessionDir: childDir,
        fauxResponses: [
          { toolCalls: [{ name: 'bash', args: { command: 'ls' } }] },
          { text: 'U6-DONE' },
        ],
      })

      const parentState = await parentFx.sendCommand('get_state')
      const parentSessionId = (parentState.data as { sessionId?: string }).sessionId
      expect(parentSessionId, '父 pi get_state 应返回 sessionId').toBeTruthy()
      const childState = await childFx.sendCommand('get_state')
      const childSessionId = (childState.data as { sessionId?: string }).sessionId
      expect(childSessionId, '子 pi get_state 应返回 sessionId').toBeTruthy()
      // pi session 文件 = <timestamp>_<sessionId>.jsonl（首条 assistant 消息时才 flush），
      // spawn 期不可预知文件名——settled 后从 childDir 扫唯一 jsonl 回填 view（下方步骤 3.5）
      let childSessionFile: string | undefined

      // ── 2. 驱动器组装最小 runtime 组合（真 backflow + 真 registry + 真 kernel）──
      // 内存态 views：父（回流目标）/ 子（打标 spawnSource='agent' + parentAgentSessionId，
      // 模拟 session-lifecycle.ts 打标腿 + create 的 sessionFile 指针）
      const parentView = makeView(parentSessionId!, parentFx.sessionDir, 'u6-parent')
      const childView: DriverView = {
        ...makeView(childSessionId!, childFx.sessionDir, CHILD_LABEL),
        spawnSource: 'agent',
        parentAgentSessionId: parentSessionId,
      }
      const views = new Map<string, DriverView>([
        [parentSessionId!, parentView],
        [childSessionId!, childView],
      ])

      // settled 多播（组合根 agentSettledListeners 的驱动器形态）：子 settled 事件边沿 → 分发。
      // 父侧仅维护 isGenerating 信号（D7 置位后由父 settled 复位），供内核 isIdle gate。
      const settledCbs: Array<(sid: string) => void> = []
      void parentFx.waitForEvent((e) => e.type === 'agent_settled', { timeoutMs: STEP_TIMEOUT_MS * 3 })
        .then(() => { applySessionOccupancyTransition(parentView, null, 'idle') })
        .catch(() => {})

      // registry：真实实现；ensureActive(父) 返回父 pi 的最小 client adapter
      // （prompt → 父 pi stdin JSONL；pi preflight 受理即回 = sendChecked 语义前提）
      const registry = createSessionDeliveryRegistry({
        getSession: (sid) => views.get(sid),
        ensureActive: async (sid: string) => {
          if (sid !== parentSessionId) throw new Error(`unexpected ensureActive target: ${sid}`)
          return {
            prompt: async (content: string, _sessionId?: string, streamingBehavior?: 'steer' | 'followUp') => {
              const resp = await parentFx!.sendCommand('prompt', {
                message: content,
                ...(streamingBehavior ? { streamingBehavior } : {}),
              }, STEP_TIMEOUT_MS)
              expect(resp.success, `父 pi prompt 应受理成功：${JSON.stringify(resp)}`).toBe(true)
            },
          } as unknown as never
        },
        subscribeAgentSettled: (cb) => {
          settledCbs.push(cb)
          return () => {}
        },
        recordWorkspace: () => {},
        getMessageBus: () => null,
      })

      // backflow：真实实现；getSessionOutcome 用真实 PiSessionStore 读子 session_end
      // （pi 不写 session_end → null → status 'completed'，语义与单测固化一致）
      const sessionStore = new PiSessionStore()
      const backflow = createCompletionBackflow({
        getSession: (sid) => views.get(sid),
        subscribeAgentSettled: (cb) => {
          settledCbs.push(cb)
          return () => {}
        },
        subscribeSessionExit: () => () => {},
        getSessionOutcome: (fp) => sessionStore.extractSessionOutcome(fp),
        getDelivery: (parentSid) => registry.getOrCreateDelivery(parentSid),
      })

      // ── 3. send：子 pi 短任务（事件同步等 settled 边沿）──
      const sendResp = await childFx.sendCommand('prompt', {
        message: 'Run ls in the current directory, then reply with exactly: U6-DONE',
      }, STEP_TIMEOUT_MS)
      expect(sendResp.success, '子 pi prompt 应受理成功').toBe(true)
      await childFx.waitForEvent((e) => e.type === 'agent_settled', { timeoutMs: STEP_TIMEOUT_MS })

      // 3.5 子 transcript 已 flush（agent_settled 晚于 pi finally flush）→ 扫唯一 jsonl
      // 回填 view 指针，再分发 settled（backflow 读到的即最终路径）
      const jsonlFiles = readdirSync(childDir).filter((f) => f.endsWith('.jsonl'))
      expect(jsonlFiles.length, `childDir 应恰有一个 session jsonl，实际：${jsonlFiles.join(', ')}`).toBe(1)
      childSessionFile = join(childDir, jsonlFiles[0]!)
      childView.sessionFilePath = childSessionFile
      expect(existsSync(childSessionFile), `子 session 文件应已落盘：${childSessionFile}`).toBe(true)

      // ── 4. settled 边沿 → 驱动器分发（组合根多播形态）→ 回流自动投父 ──
      for (const cb of [...settledCbs]) cb(childSessionId!)

      // ── 5. 父无人工输入自动开新 turn（回流唤醒的端到端证据）──
      await parentFx.waitForEvent((e) => e.type === 'agent_start', { timeoutMs: STEP_TIMEOUT_MS })
      // 等 turn 定局再读 entries（user message 已入树）
      await parentFx.waitForEvent((e) => e.type === 'message_end', { timeoutMs: STEP_TIMEOUT_MS })

      // ── 6. get_entries(父) 校验通知文案（label/status/Full transcript 指针行）──
      const entriesResp = await parentFx.sendCommand('get_entries', {}, STEP_TIMEOUT_MS)
      const entries = (entriesResp.data as { entries?: Array<{ type?: string; message?: { role?: string; content?: unknown } }> }).entries ?? []
      const userTexts = entries
        .filter((e) => e.type === 'message' && e.message?.role === 'user')
        .map((e) => {
          // pi user message content 双形态：string 或 blocks 数组 [{type:'text',text}]
          const c = e.message?.content
          if (typeof c === 'string') return c
          if (Array.isArray(c)) {
            return c.map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
              ? (b as { text: string }).text
              : '')).join('')
          }
          return ''
        })
      const notify = userTexts.find((t) => t.includes('Managed session'))
      expect(notify, `父上下文应含完成通知 user message，实际 user messages：${JSON.stringify(userTexts)}`).toBeDefined()
      expect(notify).toContain(`Managed session "${CHILD_LABEL}" (${childSessionId}) finished with status "completed".`)
      expect(notify).toContain(`Full transcript: ${childSessionFile!}`)
    } finally {
      await parentFx?.dispose().catch(() => {})
      await childFx?.dispose().catch(() => {})
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
