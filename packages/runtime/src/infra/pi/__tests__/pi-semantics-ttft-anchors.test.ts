/**
 * PS-41 / PS-42 探针：composer-genstats-ttft 采样锚点的两条 pi 语义前提（设计 §3.2
 * 「pi 语义依赖登记」）。
 *
 * ── PS-41：turn_start 逐 LLM 请求 emit（TTFT 起算锚点前提）──
 * pi-agent-core agent-loop.js：每轮 LLM 请求恰发一次 turn_start——
 *   - 首个请求：runAgentLoop / runAgentLoopContinue 入口（agent_start 之后、runLoop 之前）；
 *   - 工具循环后续轮：runLoop 内层 while 的 prepareNextTurn **之后** emit（原生
 *     auto-compaction 运行在 prepareNextTurn 内、先于锚点 → 不含在 TTFT 窗口；工具执行
 *     在上一轮 turn_end 之后 → 亦不含，工具后下一轮 turn_start 重新起算）；
 *   - turn_start 后的 steering 注入段（pendingMessages for 循环）在 streamAssistantResponse
 *     之前 → 计入窗口（设计接受，通常毫秒级）。
 * taiji 依赖面：event-adapter handleTurnStart 翻译 llm-request-start → LlmWindowSampler
 * .onRequestStart 重锚。pi 升级后红 = 锚点前提漂移（TTFT 系统性偏大/偏小或恒 null），
 * 按断言消息复核 agent-loop.js 后更新登记。
 *
 * ── PS-42：*_start 先于 delta（首输出结算前提，否决表 E「无 delta 兜底钩」的依据）──
 * pi-ai 全族流式实现（openai-completions / anthropic-messages / openai-responses-shared
 * （openai-responses / codex / azure 均委托其 processResponsesStream）/ google-generative-ai /
 * bedrock-converse-stream / mistral-conversations）凡产 text/thinking/toolcall delta 必先产
 * 对应 *_start——实现模式三族：
 *   ① lazy ensure/slot 工厂（openai-completions 的 ensure*Block / responses-shared 的
 *      createSlot+getSlot）：block 创建分支内同步 push *_start，delta 站点先取 block；
 *   ② wire content_block_start/delta 映射（anthropic / bedrock）：start 事件分支建块 +
 *      push *_start，delta 分支按 index 查块 + 类型守卫，块只在 start 分支创建；
 *   ③ 守卫分支紧邻（google / mistral）：`if (!currentBlock)` 建块分支 push *_start 与
 *      delta push 同迭代紧邻。
 * taiji 依赖面：adapter 仅对 text_start / thinking_start / toolcall_start 产 llm-first-output
 * （单点收）——pi 若出现「产 delta 不先产 *_start」的 provider，该模型 TTFT 恒 null 静默
 * 降级（显 —），本探针在 pi bump 门禁先红。
 *
 * 断言方式：静态直读 node_modules 实装 dist（同 pi-semantics-turn-usage-model.test.ts 范式）。
 * dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-ttft-anchors.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const PI_AI_DIST = locatePiDist('pi-ai', 'api')
const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const SKIP_REASON = PI_AI_DIST && AGENT_CORE_DIST
  ? ''
  : 'node_modules/@earendil-works/{pi-ai,pi-agent-core}/dist 不可达（cwd 上溯 6 级未命中）'
if (SKIP_REASON) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

/** 全部出现位置（indexOf 累进）。 */
function allIndices(src: string, marker: string): number[] {
  const out: number[] = []
  let i = -1
  while ((i = src.indexOf(marker, i + 1)) !== -1) out.push(i)
  return out
}

/**
 * 通用不变量：marker 的每个出现位置，向前 window 字符内存在 preceding 之一。
 * 用于「delta 站点前置守卫/start 推送」型断言；返回失败位置的序号供报错定位。
 */
function assertEveryPrecededBy(
  src: string,
  marker: string,
  precedings: string[],
  window: number,
  label: string,
): void {
  for (const [n, idx] of allIndices(src, marker).entries()) {
    const before = src.slice(Math.max(0, idx - window), idx)
    const ok = precedings.some((p) => before.includes(p))
    expect(
      ok,
      `PS-42 漂移（${label}）：第 ${n + 1} 处 "${marker}" 向前 ${window} 字符内无 [${precedings.join(' / ')}]——该 delta 站点可能脱离对应 *_start 保障，复核 pi-ai 流式实现`,
    ).toBe(true)
  }
}

describe.skipIf(SKIP_REASON !== '')(
  `PS-41 探针：turn_start 逐 LLM 请求 emit（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const agentLoop = readFileSync(join(AGENT_CORE_DIST as string, 'agent-loop.js'), 'utf-8')
    // 顶层函数切片：非贪婪至行首 `}`（同 PS-25 runLoop 切片范式）
    const runAgentLoopBody = /export async function runAgentLoop\(prompts[\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const runAgentLoopContinueBody = /export async function runAgentLoopContinue\([\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const runLoopBody = /async function runLoop\(initialContext[\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const streamBody = /async function streamAssistantResponse\([\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''

    it('A1 首个请求：runAgentLoop 入口 agent_start 后、runLoop 调用前恰发一次 turn_start', () => {
      expect(runAgentLoopBody, 'PS-41 漂移：runAgentLoop 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      const startIdx = runAgentLoopBody.indexOf('await emit({ type: "turn_start" });')
      const agentStartIdx = runAgentLoopBody.indexOf('await emit({ type: "agent_start" });')
      const runLoopCallIdx = runAgentLoopBody.indexOf('await runLoop(')
      expect(startIdx, 'PS-41 漂移：runAgentLoop 入口不再 emit turn_start——首个 LLM 请求失去起算锚点').toBeGreaterThan(-1)
      expect(agentStartIdx).toBeGreaterThan(-1)
      expect(runLoopCallIdx).toBeGreaterThan(-1)
      expect(
        agentStartIdx < startIdx && startIdx < runLoopCallIdx,
        'PS-41 漂移：runAgentLoop 的 turn_start 不再位于 agent_start 与 runLoop 之间——复核 agent-loop.js',
      ).toBe(true)
      expect(
        allIndices(runAgentLoopBody, 'type: "turn_start"').length,
        'PS-41 漂移：runAgentLoop 内 turn_start 出现次数 ≠ 1——逐请求锚点前提变化',
      ).toBe(1)
    })

    it('A2 重试续跑：runAgentLoopContinue 入口同款（agent_start 后、runLoop 前）', () => {
      expect(runAgentLoopContinueBody, 'PS-41 漂移：runAgentLoopContinue 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      const startIdx = runAgentLoopContinueBody.indexOf('await emit({ type: "turn_start" });')
      const agentStartIdx = runAgentLoopContinueBody.indexOf('await emit({ type: "agent_start" });')
      const runLoopCallIdx = runAgentLoopContinueBody.indexOf('await runLoop(')
      expect(startIdx, 'PS-41 漂移：runAgentLoopContinue 入口不再 emit turn_start——重试轮失去起算锚点').toBeGreaterThan(-1)
      expect(
        agentStartIdx < startIdx && startIdx < runLoopCallIdx,
        'PS-41 漂移：runAgentLoopContinue 的 turn_start 位置变化——复核 agent-loop.js',
      ).toBe(true)
    })

    it('A3 工具循环后续轮：prepareNextTurn 之后、steering 注入与流式调用之前恰发一次 turn_start', () => {
      expect(runLoopBody, 'PS-41 漂移：runLoop 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      // runLoop 内唯一发射点，且位于 lastCompletedTurn 守卫内（首轮入口锚由 A1/A2 承担）
      expect(
        allIndices(runLoopBody, 'type: "turn_start"').length,
        'PS-41 漂移：runLoop 内 turn_start 出现次数 ≠ 1——逐请求锚点前提变化',
      ).toBe(1)
      const turnStartIdx = runLoopBody.indexOf('await emit({ type: "turn_start" });')
      const prepareIdx = runLoopBody.indexOf('await config.prepareNextTurn?.(lastCompletedTurn);')
      const steeringIdx = runLoopBody.indexOf('for (const message of pendingMessages) {')
      const streamCallIdx = runLoopBody.indexOf('const message = await streamAssistantResponse(')
      expect(prepareIdx, 'PS-41 漂移：prepareNextTurn 调用点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
      expect(steeringIdx, 'PS-41 漂移：steering 注入循环消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
      expect(streamCallIdx, 'PS-41 漂移：streamAssistantResponse 调用点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
      // 时序四元组：原生 compaction（prepareNextTurn 内）先于锚点 → 不含 TTFT 窗口；
      // 锚点先于 steering 注入与流式调用 → 两者计入窗口（设计 §3.2 窗口构成）
      expect(
        prepareIdx < turnStartIdx && turnStartIdx < steeringIdx && steeringIdx < streamCallIdx,
        'PS-41 漂移：turn_start 不再位于 prepareNextTurn 之后、steering 注入/流式调用之前——TTFT 窗口构成前提（不含原生压缩与工具执行）破裂，复核 agent-loop.js runLoop',
      ).toBe(true)
    })

    it('A4 流式函数内无 turn_start（锚点严格先于全部输出信号）', () => {
      expect(streamBody, 'PS-41 漂移：streamAssistantResponse 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      expect(
        streamBody.includes('type: "turn_start"'),
        'PS-41 漂移：streamAssistantResponse 内出现 turn_start emit——锚点可能晚于输出信号，复核 agent-loop.js',
      ).toBe(false)
    })
  },
)

describe.skipIf(SKIP_REASON !== '')(
  `PS-42 探针：pi-ai 全族流式实现凡产 delta 必先产对应 *_start（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const read = (f: string): string => readFileSync(join(PI_AI_DIST as string, 'api', f), 'utf-8')

    // ── ① openai-completions（openai / openai 兼容端点）：lazy ensure 工厂族 ──
    describe('openai-completions：ensure*Block 创建分支同步产 *_start，delta 站点先取 block', () => {
      const src = read('openai-completions.js')

      it('block 创建唯一点（blocks.push）逐处紧跟对应 *_start 推送', () => {
        // 三处 blocks.push 全在 ensure* 工厂内；创建即播报——finishBlock 尾部 custom toolcall
        // flush 的 delta 操作的是既有 block，其创建时已产 start
        const pairs: Array<[string, string]> = [
          ['blocks.push(textBlock);', 'type: "text_start"'],
          ['blocks.push(thinkingBlock);', 'type: "thinking_start"'],
          ['blocks.push(block);', 'type: "toolcall_start"'],
        ]
        for (const [push, start] of pairs) {
          for (const idx of allIndices(src, push)) {
            const after = src.slice(idx, idx + 120)
            expect(
              after.includes(start),
              `PS-42 漂移：openai-completions "${push}" 后 120 字符内无 "${start}"——block 创建不再同步播报 start`,
            ).toBe(true)
          }
        }
      })

      it('text/thinking delta 站点前置 ensure 调用；toolcall delta 站点前置 ensure 或位于 finishBlock 既有块 flush', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['ensureTextBlock()'], 300, 'openai-completions text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['ensureThinkingBlock('], 300, 'openai-completions thinking_delta')
        // 流式站点距 ensure 调用 ~1255 字符（间夹 toolCall 字段修补）；finishBlock 尾部 flush
        // 站点操作既有 block（创建点由上一用例钉住）
        assertEveryPrecededBy(
          src,
          'type: "toolcall_delta"',
          ['ensureToolCallBlock(', 'const finishBlock = (block)'],
          1400,
          'openai-completions toolcall_delta',
        )
      })
    })

    // ── ① openai-responses-shared（openai-responses / codex / azure 委托）──
    describe('openai-responses-shared：createSlot 播报 *_start，delta 站点经 getSlot 存在性守卫', () => {
      const src = read('openai-responses-shared.js')
      const createSlotBody = src.slice(src.indexOf('const createSlot = (outputIndex, item) => {'), src.indexOf('const getOrCreateSlot = (outputIndex, item) => {'))

      it('createSlot 三个创建分支（reasoning/message/function_call|custom）各播报对应 *_start', () => {
        expect(createSlotBody, 'PS-42 漂移：createSlot 切片为空——复核 openai-responses-shared.js 结构').not.toBe('')
        expect(createSlotBody).toContain('type: "thinking_start"')
        expect(createSlotBody).toContain('type: "text_start"')
        expect(createSlotBody, 'createSlot 不再播报 toolcall_start（或函数切片错位）').toContain('type: "toolcall_start"')
        // getSlot 类型不匹配返回 undefined → delta 站点 if (!slot) continue 守卫成立的前提
        expect(
          src.includes('return slot?.type === type ? slot : undefined;'),
          'PS-42 漂移：getSlot 不再按存在性+类型返回 undefined——delta 守卫前提破裂，复核 openai-responses-shared.js',
        ).toBe(true)
      })

      it('text/thinking delta 站点前置 getSlot 存在性取槽；toolcall delta 经 pushToolCallDelta(slot) 助手（slot 同源）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['getSlot(event.output_index, "text")'], 350, 'responses text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['getSlot(event.output_index, "thinking")'], 350, 'responses thinking_delta')
        // 助手本体推送 toolcall_delta；调用点全部传 slot（getSlot/getOrCreateSlot 取得，
        // 前置守卫见各站点 if (!slot) continue）
        const helper = /const pushToolCallDelta = \(slot, delta\) => \{[\s\S]*?type: "toolcall_delta"/.exec(src)
        expect(helper, 'PS-42 漂移：pushToolCallDelta 助手消失或不再推送 toolcall_delta——复核 openai-responses-shared.js').not.toBeNull()
        const callSites = allIndices(src, 'pushToolCallDelta(').length
        expect(callSites, 'pushToolCallDelta 调用点数量异常（含定义应为 6）').toBeGreaterThanOrEqual(5)
      })
    })

    // ── ② anthropic-messages：content_block_start 建块播报 / delta 按 index 查块 + 类型守卫 ──
    describe('anthropic-messages：delta 分支按 index 查块 + 类型守卫（块只在 start 分支创建）', () => {
      const src = read('anthropic-messages.js')
      const startBranch = src.slice(src.indexOf('else if (event.type === "content_block_start") {'), src.indexOf('else if (event.type === "content_block_delta") {'))

      it('content_block_start 分支建块即播报三种 *_start', () => {
        expect(startBranch, 'PS-42 漂移：content_block_start 分支切片为空——复核 anthropic-messages.js 结构').not.toBe('')
        expect(startBranch).toContain('type: "text_start"')
        expect(startBranch).toContain('type: "thinking_start"')
        expect(startBranch).toContain('type: "toolcall_start"')
        // blocks = output.content 别名存在（delta 查块与 start 建块同一数组）
        expect(src).toContain('const blocks = output.content;')
      })

      it('delta 站点全部前置 findIndex 查块 + block 类型守卫（无块不产 delta）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['block && block.type === "text"'], 400, 'anthropic text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['block && block.type === "thinking"'], 400, 'anthropic thinking_delta')
        assertEveryPrecededBy(src, 'type: "toolcall_delta"', ['block && block.type === "toolCall"'], 400, 'anthropic toolcall_delta')
      })
    })

    // ── ② bedrock-converse-stream：start 处理器建 toolCall 块播报 / delta 处理器守卫建块 ──
    describe('bedrock-converse-stream：handleContentBlockStart 播报 toolcall_start，delta 处理器无块先建块播报', () => {
      const src = read('bedrock-converse-stream.js')
      const startIdx = src.indexOf('function handleContentBlockStart')
      const deltaIdx = src.indexOf('function handleContentBlockDelta')
      // 文件内函数序：Start 在前 Delta 在后；delta 几体切到下一个顶层 function 声明
      const deltaFn = src.slice(deltaIdx, deltaIdx === -1 ? undefined : src.indexOf('\nfunction ', deltaIdx + 1))

      it('toolUse 块唯一创建点（handleContentBlockStart）播报 toolcall_start', () => {
        const startFn = src.slice(startIdx, deltaIdx)
        expect(startFn, 'PS-42 漂移：handleContentBlockStart 切片为空——复核 bedrock-converse-stream.js 结构').not.toBe('')
        expect(startFn, 'toolUse 块创建不再播报 toolcall_start').toContain('type: "toolcall_start"')
      })

      it('text delta 无块先建块播报 text_start；toolcall delta 前置既有 toolCall 块守卫；thinking 分支含建块播报', () => {
        expect(deltaFn, 'PS-42 漂移：handleContentBlockDelta 切片为空——复核 bedrock-converse-stream.js 结构').not.toBe('')
        expect(
          /if \(!block\) \{[\s\S]{0,250}type: "text_start"[\s\S]{0,200}type: "text_delta"/.test(deltaFn),
          'PS-42 漂移：text delta 不再走「无块先建块播报 text_start」路径，复核 handleContentBlockDelta',
        ).toBe(true)
        expect(
          /else if \(delta\?\.toolUse && block\?\.type === "toolCall"\) \{[\s\S]{0,400}type: "toolcall_delta"/.test(deltaFn),
          'PS-42 漂移：toolcall delta 失去既有 toolCall 块守卫（块由 start 处理器创建并播报）——复核 handleContentBlockDelta',
        ).toBe(true)
        expect(
          /else if \(delta\?\.reasoningContent\) \{[\s\S]*?if \(!thinkingBlock\) \{[\s\S]{0,300}type: "thinking_start"/.test(deltaFn),
          'PS-42 漂移：reasoning 分支不再「无 thinking 块先建块播报 thinking_start」——复核 handleContentBlockDelta',
        ).toBe(true)
      })
    })

    // ── ③ google-generative-ai / mistral-conversations：守卫分支紧邻建块播报 ──
    describe('google-generative-ai：!currentBlock 建块分支播报 *_start 与 delta 同迭代', () => {
      const src = read('google-generative-ai.js')

      it('delta 站点前置同迭代建块播报（text/thinking/toolcall）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['type: "text_start"'], 1300, 'google text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['type: "thinking_start"'], 1300, 'google thinking_delta')
        assertEveryPrecededBy(src, 'type: "toolcall_delta"', ['type: "toolcall_start"'], 400, 'google toolcall_delta')
      })
    })

    describe('mistral-conversations：守卫分支建块播报 *_start 与 delta 紧邻', () => {
      const src = read('mistral-conversations.js')

      it('delta 站点前置建块播报（text/thinking/toolcall）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['type: "text_start"'], 300, 'mistral text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['type: "thinking_start"'], 300, 'mistral thinking_delta')
        assertEveryPrecededBy(src, 'type: "toolcall_delta"', ['type: "toolcall_start"'], 600, 'mistral toolcall_delta')
      })
    })

    // ── 族闭合：responses 系包装实现委托 processResponsesStream（无独立流式实现）──
    it('openai-responses 系包装（codex / azure）委托 openai-responses-shared 的 processResponsesStream', () => {
      for (const f of ['openai-codex-responses.js', 'azure-openai-responses.js']) {
        const src = read(f)
        expect(
          src.includes('processResponsesStream'),
          `PS-42 漂移：${f} 不再委托 openai-responses-shared.processResponsesStream——出现独立流式实现，需为其补 *_start 前提探针`,
        ).toBe(true)
      }
    })
  },
)
