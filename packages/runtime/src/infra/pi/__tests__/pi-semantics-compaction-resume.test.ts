/**
 * PS-61 / PS-62 / PS-63 探针：pi manual 压缩掐断语义、compaction reason 词表、
 * extension 命令 args 切分（delivery-ownership-kernel D4② 续跑判定三条件与
 * message-revoke D1 信令投递的 pi 侧承重断言，原挂不入库设计文档与独立实机探针，
 * PS 登记补录后进 pi bump 门禁）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-61「manual 压缩先 abort() 掐当前 run 再压缩（JSDoc 明文 never retries or continues
 *   the interrupted agent turn）；被掐 run 的 agent_end 先于 compaction_start 到达」——
 *   runtime 续跑判定条件①③ 的机制前提。
 * - PS-62「compaction_start/end 的 reason 词表恒三值（manual / threshold / overflow）」——
 *   runtime 续跑判定以 reason === 'manual' 识别掐 turn 压缩的依据。
 * - PS-63「extension 命令 args = 首个空格后的原样余串」——revoke 信令单空格拼接下
 *   entryId 精确投递的依据。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi-agent-core/agent.js + pi-coding-agent/
 * agent-session.js）的锚串与相对序，漂移即红。dist 不可达时 skip 不 fail；不进
 * REAL_PI_TESTS 分池。行为序断言（agent_end 与 compaction_start 的实测到达序、reason
 * 实测值、stopReason='aborted' 判据）由独立实机探针补验：
 * src/__tests__/probes/p-reason-compaction-reason.mjs（真 pi + faux LLM 零 token，
 * pi 升级时与本静态锚两层同跑）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-compaction-resume.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, locatePiDist, methodWindow } from './helpers/pi-semantics-probe.js'

const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON =
  PI_DIST && AGENT_CORE_DIST
    ? ''
    : `node_modules/@earendil-works/{pi-agent-core,pi-coding-agent}/dist 不可达（cwd 上溯 6 级未命中：agent-core=${Boolean(AGENT_CORE_DIST)} coding-agent=${Boolean(PI_DIST)}）`
if (SKIP_REASON) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const AGENT_SRC = AGENT_CORE_DIST ? readFileSync(join(AGENT_CORE_DIST, 'agent.js'), 'utf-8') : ''
const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

const count = (text: string, needle: string): number => text.split(needle).length - 1
const countRe = (text: string, re: RegExp): number => (text.match(re) ?? []).length

describe.skipIf(!PI_DIST || !AGENT_CORE_DIST)(
  `PS-61 探针：manual 压缩掐断语义与事件序（续跑判定条件①③ 承重${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('abort() 只置 activeRun 的 AbortController signal（不清队列、无补投副作用）', () => {
      const win = methodWindow(AGENT_SRC, 'abort() {')
      expect(win, 'PS-61 漂移：pi-agent-core abort() 方法消失/改名——复核 PS-61 锚 dist/agent.js:202-204').not.toBe('')
      expect(
        win.includes('this.activeRun?.abortController.abort();'),
        'PS-61 漂移：abort() 不再是纯 signal 置位（出现队列清理/补投副作用？）——「掐断即停、pi 不自续跑」前提变化，复审 PS-61',
      ).toBe(true)
    })

    it('compact() 第一步 await this.abort() 先于 compaction_start{manual} emit；JSDoc never retries 原文在场', () => {
      const win = methodWindow(SESSION_SRC, 'async compact(customInstructions) {')
      expect(win, 'PS-61 漂移：compact() 方法消失/改签名——复核 PS-61 锚 dist/core/agent-session.js:2132').not.toBe('')

      const abortIdx = win.indexOf('await this.abort();')
      expect(
        abortIdx,
        'PS-61 漂移：compact() 不再先 abort 当前 run（被掐 turn 语义消失？）——续跑判定条件③ 失效，复审 PS-61',
      ).toBeGreaterThanOrEqual(0)
      const startIdx = win.indexOf('this._emit({ type: "compaction_start", reason: "manual" });')
      expect(
        startIdx,
        'PS-61/PS-62 漂移：manual compaction_start emit 改形——复核 PS-62 锚 dist/core/agent-session.js:2135',
      ).toBeGreaterThanOrEqual(0)
      expect(
        abortIdx < startIdx,
        'PS-61 漂移：compaction_start 先于 abort（agent_end 不再保证先于 compaction_start 到达）——续跑判定条件③ 的事件序前提变化，复审 PS-61 并重跑探针 P-reason(c)',
      ).toBe(true)

      expect(
        countRe(SESSION_SRC, /Manual compaction never retries or\s*\n\s*\*\s*continues the interrupted agent turn/),
        'PS-61 漂移：never retries 契约文案消失/变更——pi 对被掐 turn 的「不续跑」承诺变化，runtime 续跑投递须复审是否变重复起 run',
      ).toBe(1)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-62 探针：compaction reason 词表恒三值（manual / threshold / overflow${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('manual 路径 start/end 恒字面量 manual（end 成功/aborted 两处）', () => {
      expect(
        count(SESSION_SRC, 'this._emit({ type: "compaction_start", reason: "manual" });'),
        'PS-62 漂移：manual compaction_start 字面量 emit 消失/改形/复制——复核 PS-62 锚 dist/core/agent-session.js:2135',
      ).toBe(1)
      expect(
        countRe(SESSION_SRC, /type: "compaction_end",\s*\n\s*reason: "manual",/g),
        'PS-62 漂移：manual compaction_end 不再是成功/aborted 两处 reason:"manual"——runtime 续跑判定的 reason==="manual" 词表面变化，复审 PS-62',
      ).toBe(2)
    })

    it('auto 路径 reason 经 _runAutoCompaction 变量透传，词表仅 threshold/overflow 两值', () => {
      expect(
        SESSION_SRC.includes('async _runAutoCompaction(reason, willRetry)'),
        'PS-62 漂移：_runAutoCompaction 签名/参数改形——reason 透传链断锚，复核 PS-62 锚 dist/core/agent-session.js:2423',
      ).toBe(true)
      expect(
        count(SESSION_SRC, 'this._emit({ type: "compaction_start", reason });'),
        'PS-62 漂移：auto compaction_start 不再透传 reason 变量——词表锚改形，复核 PS-62 锚 :1747',
      ).toBe(1)
      expect(
        count(SESSION_SRC, 'this._emit({ type: "compaction_end", reason,'),
        'PS-62 漂移：auto compaction_end 不再透传 reason 变量——词表锚改形，复核 PS-62 锚 :1844',
      ).toBe(1)
      // pi 1.0.0 第三处：_checkCompaction post-run 复查段超限即 threshold 压缩
      expect(
        count(SESSION_SRC, '_runAutoCompaction("threshold"'),
        'PS-62 漂移：threshold 调用点数量变化（预期 3：_compactBeforeNextAssistantResponse / prepareRequest 重试 / _checkCompaction post-run 复查）——auto 词表构成变化，复审 PS-62',
      ).toBe(3)
      expect(
        count(SESSION_SRC, '_runAutoCompaction("overflow"'),
        'PS-62 漂移：overflow 调用点数量变化（预期 2）——auto 词表构成变化，复审 PS-62',
      ).toBe(2)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-63 探针：extension 命令 args = 首个空格后的原样余串（revoke entryId 投递承重${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('_tryExecuteExtensionCommand 以首个空格切分且 args 为原样余串（无 trim/引号解析）', () => {
      const win = methodWindow(SESSION_SRC, 'async _tryExecuteExtensionCommand(text) {')
      expect(win, 'PS-63 漂移：_tryExecuteExtensionCommand 消失/改签名——复核 PS-63 锚 dist/core/agent-session.js:1600-1602').not.toBe('')

      const splitIdx = win.indexOf('const spaceIndex = text.indexOf(" ");')
      expect(
        splitIdx,
        'PS-63 漂移：首空格切分（indexOf(" ")）消失/改形——agent-ext __taiji_nav__ 的 entryId 投递前提变化，复审 PS-63',
      ).toBeGreaterThanOrEqual(0)
      const argsIdx = win.indexOf('text.slice(spaceIndex + 1)')
      expect(
        argsIdx,
        'PS-63 漂移：args 不再是首空格后的原样余串（trim/引号解析/二次切分？）——单空格拼接的 entryId 失真即 nav mismatch，复审 PS-63',
      ).toBeGreaterThanOrEqual(0)
      expect(
        win.indexOf('text.slice(1, spaceIndex)'),
        'PS-63 漂移：commandName 切分形态变化——命令名/args 切分整体改形，复审 PS-63',
      ).toBeGreaterThanOrEqual(0)
      expect(splitIdx < argsIdx, 'PS-63 漂移：切分行相对序变化——复核 PS-63').toBe(true)
      expect(
        win.includes('.trim()'),
        'PS-63 漂移：args 切分段出现 trim——余串不再是原样（首尾空格被剥），单空格形态等价性破坏，复审 PS-63',
      ).toBe(false)
    })
  },
)
