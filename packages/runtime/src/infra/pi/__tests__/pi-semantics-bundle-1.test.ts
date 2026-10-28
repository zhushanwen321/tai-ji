import { PI_REJECTION_COMPACTING, PI_REJECTION_PROCESSING } from '../pi-rejection.js';
import { locatePiCodingAgentDist, locatePiDist, methodWindow, methodWindowUntil } from './helpers/pi-semantics-probe.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-agent-session.test.ts
// ======================================================================

const PI_DIST = locatePiCodingAgentDist()

const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''


const count = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-agent-session', () => {
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST)(
  `PS-04 探针：setThinkingLevel 条件落盘/发声（isChanging 门控${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('isChanging = effective !== previousLevel；appendThinkingLevelChange 与 thinking_level_changed 均在 if (isChanging) 块内', () => {
      // pi 1.0.0：签名第二参 options（ModelMutationOptions.persist）保留——会话内切档默认
      // 不再写全局默认。taiji 单参调用（rpc-mode.js:389
      // session.setThinkingLevel(command.level)）不触发 settings 写入，与 model-service
      // 「per-session runtime state — no persistence needed」设计一致；全局默认由
      // pi-provider-store 独立通路读写。条件落盘/发声（claim 本体）逐行未变。
      const win = methodWindow(SESSION_SRC, 'setThinkingLevel(level, options = {}) {')
      expect(win, 'PS-04 漂移：setThinkingLevel 方法消失/改签名——复核 PS-04 锚点 dist/core/agent-session.js').not.toBe('')
      const isChangingIdx = win.indexOf('const isChanging = effectiveLevel !== previousLevel')
      expect(
        isChangingIdx,
        'PS-04 漂移：isChanging 判定形态消失（同值是否仍跳过落盘？）——复核 PS-04（D9 删轮询的依据）',
      ).toBeGreaterThanOrEqual(0)
      expect(
        win.includes('if (options.persist) {'),
        'PS-04 漂移：options.persist 门控消失（全局默认写入恢复无条件/自动触发？taiji 单参调用将重新污染全局默认）——复核 PS-04',
      ).toBe(true)
      const ifIdx = win.indexOf('if (isChanging) {')
      expect(ifIdx, 'PS-04 漂移：if (isChanging) 块消失——复核 PS-04').toBeGreaterThanOrEqual(0)
      const block = win.slice(ifIdx, ifIdx + 900)
      expect(
        block.includes('appendThinkingLevelChange') && block.includes('thinking_level_changed'),
        'PS-04 漂移：落盘/发声移出 isChanging 块（同值也会发声？）或事件类型改名——复核 PS-04',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST)(
  `PS-06 探针：_pendingNextTurnMessages 唯一 drain 点（注入即清空${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('全文恰好 1 个 push 点 + 1 个清空点 + 1 个注入消费点，且消费点与清空点相邻（_runAgentPrompt 注入段）', () => {
      expect(
        count(SESSION_SRC, 'this._pendingNextTurnMessages.push('),
        'PS-06 漂移：nextTurn 入队点数量 ≠ 1——入队面变化，复核 PS-06 锚点',
      ).toBe(1)
      expect(
        count(SESSION_SRC, 'this._pendingNextTurnMessages = []'),
        'PS-06 漂移：nextTurn 清空点数量 ≠ 1——出现了额外 drain（pi 自身开始消费？）或消费点消失，复核 PS-06',
      ).toBe(1)
      const injectIdx = SESSION_SRC.indexOf('for (const msg of this._pendingNextTurnMessages)')
      expect(
        injectIdx,
        'PS-06 漂移：注入消费形态消失——drain 改形，复核 PS-06',
      ).toBeGreaterThanOrEqual(0)
      const clearIdx = SESSION_SRC.indexOf('this._pendingNextTurnMessages = []')
      expect(
        clearIdx - injectIdx > 0 && clearIdx - injectIdx < 300,
        'PS-06 漂移：注入与清空不再相邻（消费-清空原子性破坏？）——复核 PS-06',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST)(
  `PS-07 探针：_emitAgentSettled 先复位 busy 标志再发事件（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('方法体首条语句 = _isAgentRunActive = false，先于 agent_settled 事件发射', () => {
      const win = methodWindow(SESSION_SRC, '_emitAgentSettled() {')
      expect(win, 'PS-07 漂移：_emitAgentSettled 方法消失——settled 边沿语义改形，复核 PS-07 锚点').not.toBe('')
      const resetIdx = win.indexOf('this._isAgentRunActive = false')
      const emitIdx = win.indexOf('type: "agent_settled"')
      expect(resetIdx, 'PS-07 漂移：settled 内 busy 复位语句消失——复核 PS-07').toBeGreaterThanOrEqual(0)
      expect(emitIdx, 'PS-07 漂移：agent_settled 事件类型改名——复核 PS-07').toBeGreaterThanOrEqual(0)
      expect(
        resetIdx < emitIdx,
        'PS-07 漂移：busy 复位晚于事件发射——边沿回调内 isIdle 不再恒真，settled 驱动的通知通道时序假设失效，复核 PS-07',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST)(
  `PS-08 探针：sendCustomMessage 四分支 + triggerTurn 直达（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('分支齐全：nextTurn 入队 / isStreaming 分流 / triggerTurn 直达 / isStreaming+triggerTurn:false 延迟落盘 / 其余仅 append', () => {
      // pi 0.84.4：原 else 内联 append 抽成 _appendCustomMessage（push + appendCustomMessageEntry
      // 落盘 + message_start/end 双发，逐行等价），并新增第五分支 defer：isStreaming &&
      // triggerTurn===false 时延迟到 turn 末尾落盘（修 replay 顺序 bug：立即 append 会插进
      // tool call 与 result 之间）。taiji 全侧调用形态 = {triggerTurn:true}（D5 单通道）/
      // {deliverAs:"nextTurn"} / 非流式不传 options——defer 场景 taiji 不可达，claim 四条
      // taiji 消费路径行为不变。
      const win = methodWindow(SESSION_SRC, 'async sendCustomMessage(message, options) {')
      expect(win, 'PS-08 漂移：sendCustomMessage 方法消失/改签名——复核 PS-08 锚点').not.toBe('')
      expect(win.includes('options?.deliverAs === "nextTurn"'), 'PS-08 漂移：nextTurn 分支消失——复核 PS-08').toBe(true)
      expect(
        win.includes('this.isStreaming && options?.triggerTurn !== false'),
        'PS-08 漂移：isStreaming 分流分支（steer|followUp）条件消失——复核 PS-08',
      ).toBe(true)
      const triggerIdx = win.indexOf('else if (options?.triggerTurn)')
      expect(triggerIdx, 'PS-08 漂移：triggerTurn 分支消失——直达起轮路径改形，复核 PS-08').toBeGreaterThanOrEqual(0)
      // 直达语句锚 = 行首语句位的 await（m 模式 ^\s+await …;）。窗口内另有 deferred
      // 形态 this._deferredSettledActions.push(async () => await this._runAgentPrompt(...))
      // ——它的行首是 push 调用非 await 语句，本锚不会命中；旧写法（slice 窗口裸 includes）
      // 命中的恰是 deferred 行，pi 删直达只留延迟时仍绿（审查 2026-10-03 修正）
      expect(
        new RegExp(/^ +await this\._runAgentPrompt\(appMessage\);/m).test(win.slice(triggerIdx)),
        'PS-08 漂移：triggerTurn 不再走 _runAgentPrompt 直达（行首语句位）——投递语义变化，复核 PS-08（事故 A 基线 session 唯一成功样本路径）',
      ).toBe(true)
      expect(
        win.includes('else if (this.isStreaming)'),
        'PS-08 漂移：defer 分支（isStreaming+triggerTurn:false 延迟落盘，0.84.4 新增）消失——复核 PS-08',
      ).toBe(true)
      expect(
        win.includes('this._appendCustomMessage(appMessage)'),
        'PS-08 漂移：无 trigger 分支不再走 _appendCustomMessage append——复核 PS-08 与 PS-09',
      ).toBe(true)
      // 落盘/双发下沉在 _appendCustomMessage（0.84.4 从 else 内联抽出）：持久化与双发形态不得再漂
      const appendWin = methodWindow(SESSION_SRC, '_appendCustomMessage(appMessage) {')
      expect(appendWin, 'PS-08 漂移：_appendCustomMessage 方法消失——复核 PS-08').not.toBe('')
      expect(
        appendWin.includes('appendCustomMessageEntry'),
        'PS-08 漂移：custom_message 持久化移出 _appendCustomMessage——复核 PS-08 与 PS-09',
      ).toBe(true)
      expect(
        appendWin.includes('"message_start"') && appendWin.includes('"message_end"'),
        'PS-08 漂移：custom 消息 message_start/end 双发形态变化——core 去双计（effects/registry.ts custom role 跳过）依赖该行为——复核 PS-08',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-compaction-details.test.ts
// ======================================================================

const PI_DIST_m2_m2_m2_m2_m2_m2 = locatePiCodingAgentDist()

const SKIP_REASON_m2_m2_m2_m2_m2_m2 = PI_DIST_m2_m2_m2_m2_m2_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


// dist 不可达时 skip（describe.skipIf 命中时 vitest 仍执行工厂体——读取必须在模块级
// 三元检查内完成，不能放 describe 体，否则收集期抛错而非 skip）
const SESSION_MANAGER_SRC = PI_DIST_m2_m2_m2_m2_m2_m2 ? readFileSync(join(PI_DIST_m2_m2_m2_m2_m2_m2, 'core', 'session-manager.js'), 'utf-8') : ''

const AGENT_SESSION_SRC = PI_DIST_m2_m2_m2_m2_m2_m2 ? readFileSync(join(PI_DIST_m2_m2_m2_m2_m2_m2, 'core', 'agent-session.js'), 'utf-8') : ''


/** 行为级断言用：动态 import session-manager.js（取 SessionManager 类做原型桩）。 */
type SessionManagerModule = {
  SessionManager?: { prototype: object }
}

const sessionManager: SessionManagerModule | null = await (async () => {
  if (!PI_DIST_m2_m2_m2_m2_m2_m2) return null
  try {
    return (await import(pathToFileURL(join(PI_DIST_m2_m2_m2_m2_m2_m2, 'core', 'session-manager.js')).href)) as SessionManagerModule
  } catch {
    return null
  }
})()

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-compaction-details', () => {
if (!PI_DIST_m2_m2_m2_m2_m2_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_m2_m2_m2_m2_m2)(
  `PS-28 探针：appendCompaction details 透传链静态断言（代码形态${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_m2_m2}` : ''}）`,
  () => {
    const sessionManagerSrc = SESSION_MANAGER_SRC
    const agentSessionSrc = AGENT_SESSION_SRC

    it('appendCompaction：entry 字面量 details 字段逐字引用入参（无克隆/无白名单）', () => {
      const win = methodWindowUntil(
        sessionManagerSrc,
        'appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage)',
        'appendCustomEntry(',
      )
      expect(
        win,
        'PS-28 漂移：appendCompaction 方法消失/改名——compaction 落盘入口改形，复核 PS-28 锚点',
      ).not.toBe('')
      // entry 字面量：details 入参逐字透传（pi 1.0.0 形态：id/timestamp 收简写、
      // firstKeptEntryId 新增 ?? id 自指兜底、新增可选 systemMessage 快照展开；
      // details/usage/fromHook 六字段序透传语义不变）
      expect(
        win,
        'PS-28 漂移：entry 字面量不再逐字引用 details 入参（字段被克隆/裁剪/改名）——extension 写入 details 的自定义字段将静默丢失，复核 session-manager.js appendCompaction 与 PS-28',
      ).toMatch(/\{\s*type: "compaction",\s*id,\s*parentId: this\.leafId,\s*timestamp,\s*summary,\s*firstKeptEntryId: firstKeptEntryId \?\? id,\s*tokensBefore,\s*details,\s*usage,\s*fromHook,/)
      // 防未来克隆化：details 不得出现展开/克隆形态（PS-28 本体负断言）
      expect(
        win.includes('...details') || win.includes('structuredClone(details)'),
        'PS-28 漂移：appendCompaction 出现 details 克隆/展开形态——逐字透传语义被破坏，extension 自定义字段将静默丢失',
      ).toBe(false)
      // 落盘仍走 _appendEntry（append-only 追加，与 PS-18 一致）
      expect(
        win.includes('this._appendEntry(entry);'),
        'PS-28 漂移：appendCompaction 不再经 _appendEntry 落盘——落盘管线改形，复核 PS-28 与 PS-18',
      ).toBe(true)
    })

    it('agent-session：hook 分支 details 原样引用 ×2，调用点与 appendCompaction 形参名一致 ×2', () => {
      // 两条压缩路径（manual/threshold auto）都从 hook result.compaction 取 details 原样引用
      const hookAssign = agentSessionSrc.match(/details = extensionCompaction\.details;/g) ?? []
      expect(
        hookAssign,
        'PS-28 漂移：hook 分支 details 引用点数量变化（≠2）——压缩路径改形，复核 agent-session.js 与 PS-28 锚点',
      ).toHaveLength(2)
      // 调用点：details 变量未经中间变换直接传入（标识符连续，两路径调用形态一致）
      const callRe = /this\.sessionManager\.appendCompaction\(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage\);/g
      const calls = agentSessionSrc.match(callRe) ?? []
      expect(
        calls,
        'PS-28 漂移：appendCompaction 调用点不再原样传 details（形参改形/加了变换）——details 落盘语义变化，复核 agent-session.js 两个调用点',
      ).toHaveLength(2)
    })
  },
)
describe.skipIf(!sessionManager?.SessionManager)(
  'PS-28 探针：appendCompaction 行为断言（动态 import 实装 dist，原型桩零 fs 写）',
  () => {
    /** 原型桩宿主形状（只暴露 appendCompaction 依赖的成员；_appendEntry 被覆写为捕获器）。
     * pi 1.0.0 起 appendCompaction 前置调 buildSessionProjection()（读 fileEntries + byId 提取
     * systemMessage 快照），桩需提供空 fileEntries 与空 Map 型 byId（空派生视图 → 无 systemMessage 展开）。 */
    type AppendCompactionHost = {
      byId: Map<string, unknown>
      leafId: string
      fileEntries: Array<unknown>
      _appendEntry: (entry: Record<string, unknown>) => void
      appendCompaction: (
        summary: string,
        firstKeptEntryId: string,
        tokensBefore: number,
        details: unknown,
        fromHook: boolean,
        usage: unknown,
      ) => string
    }

    function makeHost(): { host: AppendCompactionHost; captured: Array<Record<string, unknown>> } {
      // Cls 提取在 it 体执行时进行（skip 态不走到这里）——describe 体级非空断言会在
      // 收集期对 null 崩溃，破坏「dist 不可达时 skip 不 fail」契约
      const Cls = sessionManager!.SessionManager!
      const host = Object.create(Cls.prototype) as AppendCompactionHost
      host.byId = new Map()
      host.leafId = 'leaf-0'
      host.fileEntries = []
      const captured: Array<Record<string, unknown>> = []
      // 覆写落盘钩子：捕获 entry 即返回，不触 fileEntries/_persist（零 fs 写）
      host._appendEntry = (entry) => {
        captured.push(entry)
      }
      return { host, captured }
    }

    it('hook 返回的 details（含自定义 model 字段）同引用落盘——逐字透传非克隆', () => {
      const { host, captured } = makeHost()
      const details = {
        engine: 'smart-context',
        mode: 'cross-model',
        model: 'zai-coding-cn/glm-5.3-flash',
        readFiles: ['/a.ts'],
      }
      const usage = { input: 1, output: 2 }
      host.appendCompaction('summary text', 'kept-1', 1234, details, true, usage)

      expect(captured).toHaveLength(1)
      const entry = captured[0]
      expect(entry.type).toBe('compaction')
      // 同一引用 = 逐字透传（克隆/重建对象会 here 红）
      expect(entry.details).toBe(details)
      const gotDetails = entry.details as Record<string, unknown>
      expect(gotDetails.model).toBe('zai-coding-cn/glm-5.3-flash')
      expect(gotDetails.readFiles).toEqual(['/a.ts'])
      // 其余透传字段同verbatim：usage / fromHook / 树形结构
      expect(entry.usage).toBe(usage)
      expect(entry.fromHook).toBe(true)
      expect(entry.parentId).toBe('leaf-0')
      expect(typeof entry.id).toBe('string')
      expect((entry.id as string).length).toBeGreaterThan(0)
      expect(typeof entry.timestamp).toBe('string')
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-compaction-resume.test.ts
// ======================================================================

const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')

const PI_DIST_m2_m2_m2_m2_m2_m2_d1 = locatePiCodingAgentDist()

const SKIP_REASON_m2_m2_m2_m2_m2_m2_d1 =
  PI_DIST_m2_m2_m2_m2_m2_m2_d1 && AGENT_CORE_DIST
    ? ''
    : `node_modules/@earendil-works/{pi-agent-core,pi-coding-agent}/dist 不可达（cwd 上溯 6 级未命中：agent-core=${Boolean(AGENT_CORE_DIST)} coding-agent=${Boolean(PI_DIST)}）`


const AGENT_SRC = AGENT_CORE_DIST ? readFileSync(join(AGENT_CORE_DIST, 'agent.js'), 'utf-8') : ''

const SESSION_SRC_m2_m2_m2_m2 = PI_DIST_m2_m2_m2_m2_m2_m2_d1 ? readFileSync(join(PI_DIST_m2_m2_m2_m2_m2_m2_d1, 'core', 'agent-session.js'), 'utf-8') : ''


const count_m2_m2_m2_m2 = (text: string, needle: string): number => text.split(needle).length - 1

const countRe = (text: string, re: RegExp): number => (text.match(re) ?? []).length

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-compaction-resume', () => {
if (SKIP_REASON_m2_m2_m2_m2_m2_m2_d1) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_m2_m2_m2_m2_m2_d1 || !AGENT_CORE_DIST)(
  `PS-61 探针：manual 压缩掐断语义与事件序（续跑判定条件①③ 承重${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_m2_m2_d1}` : ''}）`,
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
      const win = methodWindow(SESSION_SRC_m2_m2_m2_m2, 'async compact(customInstructions) {')
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
        countRe(SESSION_SRC_m2_m2_m2_m2, /Manual compaction never retries or\s*\n\s*\*\s*continues the interrupted agent turn/),
        'PS-61 漂移：never retries 契约文案消失/变更——pi 对被掐 turn 的「不续跑」承诺变化，runtime 续跑投递须复审是否变重复起 run',
      ).toBe(1)
    })
  },
)
describe.skipIf(!PI_DIST_m2_m2_m2_m2_m2_m2_d1)(
  `PS-62 探针：compaction reason 词表恒三值（manual / threshold / overflow${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_m2_m2_d1}` : ''}）`,
  () => {
    it('manual 路径 start/end 恒字面量 manual（end 成功/aborted 两处）', () => {
      expect(
        count_m2_m2_m2_m2(SESSION_SRC_m2_m2_m2_m2, 'this._emit({ type: "compaction_start", reason: "manual" });'),
        'PS-62 漂移：manual compaction_start 字面量 emit 消失/改形/复制——复核 PS-62 锚 dist/core/agent-session.js:2135',
      ).toBe(1)
      expect(
        countRe(SESSION_SRC_m2_m2_m2_m2, /type: "compaction_end",\s*\n\s*reason: "manual",/g),
        'PS-62 漂移：manual compaction_end 不再是成功/aborted 两处 reason:"manual"——runtime 续跑判定的 reason==="manual" 词表面变化，复审 PS-62',
      ).toBe(2)
    })

    it('auto 路径 reason 经 _runAutoCompaction 变量透传，词表仅 threshold/overflow 两值', () => {
      expect(
        SESSION_SRC_m2_m2_m2_m2.includes('async _runAutoCompaction(reason, willRetry)'),
        'PS-62 漂移：_runAutoCompaction 签名/参数改形——reason 透传链断锚，复核 PS-62 锚 dist/core/agent-session.js:2423',
      ).toBe(true)
      expect(
        count_m2_m2_m2_m2(SESSION_SRC_m2_m2_m2_m2, 'this._emit({ type: "compaction_start", reason });'),
        'PS-62 漂移：auto compaction_start 不再透传 reason 变量——词表锚改形，复核 PS-62 锚 :1747',
      ).toBe(1)
      expect(
        count_m2_m2_m2_m2(SESSION_SRC_m2_m2_m2_m2, 'this._emit({ type: "compaction_end", reason,'),
        'PS-62 漂移：auto compaction_end 不再透传 reason 变量——词表锚改形，复核 PS-62 锚 :1844',
      ).toBe(1)
      // pi 1.0.0 第三处：_checkCompaction post-run 复查段超限即 threshold 压缩
      expect(
        count_m2_m2_m2_m2(SESSION_SRC_m2_m2_m2_m2, '_runAutoCompaction("threshold"'),
        'PS-62 漂移：threshold 调用点数量变化（预期 3：_compactBeforeNextAssistantResponse / prepareRequest 重试 / _checkCompaction post-run 复查）——auto 词表构成变化，复审 PS-62',
      ).toBe(3)
      expect(
        count_m2_m2_m2_m2(SESSION_SRC_m2_m2_m2_m2, '_runAutoCompaction("overflow"'),
        'PS-62 漂移：overflow 调用点数量变化（预期 2）——auto 词表构成变化，复审 PS-62',
      ).toBe(2)
    })
  },
)
describe.skipIf(!PI_DIST_m2_m2_m2_m2_m2_m2_d1)(
  `PS-63 探针：extension 命令 args = 首个空格后的原样余串（revoke entryId 投递承重${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_m2_m2_d1}` : ''}）`,
  () => {
    it('_tryExecuteExtensionCommand 以首个空格切分且 args 为原样余串（无 trim/引号解析）', () => {
      const win = methodWindow(SESSION_SRC_m2_m2_m2_m2, 'async _tryExecuteExtensionCommand(text) {')
      expect(win, 'PS-63 漂移：_tryExecuteExtensionCommand 消失/改签名——复核 PS-63 锚 dist/core/agent-session.js:1600-1602').not.toBe('')

      const splitIdx = win.indexOf('const spaceIndex = text.indexOf(" ");')
      expect(
        splitIdx,
        'PS-63 漂移：首空格切分（indexOf(" ")）消失/改形——host-internals __taiji_nav__ 的 entryId 投递前提变化，复审 PS-63',
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
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-defer-marker-survival.test.ts
// ======================================================================

/** 定位仓库根（含 docs/pi-semantics.json 的目录，cwd 逐级上溯）。 */
function locateRepoRoot(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'docs', 'pi-semantics.json'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}


const CODING_AGENT_DIST = locatePiDist('pi-coding-agent', 'config.js')

const AGENT_CORE_DIST_m2 = locatePiDist('pi-agent-core', 'agent.js')

const REPO_ROOT = locateRepoRoot()

const SKIP_REASON_m2_m2_m2_m2 = CODING_AGENT_DIST && AGENT_CORE_DIST_m2 && REPO_ROOT
  ? ''
  : 'node_modules/@earendil-works/{pi-coding-agent,pi-agent-core}/dist 或仓库根不可达（cwd 上溯 6 级未命中）'


// dist 不可达时 skip（describe.skipIf 命中时 vitest 仍执行工厂体——读取必须在模块级
// 三元检查内完成，不能放 describe 体，否则收集期抛错而非 skip）
const AGENT_SESSION_SRC_m2 = CODING_AGENT_DIST ? readFileSync(join(CODING_AGENT_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

const AGENT_CORE_SRC = AGENT_CORE_DIST_m2 ? readFileSync(join(AGENT_CORE_DIST_m2, 'agent.js'), 'utf-8') : ''

const AGENT_LOOP_SRC = AGENT_CORE_DIST_m2 ? readFileSync(join(AGENT_CORE_DIST_m2, 'agent-loop.js'), 'utf-8') : ''

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-defer-marker-survival', () => {
if (SKIP_REASON_m2_m2_m2_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(SKIP_REASON_m2_m2_m2_m2 !== '')(
  `PS-26 探针：transform 面唯一性与裸标记两通路存活（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2}` : ''}）`,
  () => {
    const agentSession = AGENT_SESSION_SRC_m2
    const agentCore = AGENT_CORE_SRC
    const agentLoop = AGENT_LOOP_SRC

    it('pi-coding-agent prompt()：input hook 是全文唯一 transform 询问点（hasHandlers("input")/emitInput 各仅 1 处）', () => {
      // 唯一性 = steer/followUp/_queueSteer/_queueFollowUp 无 input hook 的结构性依据：
      // transform 询问点不在任何 steer 侧函数中出现（steer 通路无改写侧的静态证明）
      expect(agentSession.match(/hasHandlers\("input"\)/g), 'hasHandlers("input") 出现 >1 处——transform 询问面扩大，复核 PS-26 锚点').toHaveLength(1)
      expect(agentSession.match(/\.emitInput\(/g), '.emitInput( 出现 >1 处——input 事件发射侧扩大，复核 PS-26 锚点').toHaveLength(1)
    })

    it('pi-coding-agent prompt()：文本替换仅由 hook transform 结果驱动（非 transform 不改文本）', () => {
      // pi 1.0.0：hook 拦截段从 prompt() 内联抽为独立方法 _runInputHandlers（检查反转为早退，
      // handled → undefined 终止），transform 条件分支语义不变
      const hook = /async _runInputHandlers\(text, images, source, streamingBehavior\) \{\s*\n\s*if \(!this\._extensionRunner\.hasHandlers\("input"\)\) \{\s*\n\s*return \{ text, images \};\s*\n\s*\}\s*\n\s*const inputResult = await this\._extensionRunner\.emitInput\(/
        .exec(agentSession)
      expect(hook, 'PS-26 漂移：prompt() 的 input hook 拦截段（_runInputHandlers）形态改变——复核 agent-session.js').not.toBeNull()
      expect(
        agentSession.includes('if (inputResult.action === "transform") {'),
        'PS-26 漂移：prompt() 不再按 inputResult.action === "transform" 条件替换文本——hook 语义变化，复核 PS-26',
      ).toBe(true)
    })

    it('pi-coding-agent _queueSteer：原文本构造消息对象（无标记剥离），经 agent.steer 入队', () => {
      // _queueSteer 消息 content 直接由入参 text 构造——steer 通路文本从入队起原样
      expect(
        agentSession.includes('const content = [{ type: "text", text }];'),
        'PS-26 漂移：_queueSteer 不再以入参 text 原样构造 content——steer 通路出现改写点，复核 agent-session.js',
      ).toBe(true)
      expect(
        agentSession.includes('this.agent.steer({'),
        'PS-26 漂移：_queueSteer 不再经 this.agent.steer 入队——steering 链变化，复核 agent-session.js',
      ).toBe(true)
    })

    it('pi-coding-agent _handleAgentEvent：message_end 的 event.message 原样落盘（事件与持久化同源）', () => {
      expect(
        agentSession.includes('this.sessionManager.appendMessage(event.message);'),
        'PS-26 漂移：message_end 落盘不再原样 appendMessage(event.message)——落盘文本可能与事件分流，复核 agent-session.js _handleAgentEvent',
      ).toBe(true)
    })

    it('pi-agent-core runAgentLoop：初始 prompt 消息原样 emit message_start/message_end（send 通路落盘/回流来源）', () => {
      // pi 1.0.0：prompts 先经 declareToolChanges（工具装载有增量时插入 system 消息，无增量原样直通
      // ——user prompt 文本零改写），循环变量改名 prompt → message
      const init = /const initialMessages = declareToolChanges\(context, prompts\);[\s\S]*?for \(const message of initialMessages\) \{\s*\n\s*await emit\(\{ type: "message_start", message \}\);\s*\n\s*await emit\(\{ type: "message_end", message \}\);\s*\n\s*\}/
        .exec(agentLoop)
      expect(init, 'PS-26 漂移：runAgentLoop 初始 prompt 不再原样 emit message_start/message_end——send 通路 user 消息事件/落盘来源变化，复核 agent-loop.js').not.toBeNull()
    })

    it('pi-agent-core runLoop：steering drain 后的消息直接 emit + push 上下文（steer 通路零 transform 注入）', () => {
      // pi 1.0.0：循环头 = declareToolChanges 包裹（prepared + pending 合并注入；steering 消息
      // 无工具增量时原样直通），注入块 emit + push 四行同现不变
      const inject = /for \(const message of declareToolChanges\(currentContext, \[\.\.\.preparedMessages, \.\.\.pendingMessages\]\)\) \{\s*\n\s*await emit\(\{ type: "message_start", message \}\);\s*\n\s*await emit\(\{ type: "message_end", message \}\);\s*\n\s*currentContext\.messages\.push\(message\);\s*\n\s*newMessages\.push\(message\);/
        .exec(agentLoop)
      expect(inject, 'PS-26 漂移：steering 消息注入块不再「原样 emit + 直接 push 上下文」——steer 通路出现改写点，复核 agent-loop.js runLoop').not.toBeNull()
    })

    it('pi-agent-core agent.js：getSteeringMessages = steeringQueue.drain() 原样返回（队列到注入点间无变换）', () => {
      expect(
        agentCore.includes('steeringQueue.enqueue(message);'),
        'PS-26 漂移：agent.steer 不再直接 enqueue 消息——入队面出现改写，复核 agent.js',
      ).toBe(true)
      const drain = /getSteeringMessages: async \(\) => \{[\s\S]*?return this\.steeringQueue\.drain\(\);/.exec(agentCore)
      expect(drain, 'PS-26 漂移：getSteeringMessages 不再原样返回 steeringQueue.drain()——drain 面出现变换，复核 agent.js createLoopConfig').not.toBeNull()
    })

    it('taiji 两侧标记正则互斥（行为验证）：裸 uuid 不被 msg-id-mapper TAG_MATCH 命中，u- 标记不被 DEFER_FLUSH_MARKER_RE 命中', () => {
      // [MF-1-11 → msg-pipeline-debloat D5-1] uuid 段 SSOT = shared message.ts 的
      // MSG_ID_UUID_SEGMENT 单处字面量，三形态正则（MSG_ID_TAG_RE / MSG_ID_TAG_BARE_RE /
      // BARE_UUID_RE）全部由其构造；core/runtime 派生器已删（直接 import shared 常量）。
      // 探针保持源码直读（不 import 生产模块，独立性不变）：提取 segment 重建裸形态正则，
      // 行为断言与生产消费方（DEFER_FLUSH_MARKER_RE / DEFER_MARKER_RE）等价。
      const sharedSrc = readFileSync(join(REPO_ROOT as string, 'packages', 'shared', 'src', 'message.ts'), 'utf-8')
      const coreSrc = readFileSync(join(REPO_ROOT as string, 'packages', 'core', 'src', 'domain', 'chat', 'apply-entry-convert.ts'), 'utf-8')
      const rtSrc = readFileSync(join(REPO_ROOT as string, 'packages', 'runtime', 'src', 'infra', 'pi', 'entry-tree-builder.ts'), 'utf-8')
      const extSrc = readFileSync(join(REPO_ROOT as string, 'extensions', 'taiji', 'host-internals', 'src', 'msg-id-mapper.ts'), 'utf-8')
      const segmentDef = /const MSG_ID_UUID_SEGMENT = '(.+?)'/.exec(sharedSrc)
      const tagMatchDef = /const TAG_MATCH = \/(.+?)\/([a-z]*)\r?\n/.exec(extSrc)
      expect(segmentDef, 'shared MSG_ID_UUID_SEGMENT 字面量提取失败——复核 packages/shared/src/message.ts').not.toBeNull()
      expect(tagMatchDef, 'extension TAG_MATCH 字面量提取失败——复核 host-internals/src/msg-id-mapper.ts').not.toBeNull()
      // [MF-1-11] uuid 模式段手写体全仓单处：shared message.ts 只允许 MSG_ID_UUID_SEGMENT
      // 一处（出现 2 次 = 三形态外又冒出手写体新问题点）；core/runtime 零残留（残留 =
      // 派生器回退或新问题点）
      expect(sharedSrc.match(/\[0-9a-f\]\{8\}/g)?.length, 'shared message.ts uuid 模式段手写体超出 MSG_ID_UUID_SEGMENT 单点').toBe(1)
      expect(/\[0-9a-f\]\{8\}/.test(coreSrc), 'core apply-entry-convert 残留手写 uuid 模式段——D5-1 SSOT 回退').toBe(false)
      expect(/\[0-9a-f\]\{8\}/.test(rtSrc), 'runtime entry-tree-builder 残留手写 uuid 模式段——D5-1 SSOT 回退').toBe(false)
      const deferRe = new RegExp(`<!--taiji:msg:(${segmentDef![1]})-->`, 'i')
      const tagMatchRe = new RegExp(tagMatchDef![1], tagMatchDef![2])
      // TAG_STRIP（msg-id-mapper 的剥离正则）必须仍是 u- 前缀形态（input hook 只剥 u- 标记的依据）
      expect(
        /const TAG_STRIP = \/<!--taiji:msg:u-\[0-9a-fA-F-\]\{36\}-->\/g/.test(extSrc),
        'PS-26 关联漂移：msg-id-mapper TAG_STRIP 不再是 u- 前缀专属形态——若扩为同剥裸标记，core ①a 提取自回流原文的可达性断链，须先探针论证再改',
      ).toBe(true)

      const bareUuid = '3f2a1b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c'
      const bareText = `queue text\n<!--taiji:msg:${bareUuid}-->`
      const uText = `prompt text\n<!--taiji:msg:u-${bareUuid}-->`
      // 裸标记：defer ①a 命中（提取 id），TAG_MATCH 不命中（input hook 不 strip → 全程存活）
      expect(bareText.match(deferRe)?.[1], '裸标记未被 DEFER_FLUSH_MARKER_RE 命中——core ①a 提取失效').toBe(bareUuid)
      expect(tagMatchRe.test(bareText), '裸标记被 msg-id-mapper TAG_MATCH 命中——互斥论证失效，input hook 将 strip 裸标记，①a 断链').toBe(false)
      // u- 标记：TAG_MATCH 命中（既有映射机制不受影响），DEFER 不命中（id 空间互斥，不误确认）
      expect(uText.match(tagMatchRe)?.[1], 'u- 标记未被 TAG_MATCH 命中——msg-id-mapper 既有机制回归').toBe(`u-${bareUuid}`)
      expect(deferRe.test(uText), 'u- 标记被 DEFER_FLUSH_MARKER_RE 命中——id 空间互斥论证失效，u- 标记会被误当 defer 确认').toBe(false)
      // [MF-1-11] 等价断言样例集（派生裸形态 ≡ 原手写体行为核对）：entry-tree-builder
      // test case D1 同款 deferId 提取样例 + i 旗标大写形态 + 畸形标记不命中
      const d1Uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
      expect(`排队消息正文\n<!--taiji:msg:${d1Uuid}-->`.match(deferRe)?.[1]).toBe(d1Uuid)
      const upper = '3F2504E0-4F89-41D3-9A0C-0305E82C3301'
      expect(`<!--taiji:msg:${upper}-->`.match(deferRe)?.[1]).toBe(upper)
      expect('<!--taiji:msg:not-a-uuid-->'.match(deferRe)).toBeNull()
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-extension-command-error.test.ts
// ======================================================================

const PI_DIST_m2_m2_m2 = locatePiCodingAgentDist()

const SKIP_REASON_m2_m2_m2_m2_d1 = PI_DIST_m2_m2_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const SESSION_SRC_m2_m2_m2_m2_d1 = PI_DIST_m2_m2_m2 ? readFileSync(join(PI_DIST_m2_m2_m2, 'core', 'agent-session.js'), 'utf-8') : ''


const count_m2_m2_m2_m2_d1 = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-extension-command-error', () => {
if (!PI_DIST_m2_m2_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_m2_m2)(
  `PS-71 探针：命令 handler 抛错的 event 标记值 = "command"（D10③ 过滤判据值域锚定${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_d1}` : ''}）`,
  () => {
    it('catch 分支恒产 event:"command" + extensionPath "command:<名>" 模板，且 "command" 值全文件唯一（非命令来源不共用该值）', () => {
      const win = methodWindow(SESSION_SRC_m2_m2_m2_m2_d1, 'async _tryExecuteExtensionCommand(text) {')
      expect(
        win,
        'PS-71 漂移：_tryExecuteExtensionCommand 方法消失/改签名——复核 PS-71 锚 dist/core/agent-session.js _tryExecuteExtensionCommand',
      ).not.toBe('')

      // 标记值全文件恰出现 1 次（值域唯一性：其他错误来源共用该值 = 过滤判据把非命令
      // 错误也放进 toast；标记值改名 = 判据静默失效、命令失败零反馈——两个方向都红）
      expect(
        count_m2_m2_m2_m2_d1(SESSION_SRC_m2_m2_m2_m2_d1, 'event: "command"'),
        'PS-71 漂移：event:"command" 标记值数量变化——useChat.ts 的 errorEvent !== \'command\' 过滤判据失效（命令失败零 toast，D10③ 盲区回归）；处置流程与 pi-rejection 同族：复核 dist _tryExecuteExtensionCommand catch 分支 → 同步 useChat.ts 判据值 → 更新 docs/pi-semantics.json PS-71 verifiedWith',
      ).toBe(1)

      // 分支位置：该标记值位于方法窗口内 catch 分支的 emitError 载荷中（不在 catch 内 =
      // 错误来源改形，过滤语义须复审）
      const catchIdx = win.indexOf('catch (err) {')
      expect(
        catchIdx,
        'PS-71 漂移：handler 抛错不再走 catch 分支（错误吞掉或改走别的上报侧？）——复核 PS-71',
      ).toBeGreaterThanOrEqual(0)
      const eventIdx = win.indexOf('event: "command"')
      expect(
        eventIdx > catchIdx,
        'PS-71 漂移：event:"command" 不在 catch 分支内（emitError 位置/来源改形）——复核 PS-71',
      ).toBe(true)

      // extensionPath 前缀模板与 event 标记同载荷相邻（useChat.ts 按 "command:" 前缀剥出
      // 可读命令名；两者拆散 = 过滤命中但 toast 显示原始 extensionPath）
      const pathIdx = win.indexOf('extensionPath: `command:${commandName}`')
      expect(
        pathIdx,
        'PS-71 漂移：extensionPath 不再是 `command:${commandName}` 模板——useChat.ts 的 "command:" 前缀剥离失效（toast 显示原始路径）；同族处置：同步 useChat.ts 前缀逻辑与 PS-71 verifiedWith',
      ).toBeGreaterThanOrEqual(0)
      expect(
        Math.abs(eventIdx - pathIdx) < 200,
        'PS-71 漂移：event 标记与 extensionPath 模板不再同载荷相邻（载荷结构改形）——复核 PS-71',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-model-resolution.test.ts
// ======================================================================

const PI_DIST_m2_m2_m2_d1 = locatePiCodingAgentDist()

const SKIP_REASON_m2_m2 = PI_DIST_m2_m2_m2_d1
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const readDistFile = (rel: string): string => readFileSync(join(PI_DIST_m2_m2_m2_d1 as string, rel), 'utf-8')


/** 行为级断言用：动态 import dist/core/model-resolver.js（纯函数，依赖 chalk/pi-ai 均可解析）。 */
type ModelResolverModule = {
  findExactModelReferenceMatch?: (ref: string, models: Array<{ id: string; provider?: string }>) => unknown
}

const modelResolver: ModelResolverModule | null = await (async () => {
  if (!PI_DIST_m2_m2_m2_d1) return null
  try {
    return (await import(pathToFileURL(join(PI_DIST_m2_m2_m2_d1, 'core', 'model-resolver.js')).href)) as ModelResolverModule
  } catch {
    return null
  }
})()

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-model-resolution', () => {
if (!PI_DIST_m2_m2_m2_d1) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_m2_m2_d1)(
  `PS-01 探针：--model pattern 匹配语义（代码形态断言${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2}` : ''}）`,
  () => {
    it('args.js 声明 --model 为 pattern（非精确 ID）', () => {
      const args = readDistFile(join('cli', 'args.js'))
      expect(
        args.includes('--model <pattern>'),
        'PS-01 漂移：args.js 不再以 <pattern> 语义声明 --model（改回精确 ID？）——复核 docs/pi-semantics.json PS-01 锚点 dist/cli/args.js',
      ).toBe(true)
    })

    it('exact 匹配 = id toLowerCase 全等 + 双命中判歧义作废（length===1 才放行）', () => {
      const resolver = readDistFile(join('core', 'model-resolver.js'))
      expect(
        resolver.includes('function findExactModelReferenceMatch'),
        'PS-01 漂移：findExactModelReferenceMatch 函数消失/改名——复核 PS-01 锚点 dist/core/model-resolver.js',
      ).toBe(true)
      expect(
        resolver.includes('.toLowerCase() === normalizedReference'),
        'PS-01 漂移：exact 匹配不再是 toLowerCase 相等——大小写语义变化，复核 PS-01（事故 A 根因 F1）',
      ).toBe(true)
      expect(
        resolver.includes('idMatches.length === 1 ? idMatches[0] : undefined'),
        'PS-01 漂移：canonical 双命中不再判歧义作废——孪生条目将静默命中其一，复核 PS-01 与切片 1 孪生检查',
      ).toBe(true)
    })

    it('无 exact 命中时 contains 模糊 → isAlias 分桶 → localeCompare 降序取最大', () => {
      const resolver = readDistFile(join('core', 'model-resolver.js'))
      expect(
        resolver.includes('.id.toLowerCase().includes(modelPattern.toLowerCase())'),
        'PS-01 漂移：contains 模糊匹配形态消失——匹配规则改形，复核 PS-01',
      ).toBe(true)
      expect(
        resolver.includes('aliases.sort((a, b) => b.id.localeCompare(a.id))') &&
          resolver.includes('datedVersions.sort((a, b) => b.id.localeCompare(a.id))'),
        'PS-01 漂移：localeCompare 取最大形态消失——「选哪个」规则改形（事故 A 的 429 根因），复核 PS-01',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST_m2_m2_m2_d1 || !modelResolver?.findExactModelReferenceMatch)(
  'PS-01 探针：findExactModelReferenceMatch 行为断言（动态 import dist/core/model-resolver.js）',
  () => {
    const fn = modelResolver!.findExactModelReferenceMatch!
    const mk = (id: string) => [{ id, provider: 'p', name: id }]

    it('大小写不敏感全等放行（请求小写命中大写 id）', () => {
      expect(fn('glm-5.3', mk('GLM-5.3'))).toMatchObject({ id: 'GLM-5.3' })
    })

    it('canonical 双命中判歧义作废（大小写孪生条目 → undefined，不静默选边）', () => {
      const twins = [...mk('GLM-5.3'), ...mk('glm-5.3')]
      expect(fn('glm-5.3', twins)).toBeUndefined()
      expect(fn('GLM-5.3', twins)).toBeUndefined()
    })

    it('无命中 → undefined（exact 段不模糊）', () => {
      expect(fn('no-such-model', mk('GLM-5.3'))).toBeUndefined()
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-model-snapshot.test.ts
// ======================================================================

function locatePiDistLocal(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'core', 'model-runtime.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}


function locatePiAiDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
    if (existsSync(join(candidate, 'models.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}


const PI_DIST_m2 = locatePiDistLocal()

const PI_AI_DIST = locatePiAiDist()

const SKIP_REASON_m2_m2_d1 = PI_DIST_m2 && PI_AI_DIST
  ? ''
  : 'pi 实装 dist 不可达（cwd 上溯 6 级未命中 pi-coding-agent / pi-ai）'


/** 读 dist 文件正文（含路径定位 + 存在性断言，便于失败时一眼看出是文件被改名还是内容变了）。 */
function readDist(dist: string, relative: string): string {
  const path = join(dist, relative)
  expect(existsSync(path), `pi 实装文件缺失（路径可能被改名）：${relative}`).toBe(true)
  return readFileSync(path, 'utf-8')
}


/** 取以 `start` 开头到 `endExclusive` 的片段（两端按首次出现匹配；用于把断言限定在函数体内）。 */
function slice(source: string, start: string, endExclusive: string): string {
  const from = source.indexOf(start)
  expect(from, `锚点未命中：${start}`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(endExclusive, from)
  expect(to, `结束锚点未命中：${endExclusive}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-model-snapshot', () => {
if (!PI_DIST_m2 || !PI_AI_DIST) {
  console.warn(`[pi-semantics-model-snapshot] skip：${SKIP_REASON}`)
}
describe.skipIf(!PI_DIST_m2 || !PI_AI_DIST)('PS-41 · set_model 只查内存快照 + Model not found 文案', () => {
  it('set_model 从 getAvailableSnapshot() 解析，未命中回 `Model not found: <provider>/<id>`', () => {
    const src = readDist(PI_DIST_m2!, 'modes/rpc/rpc-mode.js')
    const body = slice(src, 'case "set_model"', 'case "cycle_model"')
    expect(body).toContain('modelRuntime.getAvailableSnapshot()')
    expect(body).toMatch(/models\.find\(\s*\(m\)\s*=>\s*m\.provider === command\.provider && m\.id === command\.modelId/)
    expect(body).toContain('Model not found: ${command.provider}/${command.modelId}')
    // 唯一的落点：快照找不到就报错，没有任何「重读磁盘 / 触发 refresh」的兜底
    expect(body).not.toContain('ModelConfig.load')
    expect(body).not.toContain('refresh(')
  })

  it('getAvailableSnapshot() 只回缓存（快照来自 create() 期 refresh，运行期不自动重建）', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-runtime.js')
    const body = slice(src, 'getAvailableSnapshot()', 'getError()')
    expect(body).toContain('return this.snapshot.available')
    // 快照更新点只在 updateModelSnapshot（由 rebuildProviders / refresh 触发）
    const update = slice(src, 'updateModelSnapshot()', 'async runAvailabilityRefresh')
    expect(update).toContain('available: all.filter(')
  })

  it('getError() 合成 config error + per-provider composition error（坏配置的唯一判据面）', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-runtime.js')
    const body = slice(src, 'getError()', 'getRegisteredProviderConfig')
    expect(body).toContain('this.config.getError()')
    expect(body).toContain('compositionErrors')
    expect(body).toContain('this.availabilityError')
  })
})
describe.skipIf(!PI_DIST_m2 || !PI_AI_DIST)('PS-42 · refresh 重读磁盘 + allowNetwork:false 零网络', () => {
  it('ModelRuntime.refresh 首行重读 models.json 配置并按新配置重组 providers', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-runtime.js')
    const body = slice(src, 'async refresh(options = {})', 'registerNativeProvider')
    expect(body).toContain('this.config = await ModelConfig.load(this.modelsPath)')
    expect(body).toMatch(/rebuildProviders\(\)|recomposeProvider\(providerId\)/)
    expect(body).toContain('updateModelSnapshot()')
    expect(body).toContain('queueAvailabilityRefresh(options.signal)')
    expect(body).toContain('return { aborted:')
    // 返回体不含 getError（调用方必须另调 registry.getError()）
    expect(body).not.toContain('getError')
  })

  it('allowNetwork:false 在凭据解析 / 网络动作之前提前返回（pi-ai 本地恢复相位）', () => {
    const src = readDist(PI_AI_DIST!, 'models.js')
    const body = slice(src, 'async refresh(options = {})', 'async resolveRefreshCredential')
    // 关键 early-return：本地相位跑完就 return，resolvedCredential 之前
    expect(body).toMatch(/if \(!allowNetwork \|\| signal\.aborted\)\s*\n\s*return;/)
    expect(body).toContain('const allowNetwork = options.allowNetwork ?? true')
  })

  it('ModelRegistry.refresh 直通 runtime，getError 是独立方法（两个调用点）', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-registry.js')
    const refresh = slice(src, 'refresh(options)', 'getError()')
    expect(refresh).toContain('return this.runtime.refresh(options)')
    const getError = slice(src, 'getError()', 'getAll()')
    expect(getError).toContain('return this.runtime.getError()')
  })
})
describe.skipIf(!PI_DIST_m2 || !PI_AI_DIST)('PS-43 · ModelConfig.load 的两种不可用形态', () => {
  it('ENOENT → 合法空 config 且无 error', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-config.js')
    const body = slice(src, 'static async load(', 'getProvider(')
    expect(body).toMatch(/code === "ENOENT"/)
    expect(body).toContain('return new ModelConfig(new Map())')
  })

  it('解析 / schema 失败 → 空 config + error 全文（含两类文案）', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-config.js')
    const body = slice(src, 'static async load(', 'getProvider(')
    expect(body).toMatch(/Failed to parse models\.json/)
    expect(body).toMatch(/Invalid models\.json schema/)
  })

  it('ModelDefinitionSchema.id 必填且 minLength 1（id 缺失会拒载整个文件）', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-config.js')
    const body = slice(src, 'const ModelDefinitionSchema', 'const ModelOverrideSchema')
    expect(body).toMatch(/id:\s*Type\.String\(\{\s*minLength:\s*1\s*\}\)/)
    // id 不在 Optional 里（必填）
    expect(body).not.toMatch(/id:\s*Type\.Optional/)
    const provider = slice(src, 'const ProviderConfigSchema', 'const ModelsConfigSchema')
    expect(provider).toMatch(/models:\s*Type\.Optional\(Type\.Array\(ModelDefinitionSchema\)\)/)
  })

  it('providers.models 无 string 分支（字符串模型项对 pi 非法）', () => {
    const src = readDist(PI_DIST_m2!, 'core/model-config.js')
    const provider = slice(src, 'const ProviderConfigSchema', 'const ModelsConfigSchema')
    // `models` 只接受对象数组——U6 取消「字符串归一」的依据
    expect(provider).not.toMatch(/Type\.Union\(\[Type\.String/)
  })
})
describe.skipIf(!PI_DIST_m2 || !PI_AI_DIST)('PS-41 附：setModel 的持久层面（model_change 落 session JSONL）', () => {
  it('agent-session.setModel → sessionManager.appendModelChange(provider, modelId)（切模型必落 entry）', () => {
    const src = readDist(PI_DIST_m2!, 'core/agent-session.js')
    const body = slice(src, 'async setModel(model, options = {})', 'async cycleModel')
    expect(body).toContain('this.sessionManager.appendModelChange(model.provider, model.id)')
  })

  it('model_change entry 形状 = {type, id, parentId, timestamp, provider, modelId}', () => {
    const src = readDist(PI_DIST_m2!, 'core/session-manager.js')
    const body = slice(src, 'appendModelChange(provider, modelId)', 'appendLabelChange')
    expect(body).toContain('type: "model_change"')
    expect(body).toContain('provider,')
    expect(body).toContain('modelId,')
  })
})
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-prompt-rejection.test.ts
// ======================================================================

const PI_DIST_m2_d1 = locatePiCodingAgentDist()

const SKIP_REASON_m2 = PI_DIST_m2_d1
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const SESSION_SRC_m2 = PI_DIST_m2_d1 ? readFileSync(join(PI_DIST_m2_d1, 'core', 'agent-session.js'), 'utf-8') : ''


const count_m2 = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-prompt-rejection', () => {
if (!PI_DIST_m2_d1) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_d1)(
  `PS-22 探针：prompt() manual 压缩拒绝原文（_compactionAbortController 分支${SKIP_REASON ? `｜skip：${SKIP_REASON_m2}` : ''}）`,
  () => {
    it('原文存在且在 prompt() 内 _compactionAbortController 检查之后（转译 reason:"compacting" 的识别依据）', () => {
      const win = methodWindow(SESSION_SRC_m2, 'async prompt(text, options) {')
      expect(win, 'PS-22 漂移：prompt() 方法消失/改签名——复核 PS-22 锚点 dist/core/agent-session.js').not.toBe('')

      // 原文全文恰出现 1 次（文案漂移即红——runtime classifyPromptRejection 按 includes 识别；
      // 识别串 = PI_REJECTION_COMPACTING 常量单点，F1-18）
      expect(
        count_m2(SESSION_SRC_m2, PI_REJECTION_COMPACTING),
        'PS-22 漂移：manual 压缩拒绝文案消失/变更——runtime 转译失效退化为 message.error，同步 infra/pi/pi-rejection.ts PI_REJECTION_COMPACTING 后更新 verifiedWith',
      ).toBe(1)

      // 分支位置：原文紧跟 _compactionAbortController !== undefined 检查（仍在 prompt() 窗口内）
      const checkIdx = win.indexOf('if (this._compactionAbortController !== undefined) {')
      expect(
        checkIdx,
        'PS-22 漂移：_compactionAbortController 前置检查移出 prompt()（manual 压缩改走别的拒绝路径？）——复核 PS-22',
      ).toBeGreaterThanOrEqual(0)
      const throwIdx = win.indexOf(`"${PI_REJECTION_COMPACTING}`)
      expect(
        throwIdx > checkIdx && throwIdx - checkIdx < 200,
        'PS-22 漂移：拒绝 throw 与 controller 检查不再相邻（检查顺序/分支改形）——复核 PS-22',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST_m2_d1)(
  `PS-23 探针：prompt() isStreaming 拒绝原文（auto 压缩 / post-run 窗口${SKIP_REASON ? `｜skip：${SKIP_REASON_m2}` : ''}）`,
  () => {
    it('原文存在且在 prompt() 内 isStreaming 无 streamingBehavior 分支（转译 reason:"processing" 的识别依据）', () => {
      const win = methodWindow(SESSION_SRC_m2, 'async prompt(text, options) {')
      expect(win, 'PS-23 漂移：prompt() 方法消失/改签名——复核 PS-23 锚点').not.toBe('')

      // 原文全文恰出现 1 次（文案漂移即红——runtime classifyPromptRejection 按 includes 识别；
      // 识别串 = PI_REJECTION_PROCESSING 常量单点，F1-18）
      expect(
        count_m2(SESSION_SRC_m2, PI_REJECTION_PROCESSING),
        'PS-23 漂移：isStreaming 拒绝文案消失/变更——runtime 转译失效退化为 message.error，同步 infra/pi/pi-rejection.ts PI_REJECTION_PROCESSING 后更新 verifiedWith',
      ).toBe(1)

      // 分支位置：原文位于 if (this.isStreaming) { if (!options?.streamingBehavior) throw 链内
      const streamingIdx = win.indexOf('if (this.isStreaming) {')
      expect(
        streamingIdx,
        'PS-23 漂移：isStreaming 分流分支移出 prompt()（busy 拒绝路径改形？）——复核 PS-23',
      ).toBeGreaterThanOrEqual(0)
      const throwIdx = win.indexOf(`"${PI_REJECTION_PROCESSING}`)
      expect(
        throwIdx > streamingIdx,
        'PS-23 漂移：拒绝 throw 不再位于 isStreaming 分支内（无 streamingBehavior 仍可入队/改由他处拦截？）——复核 PS-23',
      ).toBe(true)
      expect(
        win.slice(streamingIdx, throwIdx).includes('!options?.streamingBehavior'),
        'PS-23 漂移：streamingBehavior 缺省检查消失（裸 prompt 语义变化，taiji 调用形态恒两参）——复核 PS-23',
      ).toBe(true)
    })
  },
)
});
