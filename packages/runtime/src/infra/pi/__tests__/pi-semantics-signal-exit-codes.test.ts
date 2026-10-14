/**
 * PS-80 探针：rpc-mode 信号处理器 → 退出码映射（signal-forensics 归因前提）。
 *
 * 登记条目（docs/pi-semantics.json PS-80）：SIGHUP→129、其余信号→143，经
 * shutdown(exitCode, signal) 优雅退出——signal-forensics 把 exit 143 读作「外部
 * SIGTERM」的归因依据（crash-forensics §3.3 D10 延伸面，头注引用本锚点）。
 *
 * 断言方式：静态直读 pi-coding-agent dist/modes/rpc/rpc-mode.js 的信号→shutdown 锚
 * （:283 形态，pi@1.0.0 实装实测）。dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS
 * 分池。pi 升级后红 = 信号处理/退出码映射改形，先复核 PS-80 锚点。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-signal-exit-codes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const CODING_AGENT_DIST = locatePiDist('pi-coding-agent', 'modes/rpc/rpc-mode.js')
const SKIP_REASON = CODING_AGENT_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!CODING_AGENT_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

describe.skipIf(!CODING_AGENT_DIST)(
  `PS-80 探针：信号→退出码映射（静态断言 shutdown 锚${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('信号处理器按 SIGHUP=129 / 其余=143 调 shutdown（exit 143 = 外部 SIGTERM 的归因依据）', () => {
      expect(rpcMode).toContain('shutdown(signal === "SIGHUP" ? 129 : 143, signal)')
    })
  },
)
