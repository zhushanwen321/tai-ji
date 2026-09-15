/**
 * PS-22 / PS-23 探针：pi-coding-agent prompt() 确定性拒绝分支契约（D6 探针层，
 * session-occupancy-send-closure 设计 §3.6 P-2 —— 转译识别字符串锁）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-22「prompt() 首拒绝分支：_compactionAbortController 置位即 throw "Cannot submit a
 *   prompt while compaction is in progress..."」——manual 压缩窗口的 pi 侧拒绝原文，
 *   runtime sendPrompt catch 转译 send.rejected{reason:'compacting'} 的识别依据。
 * - PS-23「prompt() 第二拒绝分支：isStreaming 且无 streamingBehavior 即 throw "Agent is
 *   already processing..."」——isStreaming getter 含 post-run settling，auto 压缩 /
 *   收尾窗口的 pi 侧拒绝原文，转译 reason:'processing' 的识别依据。
 *
 * 断言方式（P-D1 代码形态断言）：静态直读 dist/core/agent-session.js 的 prompt() 方法窗口，
 * 拒绝原文出现次数 + 所属分支位置断言，失真即红。dist 不可达时 skip 不 fail；不进
 * REAL_PI_TESTS 分池。pi 升级后红 = 文案/分支漂移，runtime 转译识别失效退化为普通
 * message.error——先复核锚点，同步 message-dispatcher 的 PI_REJECTION_* 常量与
 * classifyPromptRejection 后再更新 verifiedWith。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-prompt-rejection.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, methodWindow } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!PI_DIST)(
  `PS-22 探针：prompt() manual 压缩拒绝原文（_compactionAbortController 分支${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('原文存在且在 prompt() 内 _compactionAbortController 检查之后（转译 reason:"compacting" 的识别依据）', () => {
      const win = methodWindow(SESSION_SRC, 'async prompt(text, options) {')
      expect(win, 'PS-22 漂移：prompt() 方法消失/改签名——复核 PS-22 锚点 dist/core/agent-session.js').not.toBe('')

      // 原文全文恰出现 1 次（文案漂移即红——runtime classifyPromptRejection 按 includes 识别）
      expect(
        count(SESSION_SRC, 'Cannot submit a prompt while compaction is in progress'),
        'PS-22 漂移：manual 压缩拒绝文案消失/变更——runtime 转译失效退化为 message.error，同步 message-dispatcher PI_REJECTION_COMPACTING 后更新 verifiedWith',
      ).toBe(1)

      // 分支位置：原文紧跟 _compactionAbortController !== undefined 检查（仍在 prompt() 窗口内）
      const checkIdx = win.indexOf('if (this._compactionAbortController !== undefined) {')
      expect(
        checkIdx,
        'PS-22 漂移：_compactionAbortController 前置检查移出 prompt()（manual 压缩改走别的拒绝面？）——复核 PS-22',
      ).toBeGreaterThanOrEqual(0)
      const throwIdx = win.indexOf('"Cannot submit a prompt while compaction is in progress')
      expect(
        throwIdx > checkIdx && throwIdx - checkIdx < 200,
        'PS-22 漂移：拒绝 throw 与 controller 检查不再相邻（检查顺序/分支改形）——复核 PS-22',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-23 探针：prompt() isStreaming 拒绝原文（auto 压缩 / post-run 窗口${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('原文存在且在 prompt() 内 isStreaming 无 streamingBehavior 分支（转译 reason:"processing" 的识别依据）', () => {
      const win = methodWindow(SESSION_SRC, 'async prompt(text, options) {')
      expect(win, 'PS-23 漂移：prompt() 方法消失/改签名——复核 PS-23 锚点').not.toBe('')

      // 原文全文恰出现 1 次（文案漂移即红——runtime classifyPromptRejection 按 includes 识别）
      expect(
        count(SESSION_SRC, 'Agent is already processing'),
        'PS-23 漂移：isStreaming 拒绝文案消失/变更——runtime 转译失效退化为 message.error，同步 message-dispatcher PI_REJECTION_PROCESSING 后更新 verifiedWith',
      ).toBe(1)

      // 分支位置：原文位于 if (this.isStreaming) { if (!options?.streamingBehavior) throw 链内
      const streamingIdx = win.indexOf('if (this.isStreaming) {')
      expect(
        streamingIdx,
        'PS-23 漂移：isStreaming 分流分支移出 prompt()（busy 拒绝面改形？）——复核 PS-23',
      ).toBeGreaterThanOrEqual(0)
      const throwIdx = win.indexOf('"Agent is already processing')
      expect(
        throwIdx > streamingIdx,
        'PS-23 漂移：拒绝 throw 不再位于 isStreaming 分支内（无 streamingBehavior 仍可入队/改由他处拦截？）——复核 PS-23',
      ).toBe(true)
      expect(
        win.slice(streamingIdx, throwIdx).includes('!options?.streamingBehavior'),
        'PS-23 漂移：streamingBehavior 缺省守卫消失（裸 prompt 语义变化，xyz 调用形态恒两参）——复核 PS-23',
      ).toBe(true)
    })
  },
)
