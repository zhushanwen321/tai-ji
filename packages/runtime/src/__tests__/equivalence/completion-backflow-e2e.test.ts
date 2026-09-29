/**
 * notify-once U6-S2 迁移 e2e（faux pi，L2.5）——原 completion-backflow-e2e 的债权形态改写。
 *
 * [HISTORICAL] 迁移说明：CompletionBackflow（settled → 纯文本回流注入父会话）已随
 * notify-once 废弃删除（设计 U3）。原 e2e 守护的「子会话完成 → runtime 侧检测 → 父会话
 * 收到通知」链路，终态形态 = 子会话完成 → ClaimLedger 兑现（settle）→ watch respond
 * payload（extension 侧据此 record 进 B-ledger 送达父会话——文案构造/投递归
 * extensions/universal/session-manager 的 notify-content/watch-orchestration 测试族）。
 * 本资产保留的 e2e 价值 = **真实 pi settle 边沿驱动真实状态机与桥接助手**：真 spawn 子 pi、
 * 真 sendDirect 投递（受理回执 arm→inject）、真 agent_settled 兑现、respond payload 携
 * 真实 transcript 路径。
 *
 * 断言链（事件同步，禁固定 sleep）：子 pi 短任务 settled（waitForEvent agent_settled）→
 * 驱动器 settle 兑现（真 ClaimLedger）→ respond 素材回执 → payload reason/settleSeq/
 * fulfillsN/sessionFilePath 精确断言。
 *
 * 环境约定照抄 equivalence 族（pi-fixture.ts）。faux LLM 轨：子任务只需 settle
 *（bash ls 真实执行 + 文本定局，脚本固定）。
 * 门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/completion-backflow-e2e.test.ts
 */

import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDeliveryRegistry } from '../../services/session/session-delivery-registry.js'
import { createClaimLedger } from '../../services/session/notify-claims.js'
import { deliverRespondTargets } from '../../transport/session-manager-handler.js'
import { applySessionOccupancyTransition } from '../../services/session/event-interpreter.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import type { SessionManagerWatchRespondPayload } from '@zhushanwen/extension-protocol'
import { PiSessionStore } from '../../infra/pi/session-store.js'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

/** 单步等待上限（任务护栏：每步最多 60s，真实 LLM 轮次余量） */
const STEP_TIMEOUT_MS = 60_000
/** 驱动器固定的发起方（真实组合根 = 路由上下文父 session id） */
const PARENT_SID = 'e2e-parent'
/** 债权幂等键（协议形态：sm- + UUID4） */
const CLAIM_NID = 'sm-aaaaaaaa-1111-2222-3333-444444444444'
const LIFETIME_NID = 'sm-bbbbbbbb-1111-2222-3333-444444444444'

/** 驱动器内存态 view（session-lifecycle 打标字段的宿主） */
interface DriverView extends IManagedSessionView {
  spawnSource?: 'user' | 'agent'
  parentAgentSessionId?: string
}

function makeView(id: string, cwd: string, sessionFilePath?: string): DriverView {
  return {
    id,
    cwd,
    label: 'u6-e2e-child',
    modelId: 'xiaomi-token-plan-cn/mimo-v2.6-flash',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    sessionFilePath,
    spawnSource: 'agent',
    parentAgentSessionId: PARENT_SID,
  }
}

describe.skipIf(!FAUX_PI_READY)(`notify-once settle 链 e2e faux pi${FAUX_PI_READY ? '' : `（skip：${FAUX_PI_SKIP_REASON}）`}`, () => {
  it('U6-S2 迁移：子 session 短任务 settle → ClaimLedger 兑现 → respond 携 completed/settleSeq/fulfillsN/真实 transcript', { timeout: 150_000 }, async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'u6-notify-'))
    let childFx: PiFixture | undefined
    const ledger = createClaimLedger()
    try {
      // ── 1. 真实 pi 子进程（faux 轨：bash ls 真实执行 + U6-DONE 定局）──
      const childDir = join(dataRoot, 'child')
      mkdirSync(childDir, { recursive: true })
      childFx = await spawnPiFixture({
        sessionDir: childDir,
        fauxResponses: [
          { toolCalls: [{ name: 'bash', args: { command: 'ls' } }] },
          { text: 'U6-DONE' },
        ],
      })
      const childState = await childFx.sendCommand('get_state')
      const childSessionId = (childState.data as { sessionId?: string }).sessionId
      expect(childSessionId, '子 pi get_state 应返回 sessionId').toBeTruthy()

      // ── 2. 驱动器组装（真 ClaimLedger + 真 delivery registry；respond = 记录型 spy）──
      const childView = makeView(childSessionId!, childFx.sessionDir)
      const views = new Map<string, DriverView>([[childSessionId!, childView]])
      const client = {
        prompt: async (content: string) => {
          const resp = await childFx!.sendCommand('prompt', { message: content }, STEP_TIMEOUT_MS)
          expect(resp.success, `子 pi prompt 应受理成功：${JSON.stringify(resp)}`).toBe(true)
        },
      }
      const registry = createSessionDeliveryRegistry({
        getSession: (sid) => views.get(sid),
        ensureActive: async () => client as unknown as never,
        subscribeAgentSettled: () => () => {},
        recordWorkspace: () => {},
        getMessageBus: () => null,
      })
      const responds: Array<{ watchId: string; payload: SessionManagerWatchRespondPayload }> = []
      const respond = (parentSid: string, watchId: string, payload: SessionManagerWatchRespondPayload): boolean => {
        expect(parentSid).toBe(PARENT_SID)
        responds.push({ watchId, payload })
        return true
      }

      // ── 3. 受理点 arm（create 路径形态：sendDirect 受理即 arm+inject）──
      expect(ledger.arm({ parentSid: PARENT_SID, notifyId: CLAIM_NID, kind: 'claim', sessionId: childSessionId! })).toEqual({ ok: true })
      expect(ledger.arm({ parentSid: PARENT_SID, notifyId: LIFETIME_NID, kind: 'lifetime', sessionId: childSessionId! })).toEqual({ ok: true })
      expect(ledger.openWatch(PARENT_SID, CLAIM_NID, 'w-claim').action).toBe('wait')
      expect(ledger.openWatch(PARENT_SID, LIFETIME_NID, 'w-lifetime').action).toBe('wait')

      // settled 边沿监听先于投递（waitForEvent 消费 pi stdout 事件流）
      const settledPromise = childFx.waitForEvent((e) => e.type === 'agent_settled', { timeoutMs: STEP_TIMEOUT_MS })

      // ── 4. 真投递（registry.sendDirect = handleCreate 初始 prompt 同款通路）──
      await registry.sendDirect(childSessionId!, 'Run ls in the current directory, then reply with exactly: U6-DONE')
      ledger.markInjected(PARENT_SID, CLAIM_NID) // create 路径受理回执（调用点 await 同步锚）

      // ── 5. 真 settle 边沿 → 兑现 + respond 素材回执 ──
      await settledPromise
      // agent_settled 晚于 pi finally flush → 扫唯一 jsonl 取真实 transcript 路径
      const jsonlFiles = readdirSync(childDir).filter((f) => f.endsWith('.jsonl'))
      expect(jsonlFiles.length, `childDir 应恰有一个 session jsonl，实际：${jsonlFiles.join(', ')}`).toBe(1)
      const childSessionFile = join(childDir, jsonlFiles[0])
      childView.sessionFilePath = childSessionFile

      const sessionStore = new PiSessionStore()
      applySessionOccupancyTransition(childView, null, 'idle')
      const batch = ledger.settle(childSessionId!, sessionStore.extractSessionOutcome(childSessionFile))
      deliverRespondTargets(ledger, batch.targets, respond, { sessionFilePath: childView.sessionFilePath })

      // ── 6. respond payload 断言（终态形态的「通知内容数据源」验收）──
      expect(batch.settleSeq).toBe(1)
      expect(responds).toHaveLength(1) // 恰一条（notify-once：无债权 settle 零通知的正面镜像）
      expect(responds[0].watchId).toBe('w-claim')
      expect(responds[0].payload).toEqual({
        reason: 'completed', // pi 不写 session_end → null → completed（与单测固化一致）
        sessionId: childSessionId,
        settleSeq: 1,
        fulfillsN: 1,
        sessionFilePath: childSessionFile, // 真实 transcript 指针（D-transcript）
      })
      // lifetime 不被 settle 兑现（A4：仅死亡发声），保持 armed 挂等终局死亡
      expect(ledger.getClaim(PARENT_SID, LIFETIME_NID)?.state).toBe('armed')
      expect(ledger.getClaim(PARENT_SID, CLAIM_NID)).toBeUndefined()
    } finally {
      ledger.dispose()
      await childFx?.dispose().catch(() => {})
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
