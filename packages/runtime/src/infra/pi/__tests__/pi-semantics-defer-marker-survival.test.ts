/**
 * PS-26 探针：消息文本 transform 面唯一性（prompt input hook）与裸标记 send/steer 两通路存活。
 *
 * 登记条目（docs/pi-semantics.json PS-26）：
 * pi 对消息文本的改写只发生在 prompt() 通路的 extension input hook（emitInput 返回
 * transform 才替换 currentText）；steer()/followUp()/_queueSteer/_queueFollowUp 全程无
 * input hook，消息对象从原文本构造 → agent.steer 入队 → steeringQueue.drain → 直接 emit
 * message_start/message_end 并 push 进 LLM 上下文，零改写；user 消息落盘与事件同源
 *（_handleAgentEvent 对 message_end 的 event.message 原样 sessionManager.appendMessage）。
 * 推论（core defer 投递确认协议承重）：不匹配 msg-id-mapper TAG_STRIP（仅 u- 前缀形态）
 * 的裸 uuid 确认标记（DEFER_FLUSH_MARKER_RE，uuid hex 字符集不含 u → 与 u- 前缀结构互斥）
 * 在 send 通路（input hook 不命中即 transform 不发生）与 steer 通路（无 hook）均全程存活
 * ——pi 落盘文本与 message_end(user) 回流文本都携带标记，core user-delivery ①a 按标记 id
 * 确认出队的可达性锚点（data-governance round2 MF-1）。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi-coding-agent / pi-agent-core）+ xyz 两侧
 * 标记正则源码（core apply-entry-convert / extension msg-id-mapper）的互斥行为验证，
 * 同 pi-semantics-turn-usage-model.test.ts 范式。dist 或源文件不可达时 skip 不 fail；不进
 * REAL_PI_TESTS 分池。pi 升级后红 = transform 面扩大（steer 通路出现 input hook）或
 * 落盘/事件改写，先复核 PS-26 锚点再更新登记。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-defer-marker-survival.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

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
const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const REPO_ROOT = locateRepoRoot()
const SKIP_REASON = CODING_AGENT_DIST && AGENT_CORE_DIST && REPO_ROOT
  ? ''
  : 'node_modules/@earendil-works/{pi-coding-agent,pi-agent-core}/dist 或仓库根不可达（cwd 上溯 6 级未命中）'
if (SKIP_REASON) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

describe.skipIf(SKIP_REASON !== '')(
  `PS-26 探针：transform 面唯一性与裸标记两通路存活（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const agentSession = readFileSync(join(CODING_AGENT_DIST as string, 'core', 'agent-session.js'), 'utf-8')
    const agentCore = readFileSync(join(AGENT_CORE_DIST as string, 'agent.js'), 'utf-8')
    const agentLoop = readFileSync(join(AGENT_CORE_DIST as string, 'agent-loop.js'), 'utf-8')

    it('pi-coding-agent prompt()：input hook 是全文唯一 transform 询问点（hasHandlers("input")/emitInput 各仅 1 处）', () => {
      // 唯一性 = steer/followUp/_queueSteer/_queueFollowUp 无 input hook 的结构性依据：
      // transform 询问点不在任何 steer 侧函数中出现（steer 通路无改写面的静态证明）
      expect(agentSession.match(/hasHandlers\("input"\)/g), 'hasHandlers("input") 出现 >1 处——transform 询问面扩大，复核 PS-26 锚点').toHaveLength(1)
      expect(agentSession.match(/\.emitInput\(/g), '.emitInput( 出现 >1 处——input 事件发射面扩大，复核 PS-26 锚点').toHaveLength(1)
    })

    it('pi-coding-agent prompt()：文本替换仅由 hook transform 结果驱动（非 transform 不改 currentText）', () => {
      // transform 条件分支形态：action === "transform" 才 currentText = inputResult.text
      const hook = /if \(this\._extensionRunner\.hasHandlers\("input"\)\) \{\s*\n\s*const inputResult = await this\._extensionRunner\.emitInput\(/
        .exec(agentSession)
      expect(hook, 'PS-26 漂移：prompt() 的 input hook 拦截段形态改变——复核 agent-session.js prompt()').not.toBeNull()
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
      const init = /for \(const prompt of prompts\) \{\s*\n\s*await emit\(\{ type: "message_start", message: prompt \}\);\s*\n\s*await emit\(\{ type: "message_end", message: prompt \}\);\s*\n\s*\}/
        .exec(agentLoop)
      expect(init, 'PS-26 漂移：runAgentLoop 初始 prompt 不再原样 emit message_start/message_end——send 通路 user 消息事件/落盘来源变化，复核 agent-loop.js').not.toBeNull()
    })

    it('pi-agent-core runLoop：steering drain 后的消息直接 emit + push 上下文（steer 通路零 transform 注入）', () => {
      // 注入块三行同现：事件携带的消息与进 LLM 上下文的是同一对象（无第二改写面）
      const inject = /for \(const message of pendingMessages\) \{\s*\n\s*await emit\(\{ type: "message_start", message \}\);\s*\n\s*await emit\(\{ type: "message_end", message \}\);\s*\n\s*currentContext\.messages\.push\(message\);\s*\n\s*newMessages\.push\(message\);/
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

    it('xyz 两侧标记正则互斥（行为验证）：裸 uuid 不被 msg-id-mapper TAG_MATCH 命中，u- 标记不被 DEFER_FLUSH_MARKER_RE 命中', () => {
      const coreSrc = readFileSync(join(REPO_ROOT as string, 'packages', 'core', 'src', 'domain', 'chat', 'apply-entry-convert.ts'), 'utf-8')
      const extSrc = readFileSync(join(REPO_ROOT as string, 'extensions', 'taiji', 'msg-id-mapper', 'src', 'index.ts'), 'utf-8')
      // 提取正则字面量 body + flags 并重建（源码即 SSOT，防探针内复制字面量漂移）
      const deferDef = /DEFER_FLUSH_MARKER_RE = \/(.+?)\/([a-z]*)\r?\n/.exec(coreSrc)
      const tagMatchDef = /const TAG_MATCH = \/(.+?)\/([a-z]*)\r?\n/.exec(extSrc)
      expect(deferDef, 'core DEFER_FLUSH_MARKER_RE 字面量提取失败——复核 apply-entry-convert.ts').not.toBeNull()
      expect(tagMatchDef, 'extension TAG_MATCH 字面量提取失败——复核 msg-id-mapper/src/index.ts').not.toBeNull()
      const deferRe = new RegExp(deferDef![1], deferDef![2])
      const tagMatchRe = new RegExp(tagMatchDef![1], tagMatchDef![2])
      // TAG_STRIP（msg-id-mapper 的剥离正则）必须仍是 u- 前缀形态（input hook 只剥 u- 标记的依据）
      expect(
        /const TAG_STRIP = \/<!--xyz:msg:u-\[0-9a-fA-F-\]\{36\}-->\/g/.test(extSrc),
        'PS-26 关联漂移：msg-id-mapper TAG_STRIP 不再是 u- 前缀专属形态——若扩为同剥裸标记，core ①a 提取自回流原文的可达性断链，须先探针论证再改',
      ).toBe(true)

      const bareUuid = '3f2a1b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c'
      const bareText = `queue text\n<!--xyz:msg:${bareUuid}-->`
      const uText = `prompt text\n<!--xyz:msg:u-${bareUuid}-->`
      // 裸标记：defer ①a 命中（提取 id），TAG_MATCH 不命中（input hook 不 strip → 全程存活）
      expect(bareText.match(deferRe)?.[1], '裸标记未被 DEFER_FLUSH_MARKER_RE 命中——core ①a 提取失效').toBe(bareUuid)
      expect(tagMatchRe.test(bareText), '裸标记被 msg-id-mapper TAG_MATCH 命中——互斥论证失效，input hook 将 strip 裸标记，①a 断链').toBe(false)
      // u- 标记：TAG_MATCH 命中（既有映射机制不受影响），DEFER 不命中（id 空间互斥，不误确认）
      expect(uText.match(tagMatchRe)?.[1], 'u- 标记未被 TAG_MATCH 命中——msg-id-mapper 既有机制回归').toBe(`u-${bareUuid}`)
      expect(deferRe.test(uText), 'u- 标记被 DEFER_FLUSH_MARKER_RE 命中——id 空间互斥论证失效，u- 标记会被误当 defer 确认').toBe(false)
    })
  },
)
