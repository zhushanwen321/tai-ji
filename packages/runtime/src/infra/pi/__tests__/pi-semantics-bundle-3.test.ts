import { extractFunctionBody, stripToCode } from './helpers/pi-dist-fn-extract.js';
import { locatePiCodingAgentDist, locatePiDist, methodWindow } from './helpers/pi-semantics-probe.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-skill-expansion-static.test.ts
// ======================================================================

/** 定位仓库内相对路径文件（cwd 逐级上溯找 taiji 侧镜像源码）。 */
function locateWorkspaceFile(rel: string): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}


const PI_DIST = locatePiCodingAgentDist()

const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

const FRONTMATTER_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'utils', 'frontmatter.js'), 'utf-8') : ''


const INJECTOR_PATH = locateWorkspaceFile('packages/runtime/src/services/session/skill-injector.ts')

const INJECTOR_SRC = INJECTOR_PATH ? readFileSync(INJECTOR_PATH, 'utf-8') : ''


const count = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-skill-expansion-static', () => {
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST)(
  `PS-27 探针：_expandSkillCommand 展开模板逐字锚（0.84.4 :983-1008${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('方法存在 + /skill: 前缀判定 + name/args 解析形态', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      expect(win, 'PS-27 漂移：_expandSkillCommand 方法消失/改签名——复核 PS-27 锚点 dist/core/agent-session.js').not.toBe('')
      expect(
        win.includes('if (!text.startsWith("/skill:"))'),
        'PS-27 漂移：/skill: 前缀判定形态消失——命令识别改形，复核 PS-27',
      ).toBe(true)
      expect(
        win.includes('const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);'),
        'PS-27 漂移：skill 名解析形态变化（首空格切分）——复核 PS-27',
      ).toBe(true)
      expect(
        win.includes('const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();'),
        'PS-27 漂移：args 解析形态变化（trim 语义）——复核 PS-27',
      ).toBe(true)
    })

    it('核心锚：skill block 模板字符串逐字（tag 结构 / References 行 / 空行分隔 / 结束标签）', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      // dist 源码中模板字符串的换行是字面 `\n` 转义（单行模板），断言用源码文本形态。
      // taiji 注入器 skill-injector.ts 的镜像模板必须与此逐字同构（仅变量名不同）。
      expect(
        win.includes(
          'const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\\nReferences are relative to ${skill.baseDir}.\\n\\n${body}\\n</skill>`;',
        ),
        'PS-27 漂移：skill block 模板字符串变化（tag 属性 / References 行 / 分隔空行 / 结束标签任一改形）——taiji 镜像 skill-injector 的展开将与 pi 原生不一致，复核 PS-24/PS-27 与 skill-injector.ts 的镜像模板',
      ).toBe(true)
      expect(
        win.includes('return args ? `${skillBlock}\\n\\n${args}` : skillBlock;'),
        'PS-27 漂移：args 拼接形态变化（block 与 args 间 \\n\\n 分隔）——复核 PS-27',
      ).toBe(true)
    })

    it('body 剥离 + 读取形态：readFileSync utf-8 + stripFrontmatter 双 trim', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      expect(
        win.includes('const content = readFileSync(skill.filePath, "utf-8");'),
        'PS-27 漂移：SKILL.md 读取形态变化——复核 PS-27',
      ).toBe(true)
      expect(
        win.includes('const body = stripFrontmatter(content).trim();'),
        'PS-27 漂移：body = stripFrontmatter(content).trim() 双 trim 形态消失——taiji 镜像 stripFrontmatterPi 依赖该语义，复核 PS-27',
      ).toBe(true)
      expect(
        SESSION_SRC.includes('import { stripFrontmatter } from "../utils/frontmatter.js";'),
        'PS-27 漂移：stripFrontmatter 导入源变化（不再从 utils/frontmatter.js 引入？）——复核 PS-27 的 frontmatter 锚点路径',
      ).toBe(true)
    })

    it('skill 查找 + 未命中透传：getSkills 映射按裸名精确匹配', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      expect(
        win.includes('this.resourceLoader.getSkills().skills.find((s) => s.name === skillName)'),
        'PS-27 漂移：skill 映射查找形态变化（source/resolver 改形）——复核 PS-27 与 taiji get_commands 映射（PS-24 前缀断言）',
      ).toBe(true)
      expect(
        count(win, 'if (!skill)') === 1 && win.includes('return text;'),
        'PS-27 漂移：未命中 skill 的原样透传分支消失/变多——taiji 失效透传（D8）对齐 pi 该行为，复核 PS-27',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST)(
  `PS-27 探针：frontmatter 剥离行为逐字锚（utils/frontmatter.js${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('extractFrontmatter 关键行逐字：BOM/换行归一 → 开界 → 闭界搜索 → 切片 trim', () => {
      // taiji 镜像 stripFrontmatterPi（skill-injector.ts）逐字依赖以下行为——任一行改形
      // 都意味着剥离语义漂移，golden diff（PS-24）与 taiji 镜像须同批复核。
      expect(
        FRONTMATTER_SRC.includes(
          'const normalizeNewlines = (value) => value.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");',
        ),
        'PS-27 漂移：换行归一形态变化（CRLF/CR → LF）——复核 stripFrontmatterPi 镜像',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('const normalized = normalizeNewlines(stripBom(content));'),
        'PS-27 漂移：BOM 剥除 + 归一的组合顺序变化——复核 stripFrontmatterPi 镜像（stripBomPi）',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('if (!normalized.startsWith("---")) {'),
        'PS-27 漂移：frontmatter 开界判定形态变化——复核 PS-27',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('const endIndex = normalized.indexOf("\\n---", 3);'),
        'PS-27 漂移：闭界搜索形态变化（\\n--- 从偏移 3 起 indexOf）——复核 PS-27 与镜像的 FRONTMATTER_DELIM_LEN',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('if (endIndex === -1) {'),
        'PS-27 漂移：闭界缺失分支（原文返回）消失——复核 PS-27',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('yamlString: normalized.slice(4, endIndex),'),
        'PS-27 漂移：yaml 提取切片偏移变化（slice(4, endIndex)）——复核 PS-27',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('body: normalized.slice(endIndex + 4).trim(),'),
        'PS-27 漂移：body 提取切片偏移或 trim 变化（slice(endIndex + 4).trim()）——taiji 镜像 FRONTMATTER_CLOSED_DELIM_LEN = 4 直接承重，复核 PS-27',
      ).toBe(true)
    })

    it('stripFrontmatter 导出形态：parseFrontmatter(content).body（body 直通，无额外变换）', () => {
      expect(
        FRONTMATTER_SRC.includes(
          'export const stripFrontmatter = (content) => parseFrontmatter(content).body;',
        ),
        'PS-27 漂移：stripFrontmatter 不再是 parseFrontmatter().body 直通——展开阶段的剥离语义改形，复核 PS-27 与 taiji 镜像',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST || !INJECTOR_SRC)(
  `PS-27 交叉锚：taiji skill-injector 镜像模板与 pi dist 同骨架${!PI_DIST && !INJECTOR_SRC ? '｜skip：dist 与镜像源码均不可达' : !PI_DIST ? `｜skip：${SKIP_REASON}` : !INJECTOR_SRC ? '｜skip：skill-injector.ts 不可达' : ''}`,
  () => {
    it('taiji block 模板行与 pi 模板同骨架（tag / References 行 / 分隔 / 结束标签逐子串一致）', () => {
      // taiji 镜像（skill-injector.ts resolveSingleMarker）的模板变量名与 pi 不同
      //（cmd.name/path/baseDir/body vs skill.name/skill.filePath/skill.baseDir/body——
      // D7 切源后映射条目 name 已是裸名，前缀剥除局部变量随 legacy 路径删除），
      // 骨架子串（结构定值部分）必须逐字一致——pi 改模板而 taiji 未跟时，本断言与
      // PS-27 dist 锚分别红（双侧锚定，单侧改动无处遁形）。
      expect(
        INJECTOR_SRC.includes(
          'const block = `<skill name="${cmd.name}" location="${path}">\\nReferences are relative to ${baseDir}.\\n\\n${body}\\n</skill>`',
        ),
        'PS-27 漂移：taiji 镜像 block 模板行改形（与 pi dist :995 骨架脱钩）——复核 skill-injector.ts 与 pi 实装模板的一致性（PS-24 golden diff 本地全量验证）',
      ).toBe(true)
    })

    it('taiji stripFrontmatterPi 关键行与 pi frontmatter.js 行为镜像（闭界搜索偏移 + body trim）', () => {
      expect(
        INJECTOR_SRC.includes("const endIndex = normalized.indexOf('\\n---', FRONTMATTER_DELIM_LEN)"),
        'PS-27 漂移：taiji 镜像闭界搜索改形——复核 stripFrontmatterPi 与 pi extractFrontmatter 的一致性',
      ).toBe(true)
      expect(
        INJECTOR_SRC.includes('return normalized.slice(endIndex + FRONTMATTER_CLOSED_DELIM_LEN).trim()'),
        'PS-27 漂移：taiji 镜像 body 切片/trim 改形——复核 stripFrontmatterPi 与 pi extractFrontmatter 的一致性',
      ).toBe(true)
      expect(
        INJECTOR_SRC.includes('const body = stripFrontmatterPi(readFileSync(path, \'utf-8\')).trim()'),
        'PS-27 漂移：taiji 展开处双 trim 形态消失（pi 侧 stripFrontmatter(content).trim() 的镜像）——复核 PS-27',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-stdout-fifo.test.ts
// ======================================================================

const RPC_DIST = locatePiDist('pi-coding-agent', 'config.js')

const SKIP_REASON_m2_m2_m2_m2_m2_m2 = RPC_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const count_m2_m2_m2_m2_m2_m2 = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-stdout-fifo', () => {
if (!RPC_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!RPC_DIST)(
  `PS-57 探针：stdout 消息单点 + tail 链串行化（${SKIP_REASON ? `skip：${SKIP_REASON_m2_m2_m2_m2_m2_m2}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(RPC_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')
    const outputGuard = readFileSync(join(RPC_DIST as string, 'core', 'output-guard.js'), 'utf-8')

    it('装置：rpc-mode.js 与 output-guard.js 均可读且非空', () => {
      expect(rpcMode.length, 'rpc-mode.js 读取为空——dist 布局变化，更新本探针路径').toBeGreaterThan(0)
      expect(outputGuard.length, 'output-guard.js 读取为空——dist 布局变化，更新本探针路径').toBeGreaterThan(0)
    })

    it('语义①：rpc-mode 的 output 是唯一出口形态，汇入 writeRawStdout(serializeJsonLine(…))', () => {
      expect(
        rpcMode.includes('writeRawStdout(serializeJsonLine('),
        'PS-57 漂移：rpc-mode.js 中 output → writeRawStdout(serializeJsonLine(…)) 形态消失——' +
          '消息出口改形（换序列化器/换输出通道），stdout 顺序语义须重审。恢复动作：复核 rpc-mode.js ' +
          'output 定义与新出口的顺序保证，确认语义后更新本探针',
      ).toBe(true)
    })

    it('语义②：agent 事件流（含 agent_settled）经同一 output 单点逐条写出', () => {
      expect(
        rpcMode.includes('output(toJsonEvent(event))'),
        'PS-57 漂移：session.subscribe 回调不再经 output(toJsonEvent(event)) 写事件——事件流脱离 ' +
          'output 单点（分通道/直写 stdout），事件与其前后的受理回执消息的顺序保证定位失败。' +
          '恢复动作：复核事件转发路径，确认顺序语义后更新本探针',
      ).toBe(true)
    })

    it('语义③：writeRawStdout 以 promise tail 链串行化（写序 = 调用序的机械保证）', () => {
      expect(
        outputGuard.includes('rawStdoutWriteTail = rawStdoutWriteTail.then('),
        'PS-57 漂移：writeRawStdout 的 tail 链串行化形态消失——写入改为并行/无序（FIFO 前提定位失败），' +
          'notify-once 受理回执先于 agent_settled 处理的保证不复存在。恢复动作：复核 output-guard.js ' +
          '写入机制，若顺序保证由其他机制承担则重写本条 claim 与探针，否则升级为 pi 语义漂移处理',
      ).toBe(true)
    })

    it('语义④：背压重试限流于写入错误码（重试在 tail 链回调内，不改写序）', () => {
      expect(
        count_m2_m2_m2_m2_m2_m2(outputGuard, 'EAGAIN') >= 1 && count_m2_m2_m2_m2_m2_m2(outputGuard, 'ENOBUFS') >= 1,
        'PS-57 漂移：背压重试错误码词表（ENOBUFS/EAGAIN）消失——背压处理机制改形，' +
          'tail 链重试是否仍保序须复核 output-guard.js 后更新本探针',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-steer-drain-cascade.test.ts
// ======================================================================

const CODE_DIST = locatePiDist('pi-coding-agent', 'config.js')

const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')

const SKIP_REASON_m2_m2_m2_m2_m2_m2_d1 =
  CODE_DIST && AGENT_CORE_DIST
    ? ''
    : `node_modules 实装 dist 不可达（coding-agent: ${!CODE_DIST}，agent-core: ${!AGENT_CORE_DIST}）`


const count_m2_m2_m2_m2_m2_m2_d1 = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-steer-drain-cascade', () => {
if (SKIP_REASON_m2_m2_m2_m2_m2_m2_d1) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!CODE_DIST || !AGENT_CORE_DIST)(
  `PS-58 探针：steer busy 入队 + run 循环逐轮排空（${SKIP_REASON ? `skip：${SKIP_REASON_m2_m2_m2_m2_m2_m2_d1}` : ''}）`,
  () => {
    const agentSession = readFileSync(join(CODE_DIST as string, 'core', 'agent-session.js'), 'utf-8')
    const agentLoop = readFileSync(join(AGENT_CORE_DIST as string, 'agent-loop.js'), 'utf-8')

    it('装置：dist 源文件可读且非空', () => {
      expect(agentSession.length, 'agent-session.js 读取为空——dist 布局变化，更新本探针路径').toBeGreaterThan(0)
      expect(agentLoop.length, 'agent-loop.js 读取为空——dist 布局变化，更新本探针路径').toBeGreaterThan(0)
    })

    it('语义①：prompt() isStreaming 分支内 steer 路径走 _queueSteer 入队（busy 不拒绝）', () => {
      const promptWin = methodWindow(agentSession, 'async prompt(text, options) {')
      expect(
        promptWin,
        'PS-58 装置漂移：prompt(text, options) 方法窗口提取为空——方法签名改名/改形，复核后更新 methodWindow 参数',
      ).not.toBe('')
      const isStreamingIdx = promptWin.indexOf('if (this.isStreaming)')
      const steerIdx = promptWin.indexOf('await this._queueSteer(')
      expect(
        isStreamingIdx !== -1 && steerIdx !== -1 && isStreamingIdx < steerIdx,
        'PS-58 漂移：prompt() 的 isStreaming 分支内不再有 _queueSteer 入队调用——busy + steer 语义变化' +
          '（改为拒绝/改走 followUp/异步丢弃），delivery 内核 steer 投递的 busy 兜底失效，injected→settled ' +
          '兑现链须重审。恢复动作：复核 agent-session.js prompt() 分支后更新本探针与 PS-58',
      ).toBe(true)
    })

    it('语义②：_queueSteer 体原样 agent.steer 入队（无 transform 旁路）', () => {
      const queueSteerWin = methodWindow(agentSession, 'async _queueSteer(text, images) {')
      expect(
        queueSteerWin.includes('this.agent.steer('),
        'PS-58 漂移：_queueSteer 不再直接 this.agent.steer( 入队——入队链出现改写/分流，' +
          'steer 消息的原文存活与排空时机须重审。恢复动作：复核 _queueSteer 体后更新本探针',
      ).toBe(true)
    })

    it('语义③：runAgentLoop 恰 3 处 getSteeringMessages poll（run 起始 / preparation 后 / 每轮尾）', () => {
      expect(
        count_m2_m2_m2_m2_m2_m2_d1(agentLoop, 'config.getSteeringMessages'),
        'PS-58 漂移：agent-loop.js 的 getSteeringMessages poll 点数量 ≠ 3——run 循环的排空调度变化，' +
          '「run 存续期间逐轮排空」前提须重审（新增 poll 点 = 排空更及时无害；减少 = busy 窗口 steer ' +
          '悬挂风险上升）。恢复动作：复核 agent-loop.js poll 结构后更新本探针与 PS-58',
      ).toBe(3)
    })

    it('语义④：drain 到的 pending 消息在下一轮响应前注入当前 run（emit + push 上下文）', () => {
      expect(
        agentLoop.includes('currentContext.messages.push(message)') &&
          agentLoop.includes('emit({ type: "message_start", message })'),
        'PS-58 漂移：agent-loop.js 的 pending 消息注入块（message_start emit + currentContext push）消失——' +
          'drain 到的 steer 消息不再进入当前 run 处理，「级联消费 → agent_settled 仍会到达」结论定位失败。' +
          '恢复动作：复核注入块形态后更新本探针',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-steering-drain.test.ts
// ======================================================================

const CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')

const SKIP_REASON_m2_m2_m2_m2 = CORE_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-agent-core/dist 不可达（cwd 上溯 6 级未命中）'


const AGENT_SRC = CORE_DIST ? readFileSync(join(CORE_DIST, 'agent.js'), 'utf-8') : ''

const count_m2 = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-steering-drain', () => {
if (!CORE_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!CORE_DIST)(
  `PS-05 探针：steeringQueue drain 点数量与形态（${SKIP_REASON ? `skip：${SKIP_REASON_m2_m2_m2_m2}` : ''}）`,
  () => {
    it('全文恰好 2 个 steeringQueue.drain() 调用点', () => {
      expect(
        count_m2(AGENT_SRC, 'steeringQueue.drain()'),
        'PS-05 漂移：steeringQueue drain 点数量 ≠ 2——pi 新增/删除了消费点，steer 投递的 at-most-once ' +
          '假设须重评（事故 A F2），复核 docs/pi-semantics.json PS-05 锚点与 session-delivery 账本通道',
      ).toBe(2)
    })

    it('两个 drain 点形态：continue() 路径（queuedSteering 接收）+ run 轮询（getSteeringMessages return）', () => {
      expect(
        AGENT_SRC.includes('const queuedSteering = this.steeringQueue.drain();'),
        'PS-05 漂移：continue() 路径 drain 形态消失——手动续跑的 steering 消费改形，复核 PS-05',
      ).toBe(true)
      expect(
        AGENT_SRC.includes('return this.steeringQueue.drain();'),
        'PS-05 漂移：run 轮询 drain 形态消失——turn 边界消费改形，复核 PS-05',
      ).toBe(true)
    })

    it('steer 入队与清空面存在（enqueue / clear，与 drain 区分的检查锚）', () => {
      expect(AGENT_SRC.includes('steeringQueue.enqueue(') || AGENT_SRC.includes('steeringQueue.enqueue(message'), 'PS-05 漂移：enqueue 形态消失——复核 PS-05').toBe(true)
      expect(AGENT_SRC.includes('steeringQueue.clear()'), 'PS-05 漂移：clear 形态消失——复核 PS-05').toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-thinking-gating.test.ts
// ======================================================================

/** pi-ai 根入口形态（只声明消费到的两个函数；import 失败 = null → skip）。 */
type PiAiModule = {
  getSupportedThinkingLevels?: (model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }) => string[]
  clampThinkingLevel?: (model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }, level: string) => string
}

const piAi: PiAiModule | null = await (async () => {
  try {
    // 经 unknown 收窄：pi-ai 的正式签名要求完整 Model<TApi>，探针只构造最小字段
    //（两函数实读仅 reasoning + thinkingLevelMap）；运行时 guard 见下方 READY 判定
    return (await import('@earendil-works/pi-ai')) as unknown as PiAiModule
  } catch {
    return null
  }
})()

const SKIP_REASON_m2_m2_m2_m2_d1 = piAi
  ? ''
  : '@earendil-works/pi-ai 不可达（node_modules 上溯未命中）'

const READY = Boolean(piAi?.getSupportedThinkingLevels && piAi?.clampThinkingLevel)


/** 最小模型对象：两函数只读 reasoning + thinkingLevelMap（pi-ai dist/models.js 实读核实）。 */
const model = (overrides: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }) => ({
  id: 'probe-model',
  reasoning: undefined,
  ...overrides,
})

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-thinking-gating', () => {
if (!piAi) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!READY)(
  `PS-02 探针：思考能力两级门控（pi-ai 同源函数直调${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_d1}` : ''}）`,
  () => {
    const levels = piAi!.getSupportedThinkingLevels!

    it('reasoning undefined（GUI 手加模型未写该字段的形态）→ ["off"]', () => {
      expect(levels(model({}))).toEqual(['off'])
    })

    it('reasoning: false → ["off"]（第一关不过任何档位钳回 off）', () => {
      expect(levels(model({ reasoning: false, thinkingLevelMap: { high: 'high', max: 'max' } }))).toEqual(['off'])
    })

    it('reasoning: true 且无 thinkingLevelMap → 标准五档（xhigh/max 需显式映射）', () => {
      expect(levels(model({ reasoning: true }))).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    })

    it('thinkingLevelMap 的 null 显式排除档位；undefined 的 xhigh/max 不出现', () => {
      const got = levels(model({ reasoning: true, thinkingLevelMap: { off: 'off', high: 'high', max: null } }))
      expect(got).toContain('high')
      expect(got).not.toContain('max')
      expect(got).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    })
  },
)
describe.skipIf(!READY)(
  `PS-12 探针：档位钳制就近回落（pi-ai 同源函数直调${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_m2_m2_d1}` : ''}）`,
  () => {
    const clamp = piAi!.clampThinkingLevel!

    /** mimo 族形态：支持止于 high（xhigh/max 无显式映射）。 */
    const mimoLike = () => model({ reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' } })

    it('mimo 族设 max → 就近回落 high（事故 B 钳制复现）', () => {
      expect(clamp(mimoLike(), 'max')).toBe('high')
    })

    it('受支持档位原样放行（钳制不碰合法值）', () => {
      expect(clamp(mimoLike(), 'medium')).toBe('medium')
      expect(clamp(mimoLike(), 'high')).toBe('high')
    })

    it('就近向上回退优先于向下（支持 xhigh 的族，max → xhigh 而非 high）', () => {
      const withXhigh = model({
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      })
      expect(clamp(withXhigh, 'max')).toBe('xhigh')
    })

    it('未知请求档位 → 首个可用档兜底（requestedIndex=-1 路径）', () => {
      expect(clamp(mimoLike(), 'bogus-level')).toBe('off')
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-tool-error-flag.test.ts
// ======================================================================

const AGENT_CORE_DIST_m2_m2 = locatePiDist('pi-agent-core', 'agent.js')

const SKIP_REASON_m2_m2 = AGENT_CORE_DIST_m2_m2
  ? ''
  : 'node_modules/@earendil-works/pi-agent-core/dist 不可达（cwd 上溯 6 级未命中）'

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-tool-error-flag', () => {
if (!AGENT_CORE_DIST_m2_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!AGENT_CORE_DIST_m2_m2)(
  `PS-56 探针：正常 return 尊重返回值 isError（=== true 判定）、throw 置 true（${SKIP_REASON ? `skip：${SKIP_REASON_m2_m2}` : ''}）`,
  () => {
    const agentLoopRaw = readFileSync(join(AGENT_CORE_DIST_m2_m2 as string, 'agent-loop.js'), 'utf-8')
    const agentLoop = stripToCode(agentLoopRaw)
    const execFn = extractFunctionBody(agentLoop, 'async function executePreparedToolCall(')

    it('装置：executePreparedToolCall 函数体提取成功（0 = 形态漂移，禁静默放行）', () => {
      expect(
        execFn,
        'PS-56 装置漂移：agent-loop.js 未提取到 executePreparedToolCall 函数体——函数改名/改形，' +
          '恢复动作：复核 agent-loop.js 工具执行段形态后更新本探针定位器',
      ).not.toBeNull()
    })

    it('语义①：正常 return 以 result.isError === true 判定（返回值携带的 isError 字段被尊重）', () => {
      const fn = execFn as string
      expect(
        fn.includes('isError: result.isError === true'),
        'PS-56 漂移：正常 return 不再按 result.isError === true 判定错误——返回值错误标记语义改形' +
          '（回退硬编码丢弃 / 改由调用方判定），扩展在返回值上携带 isError 的语义须重审。' +
          '恢复动作：复核正常路径 return 形态后更新本探针与 PS-56',
      ).toBe(true)
    })

    it('语义②：catch 分支置 isError:true（throw 的错误标记来源不变）', () => {
      const fn = execFn as string
      const catchIdx = fn.indexOf('catch (error)')
      const errFlagIdx = fn.indexOf('isError: true')
      expect(
        catchIdx !== -1 && errFlagIdx > catchIdx,
        'PS-56 漂移：isError: true 不再位于 catch 分支内（W4 throw 范式「错误路径 throw 即呈现」' +
          '前提定位失败）。恢复动作：复核 catch 分支后更新本探针与 PS-56',
      ).toBe(true)
    })

    it('语义③：catch 的 result 经 createErrorToolResult 包装（throw 的 message 进 tool result）', () => {
      const fn = execFn as string
      const wrapped = fn.includes('createErrorToolResult(')
      expect(
        wrapped,
        'PS-56 漂移：catch 分支不再经 createErrorToolResult 包装错误 result——' +
          'throw 的错误信息呈现形态改形，agent 可见错误文本语义须重审。' +
          '恢复动作：复核 catch result 构造后更新本探针与 PS-56',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-ttft-anchors.test.ts
// ======================================================================

const PI_AI_DIST = locatePiDist('pi-ai', 'api')

const AGENT_CORE_DIST_m2_m2_d1 = locatePiDist('pi-agent-core', 'agent.js')

const SKIP_REASON_m2_m2_d1 = PI_AI_DIST && AGENT_CORE_DIST_m2_m2_d1
  ? ''
  : 'node_modules/@earendil-works/{pi-ai,pi-agent-core}/dist 不可达（cwd 上溯 6 级未命中）'


/** 全部出现位置（indexOf 累进）。 */
function allIndices(src: string, marker: string): number[] {
  const out: number[] = []
  let i = -1
  while ((i = src.indexOf(marker, i + 1)) !== -1) out.push(i)
  return out
}


/**
 * 通用不变量：marker 的每个出现位置，向前 window 字符内存在 preceding 之一。
 * 用于「delta 站点前置检查/start 推送」型断言；返回失败位置的序号供报错定位。
 */
function assertEveryPrecededBy(
  src: string,
  marker: string,
  precedings: string[],
  window: number,
  label: string,
  minCount = 1,
): void {
  // 装置下界：marker 计数 < minCount（含整体改名/消失 → 0 处）时显式红——否则后续循环
  // 空转、pi 重写流式实现时整用例保持绿（假绿通路，审查 2026-10-03 补封）
  const all = allIndices(src, marker)
  expect(
    all.length,
    `PS-47 装置（${label}）："${marker}" 在场 ${all.length} 处 < 下界 ${minCount}——事件串改名或流式实现重写，复核 pi-ai`,
  ).toBeGreaterThanOrEqual(minCount)
  for (const [n, idx] of all.entries()) {
    const before = src.slice(Math.max(0, idx - window), idx)
    const ok = precedings.some((p) => before.includes(p))
    expect(
      ok,
      `PS-47 漂移（${label}）：第 ${n + 1} 处 "${marker}" 向前 ${window} 字符内无 [${precedings.join(' / ')}]——该 delta 站点可能脱离对应 *_start 保障，复核 pi-ai 流式实现`,
    ).toBe(true)
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-ttft-anchors', () => {
if (SKIP_REASON_m2_m2_d1) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(SKIP_REASON_m2_m2_d1 !== '')(
  `PS-46 探针：turn_start 逐 LLM 请求 emit（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_d1}` : ''}）`,
  () => {
    const agentLoop = readFileSync(join(AGENT_CORE_DIST_m2_m2_d1 as string, 'agent-loop.js'), 'utf-8')
    // 顶层函数切片：非贪婪至行首 `}`（同 PS-25 runLoop 切片范式）
    const runAgentLoopBody = /export async function runAgentLoop\(prompts[\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const runAgentLoopContinueBody = /export async function runAgentLoopContinue\([\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const runLoopBody = /async function runLoop\(initialContext[\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const streamBody = /async function streamAssistantResponse\([\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''

    it('A1 首个请求：runAgentLoop 入口 agent_start 后、runLoop 调用前恰发一次 turn_start', () => {
      expect(runAgentLoopBody, 'PS-46 漂移：runAgentLoop 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      const startIdx = runAgentLoopBody.indexOf('await emit({ type: "turn_start" });')
      const agentStartIdx = runAgentLoopBody.indexOf('await emit({ type: "agent_start" });')
      const runLoopCallIdx = runAgentLoopBody.indexOf('await runLoop(')
      expect(startIdx, 'PS-46 漂移：runAgentLoop 入口不再 emit turn_start——首个 LLM 请求失去起算锚点').toBeGreaterThan(-1)
      expect(agentStartIdx).toBeGreaterThan(-1)
      expect(runLoopCallIdx).toBeGreaterThan(-1)
      expect(
        agentStartIdx < startIdx && startIdx < runLoopCallIdx,
        'PS-46 漂移：runAgentLoop 的 turn_start 不再位于 agent_start 与 runLoop 之间——复核 agent-loop.js',
      ).toBe(true)
      expect(
        allIndices(runAgentLoopBody, 'type: "turn_start"').length,
        'PS-46 漂移：runAgentLoop 内 turn_start 出现次数 ≠ 1——逐请求锚点前提变化',
      ).toBe(1)
    })

    it('A2 重试续跑：runAgentLoopContinue 入口同款（agent_start 后、runLoop 前）', () => {
      expect(runAgentLoopContinueBody, 'PS-46 漂移：runAgentLoopContinue 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      const startIdx = runAgentLoopContinueBody.indexOf('await emit({ type: "turn_start" });')
      const agentStartIdx = runAgentLoopContinueBody.indexOf('await emit({ type: "agent_start" });')
      const runLoopCallIdx = runAgentLoopContinueBody.indexOf('await runLoop(')
      expect(startIdx, 'PS-46 漂移：runAgentLoopContinue 入口不再 emit turn_start——重试轮失去起算锚点').toBeGreaterThan(-1)
      // 存在性断言与 A1 对称：-1 参与序断言恒真（agent_start 消失/移位时不红），单独钉住
      expect(agentStartIdx, 'PS-46 漂移：runAgentLoopContinue 入口不再 emit agent_start——复核 agent-loop.js').toBeGreaterThan(-1)
      expect(runLoopCallIdx, 'PS-46 漂移：runAgentLoopContinue 不再调用 runLoop——复核 agent-loop.js').toBeGreaterThan(-1)
      expect(
        agentStartIdx < startIdx && startIdx < runLoopCallIdx,
        'PS-46 漂移：runAgentLoopContinue 的 turn_start 位置变化——复核 agent-loop.js',
      ).toBe(true)
      expect(
        allIndices(runAgentLoopContinueBody, 'type: "turn_start"').length,
        'PS-46 漂移：runAgentLoopContinue 内 turn_start 出现次数 ≠ 1——逐请求锚点前提变化',
      ).toBe(1)
    })

    it('A3 工具循环后续轮：prepareNextTurn 之后、steering 注入与流式调用之前恰发一次 turn_start', () => {
      expect(runLoopBody, 'PS-46 漂移：runLoop 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      // runLoop 内唯一发射点，且位于 lastCompletedTurn 检查内（首轮入口锚由 A1/A2 承担）
      expect(
        allIndices(runLoopBody, 'type: "turn_start"').length,
        'PS-46 漂移：runLoop 内 turn_start 出现次数 ≠ 1——逐请求锚点前提变化',
      ).toBe(1)
      const turnStartIdx = runLoopBody.indexOf('await emit({ type: "turn_start" });')
      const prepareIdx = runLoopBody.indexOf('await config.prepareNextTurn?.(lastCompletedTurn);')
      // pi 1.0.0：steering 注入循环头 = declareToolChanges 包裹（prepared + pending 合并注入）
      const steeringIdx = runLoopBody.indexOf('for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {')
      const streamCallIdx = runLoopBody.indexOf('const message = await streamAssistantResponse(')
      expect(prepareIdx, 'PS-46 漂移：prepareNextTurn 调用点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
      expect(steeringIdx, 'PS-46 漂移：steering 注入循环消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
      expect(streamCallIdx, 'PS-46 漂移：streamAssistantResponse 调用点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
      // 时序四元组：原生 compaction（prepareNextTurn 内）先于锚点 → 不含 TTFT 窗口；
      // 锚点先于 steering 注入与流式调用 → 两者计入窗口（设计 §3.2 窗口构成）
      expect(
        prepareIdx < turnStartIdx && turnStartIdx < steeringIdx && steeringIdx < streamCallIdx,
        'PS-46 漂移：turn_start 不再位于 prepareNextTurn 之后、steering 注入/流式调用之前——TTFT 窗口构成前提（不含原生压缩与工具执行）破裂，复核 agent-loop.js runLoop',
      ).toBe(true)
    })

    it('A4 流式函数内无 turn_start（锚点严格先于全部输出信号）', () => {
      expect(streamBody, 'PS-46 漂移：streamAssistantResponse 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
      expect(
        streamBody.includes('type: "turn_start"'),
        'PS-46 漂移：streamAssistantResponse 内出现 turn_start emit——锚点可能晚于输出信号，复核 agent-loop.js',
      ).toBe(false)
    })
  },
)
describe.skipIf(SKIP_REASON_m2_m2_d1 !== '')(
  `PS-47 探针：pi-ai 全族流式实现凡产 delta 必先产对应 *_start（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m2_d1}` : ''}）`,
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
        // 装置下界：三锚串整体消失（流式实现重写）时显式红，防循环空转绿
        expect(
          allIndices(src, 'blocks.push(').length,
          'PS-47 装置：openai-completions "blocks.push(" 不足 3 处——block 创建点形态变化，复核 pi-ai',
        ).toBeGreaterThanOrEqual(3)
        for (const [push, start] of pairs) {
          for (const idx of allIndices(src, push)) {
            const after = src.slice(idx, idx + 120)
            expect(
              after.includes(start),
              `PS-47 漂移：openai-completions "${push}" 后 120 字符内无 "${start}"——block 创建不再同步播报 start`,
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
    describe('openai-responses-shared：createSlot 播报 *_start，delta 站点经 getSlot 存在性检查', () => {
      const src = read('openai-responses-shared.js')
      const createSlotBody = src.slice(src.indexOf('const createSlot = (outputIndex, item) => {'), src.indexOf('const getOrCreateSlot = (outputIndex, item) => {'))

      it('createSlot 三个创建分支（reasoning/message/function_call|custom）各播报对应 *_start', () => {
        expect(createSlotBody, 'PS-47 漂移：createSlot 切片为空——复核 openai-responses-shared.js 结构').not.toBe('')
        expect(createSlotBody).toContain('type: "thinking_start"')
        expect(createSlotBody).toContain('type: "text_start"')
        expect(createSlotBody, 'createSlot 不再播报 toolcall_start（或函数切片错位）').toContain('type: "toolcall_start"')
        // getSlot 类型不匹配返回 undefined → delta 站点 if (!slot) continue 检查成立的前提
        expect(
          src.includes('return slot?.type === type ? slot : undefined;'),
          'PS-47 漂移：getSlot 不再按存在性+类型返回 undefined——delta 检查前提破裂，复核 openai-responses-shared.js',
        ).toBe(true)
      })

      it('text/thinking delta 站点前置 getSlot 存在性取槽；toolcall delta 经 pushToolCallDelta(slot) 助手（slot 同源）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['getSlot(event.output_index, "text")'], 350, 'responses text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['getSlot(event.output_index, "thinking")'], 350, 'responses thinking_delta')
        // 助手本体推送 toolcall_delta；调用点全部传 slot（getSlot/getOrCreateSlot 取得，
        // 前置检查见各站点 if (!slot) continue）
        const helper = /const pushToolCallDelta = \(slot, delta\) => \{[\s\S]*?type: "toolcall_delta"/.exec(src)
        expect(helper, 'PS-47 漂移：pushToolCallDelta 助手消失或不再推送 toolcall_delta——复核 openai-responses-shared.js').not.toBeNull()
        const callSites = allIndices(src, 'pushToolCallDelta(').length
        expect(callSites, 'pushToolCallDelta 调用点数量异常（含定义应为 6）').toBeGreaterThanOrEqual(5)
      })
    })

    // ── ② anthropic-messages：content_block_start 建块播报 / delta 按 index 查块 + 类型检查 ──
    describe('anthropic-messages：delta 分支按 index 查块 + 类型检查（块只在 start 分支创建）', () => {
      const src = read('anthropic-messages.js')
      const startBranch = src.slice(src.indexOf('else if (event.type === "content_block_start") {'), src.indexOf('else if (event.type === "content_block_delta") {'))

      it('content_block_start 分支建块即播报三种 *_start', () => {
        expect(startBranch, 'PS-47 漂移：content_block_start 分支切片为空——复核 anthropic-messages.js 结构').not.toBe('')
        expect(startBranch).toContain('type: "text_start"')
        expect(startBranch).toContain('type: "thinking_start"')
        expect(startBranch).toContain('type: "toolcall_start"')
        // blocks = output.content 别名存在（delta 查块与 start 建块同一数组）
        expect(src).toContain('const blocks = output.content;')
      })

      it('delta 站点全部前置 findIndex 查块 + block 类型检查（无块不产 delta）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['block && block.type === "text"'], 400, 'anthropic text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['block && block.type === "thinking"'], 400, 'anthropic thinking_delta')
        assertEveryPrecededBy(src, 'type: "toolcall_delta"', ['block && block.type === "toolCall"'], 400, 'anthropic toolcall_delta')
      })
    })

    // ── ② bedrock-converse-stream：start 处理器建 toolCall 块播报 / delta 处理器检查建块 ──
    describe('bedrock-converse-stream：handleContentBlockStart 播报 toolcall_start，delta 处理器无块先建块播报', () => {
      const src = read('bedrock-converse-stream.js')
      const startIdx = src.indexOf('function handleContentBlockStart')
      const deltaIdx = src.indexOf('function handleContentBlockDelta')
      // 文件内函数序：Start 在前 Delta 在后；delta 几体切到下一个顶层 function 声明
      const deltaFn = src.slice(deltaIdx, deltaIdx === -1 ? undefined : src.indexOf('\nfunction ', deltaIdx + 1))

      it('toolUse 块唯一创建点（handleContentBlockStart）播报 toolcall_start', () => {
        const startFn = src.slice(startIdx, deltaIdx)
        expect(startFn, 'PS-47 漂移：handleContentBlockStart 切片为空——复核 bedrock-converse-stream.js 结构').not.toBe('')
        expect(startFn, 'toolUse 块创建不再播报 toolcall_start').toContain('type: "toolcall_start"')
      })

      it('text delta 无块先建块播报 text_start；toolcall delta 前置既有 toolCall 块检查；thinking 分支含建块播报', () => {
        expect(deltaFn, 'PS-47 漂移：handleContentBlockDelta 切片为空——复核 bedrock-converse-stream.js 结构').not.toBe('')
        expect(
          /if \(!block\) \{[\s\S]{0,250}type: "text_start"[\s\S]{0,200}type: "text_delta"/.test(deltaFn),
          'PS-47 漂移：text delta 不再走「无块先建块播报 text_start」路径，复核 handleContentBlockDelta',
        ).toBe(true)
        expect(
          /else if \(delta\?\.toolUse && block\?\.type === "toolCall"\) \{[\s\S]{0,400}type: "toolcall_delta"/.test(deltaFn),
          'PS-47 漂移：toolcall delta 失去既有 toolCall 块检查（块由 start 处理器创建并播报）——复核 handleContentBlockDelta',
        ).toBe(true)
        expect(
          /else if \(delta\?\.reasoningContent\) \{[\s\S]*?if \(!thinkingBlock\) \{[\s\S]{0,300}type: "thinking_start"/.test(deltaFn),
          'PS-47 漂移：reasoning 分支不再「无 thinking 块先建块播报 thinking_start」——复核 handleContentBlockDelta',
        ).toBe(true)
      })
    })

    // ── ③ google-generative-ai / mistral-conversations：检查分支紧邻建块播报 ──
    describe('google-generative-ai：!currentBlock 建块分支播报 *_start 与 delta 同迭代', () => {
      const src = read('google-generative-ai.js')

      it('delta 站点前置同迭代建块播报（text/thinking/toolcall）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['type: "text_start"'], 1300, 'google text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['type: "thinking_start"'], 1300, 'google thinking_delta')
        assertEveryPrecededBy(src, 'type: "toolcall_delta"', ['type: "toolcall_start"'], 400, 'google toolcall_delta')
      })
    })

    describe('mistral-conversations：检查分支建块播报 *_start 与 delta 紧邻', () => {
      const src = read('mistral-conversations.js')

      it('delta 站点前置建块播报（text/thinking/toolcall）', () => {
        assertEveryPrecededBy(src, 'type: "text_delta"', ['type: "text_start"'], 300, 'mistral text_delta')
        assertEveryPrecededBy(src, 'type: "thinking_delta"', ['type: "thinking_start"'], 300, 'mistral thinking_delta')
        assertEveryPrecededBy(src, 'type: "toolcall_delta"', ['type: "toolcall_start"'], 600, 'mistral toolcall_delta')
      })
    })

    // ── 全族覆盖：responses 系包装实现委托 processResponsesStream（无独立流式实现）──
    it('openai-responses 系包装（codex / azure）委托 openai-responses-shared 的 processResponsesStream', () => {
      for (const f of ['openai-codex-responses.js', 'azure-openai-responses.js']) {
        const src = read(f)
        expect(
          src.includes('processResponsesStream'),
          `PS-47 漂移：${f} 不再委托 openai-responses-shared.processResponsesStream——出现独立流式实现，需为其补 *_start 前提探针`,
        ).toBe(true)
      }
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-turn-usage-model.test.ts
// ======================================================================

const PI_AI_DIST_m2 = locatePiDist('pi-ai', 'models.js')

const AGENT_CORE_DIST_m2 = locatePiDist('pi-agent-core', 'agent.js')

const CODING_AGENT_DIST = locatePiDist('pi-coding-agent', 'config.js')

const SKIP_REASON_m2 = PI_AI_DIST_m2 && AGENT_CORE_DIST_m2 && CODING_AGENT_DIST
  ? ''
  : 'node_modules/@earendil-works/{pi-ai,pi-agent-core,pi-coding-agent}/dist 不可达（cwd 上溯 6 级未命中）'

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-turn-usage-model', () => {
if (SKIP_REASON_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(SKIP_REASON_m2 !== '')(
  `PS-25 探针：turn_end.message AssistantMessage 结构与 model 语义（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON_m2}` : ''}）`,
  () => {
    const typesDts = readFileSync(join(PI_AI_DIST_m2 as string, 'types.d.ts'), 'utf-8')
    const openaiCompletions = readFileSync(join(PI_AI_DIST_m2 as string, 'api', 'openai-completions.js'), 'utf-8')
    const agentCore = readFileSync(join(AGENT_CORE_DIST_m2 as string, 'agent.js'), 'utf-8')
    const agentLoop = readFileSync(join(AGENT_CORE_DIST_m2 as string, 'agent-loop.js'), 'utf-8')
    const agentSession = readFileSync(join(CODING_AGENT_DIST as string, 'core', 'agent-session.js'), 'utf-8')
    const jsonEvent = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'json-event.js'), 'utf-8')
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('pi-ai AssistantMessage：provider/model/usage 必填自带，responseModel 可选', () => {
      const m = /export interface AssistantMessage \{[\s\S]*?\n\}/.exec(typesDts)  // oe-exempt:20261027:test:
      expect(m, 'PS-25 漂移：pi-ai AssistantMessage 接口声明消失——复核 dist/types.d.ts 锚点').not.toBeNull()
      const body = m![0]
      // 必填三件套（gen-stats 扩展字段的类型层依据）
      expect(body, 'provider 必填字段消失').toMatch(/^\s{4}provider: ProviderId;$/m)
      expect(body, 'model 必填字段消失').toMatch(/^\s{4}model: string;$/m)
      expect(body, 'usage 必填字段消失').toMatch(/^\s{4}usage: Usage;$/m)
      // responseModel 可选（≠ model 语义：实际响应模型，多数 provider 恒缺）
      expect(body, 'responseModel 可选声明消失（若改为必填，PS-25 裁定前提变化，须重新登记）').toMatch(/^\s{4}responseModel\?: string;$/m)
    })

    it('pi-ai Usage：input/output/cacheRead/cacheWrite/totalTokens 全必填 number', () => {
      const m = /export interface Usage \{[\s\S]*?\n\}/.exec(typesDts)  // oe-exempt:20261027:test:
      expect(m, 'PS-25 漂移：pi-ai Usage 接口声明消失——复核 dist/types.d.ts 锚点').not.toBeNull()
      const body = m![0]
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
        expect(body, `Usage.${field} 必填 number 声明消失`).toMatch(new RegExp(`^\\s{4}${field}: number;$`, 'm'))
      }
    })

    it('pi-ai openai-completions：AssistantMessage 构造 model=model.id / provider=model.provider；responseModel 仅在 chunk.model≠请求 id 时设置', () => {
      // 构造点：流式 output 对象初始化（请求侧 id，非 provider 报告值）
      expect(
        openaiCompletions.includes('provider: model.provider,'),
        'PS-25 漂移：构造点 provider 不再取 model.provider——AssistantMessage.provider 语义变化，复核 PS-25',
      ).toBe(true)
      expect(
        openaiCompletions.includes('model: model.id,'),
        'PS-25 漂移：构造点 model 不再取 model.id——AssistantMessage.model 语义变化（这是「请求侧模型」裁定的承重锚点）',
      ).toBe(true)
      // responseModel 唯一赋值点：条件 chunk.model !== model.id（实际响应模型 ≠ 请求 id 才记录）
      const assign = /if \(typeof chunk\.model === "string" && chunk\.model\.length > 0 && chunk\.model !== model\.id\) \{\s*\n\s*output\.responseModel \|\|= chunk\.model;/.exec(openaiCompletions)
      expect(
        assign,
        'PS-25 漂移：responseModel 赋值条件改变（不再限定于 provider 报告模型≠请求 id）——responseModel 语义复核',
      ).not.toBeNull()
    })

    it('pi-agent-core agent-loop：turn_end.message = streamAssistantResponse 产物（正常路径恒 AssistantMessage）', () => {
      expect(
        agentLoop.includes('const message = await streamAssistantResponse('),
        'PS-25 漂移：turn 消息不再产自 streamAssistantResponse——复核 agent-loop.js',
      ).toBe(true)
      expect(
        /await emit\(\{ type: "turn_end", message, toolResults: \[\] \}\);/.test(agentLoop) &&
        /await emit\(\{ type: "turn_end", message, toolResults \}\);/.test(agentLoop),
        'PS-25 漂移：turn_end 发射点不再携带 streamAssistantResponse 的 message——复核 agent-loop.js 两个发射分支',
      ).toBe(true)
    })

    it('pi-agent-core handleRunFailure：失败路径合成 failureMessage 同 AssistantMessage 形态 + EMPTY_USAGE 全 0', () => {
      // EMPTY_USAGE：totalTokens=0 → taiji runtime 的 usage.totalTokens gate 丢弃失败 turn（不产 gen-stats 样本）
      const emptyUsage = /const EMPTY_USAGE = \{[\s\S]*?\};/.exec(agentCore)
      expect(emptyUsage, 'PS-25 漂移：EMPTY_USAGE 常量消失——复核 agent.js').not.toBeNull()
      expect(emptyUsage![0], 'EMPTY_USAGE.totalTokens 不再为 0——失败 turn 将穿过 runtime totalTokens gate，须重审 gen-stats 丢弃语义').toMatch(/totalTokens: 0/)
      // failureMessage：model/provider 取请求侧 state.model，usage = EMPTY_USAGE
      const failure = /const failureMessage = \{[\s\S]*?\n\s{8}\};/.exec(agentCore)
      expect(failure, 'PS-25 漂移：handleRunFailure.failureMessage 构造消失——复核 agent.js').not.toBeNull()
      const body = failure![0]
      expect(body, '失败路径 model 不再取 _state.model.id').toMatch(/model: this\._state\.model\.id,/)
      expect(body, '失败路径 provider 不再取 _state.model.provider').toMatch(/provider: this\._state\.model\.provider,/)
      expect(body, '失败路径 usage 不再是 EMPTY_USAGE').toMatch(/usage: EMPTY_USAGE,/)
      expect(
        agentCore.includes('await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });'),
        'PS-25 漂移：失败路径不再发射 turn_end——复核 agent.js handleRunFailure',
      ).toBe(true)
    })

    it('pi-coding-agent agent-session：turn_end 原样透传 listeners（仅 agent_end 附加 willRetry）', () => {
      expect(
        agentSession.includes('this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);'),
        'PS-25 漂移：_handleAgentEvent 的 listener 透传形态改变（turn_end 不再原样 _emit）——复核 agent-session.js',
      ).toBe(true)
      // 扩展事件形态（pi 1.0.0：_emitExtensionEvent 的 turn_end 分支改经 _dispatchTurnEndBoundary
      // → emitBoundary 下发，message 原样简写引用 + 新增 messageEntryId/toolResultEntryIds/outcome；
      // listener 面 _emit 透传不变，此为扩展订阅侧形态）
      const ext = /const boundary = await this\._extensionRunner\.emitBoundary\(\{\s*\n\s*type: "turn_end",\s*\n\s*turnIndex: this\._turnIndex,\s*\n\s*message,\s*\n\s*toolResults,\s*\n\s*messageEntryId,\s*\n\s*toolResultEntryIds,\s*\n\s*outcome: this\._lastActivityOutcome,/.exec(agentSession)
      expect(ext, 'PS-25 漂移：turn_end 扩展 boundary（emitBoundary）不再原样引用 message——扩展字段字段被重写/裁剪').not.toBeNull()
    })

    it('pi-coding-agent RPC 通路：toJsonEvent 非 message_update 原样返回 + rpc-mode 经其下发全部 session 事件', () => {
      expect(
        jsonEvent.includes('if (event.type !== "message_update") {'),
        'PS-25 漂移：toJsonEvent 的原样透传分支消失——turn_end RPC 下发形态改变，复核 modes/json-event.js',
      ).toBe(true)
      expect(
        /if \(event\.type !== "message_update"\) \{\s*\n\s*return event;/.test(jsonEvent),
        'PS-25 漂移：toJsonEvent 非 message_update 不再 return event 原样——AssistantMessage 附加字段可能在 RPC 下发时被裁剪',
      ).toBe(true)
      expect(
        rpcMode.includes('output(toJsonEvent(event));'),
        'PS-25 漂移：rpc-mode 不再经 toJsonEvent 下发 session 事件——复核 modes/rpc/rpc-mode.js subscribe 段',
      ).toBe(true)
    })

    // ── genstats-speed-llm-window 探针组：LLM 请求窗口时序契约（设计 §2.4 P1/P3①/P3②/P4）──
    // 函数体切片依据：dist 编译产物顶层函数以行首 `}` 收尾、agent.js 类方法以 4 空格 `}` 收尾，
    // 非贪婪切片在首个匹配收尾符处安全截断（同文件 PS-25 接口切片同范式）。
    const runLoopBody = /async function runLoop\([\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const streamBody = /async function streamAssistantResponse\([\s\S]*?\n\}/.exec(agentLoop)?.[0] ?? ''
    const handleFailureBody = /    async handleRunFailure\(error, aborted\) \{[\s\S]*?\n    \}/.exec(agentCore)?.[0] ?? ''

    describe('genstats-speed-llm-window 探针：LLM 请求窗口时序契约 P1/P3①/P3②/P4（静态断言）', () => {
      it('P1：成功路径 assistant message_end 先于 turn_end（流式收敛结构 + runLoop 直线序）', () => {
        expect(runLoopBody, 'P1 锚点漂移：runLoop 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
        expect(streamBody, 'P1 锚点漂移：streamAssistantResponse 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
        // ① 流式函数内不出现 turn_end：封窗信号必在流结束（message_end 已 emit）之后由 runLoop 发出
        expect(
          streamBody.includes('type: "turn_end"'),
          'P1 漂移：streamAssistantResponse 内部出现 turn_end emit——message_end 先于 turn_end 的窗口封闭契约破裂，复核 agent-loop.js',
        ).toBe(false)
        // ② 双收敛点（done/error case + for-await 循环后兜底）均以 message_end 为返回前最后动作
        const convergences = streamBody.match(/await emit\(\{ type: "message_end", message: finalMessage \}\);\s*\n\s*return finalMessage;/g) ?? []
        expect(
          convergences.length,
          'P1 漂移：流式收敛点不再以 message_end 为返回前最后 emit（done/error 收敛 + 循环后兜底应各一处）——复核 agent-loop.js streamAssistantResponse 收敛段',
        ).toBe(2)
        // ③ runLoop 直线序：streamAssistantResponse 调用（内部必以 message_end 收敛）先于成功路径 turn_end
        const callIdx = runLoopBody.indexOf('const message = await streamAssistantResponse(')
        const turnEndIdx = runLoopBody.indexOf('await emit({ type: "turn_end", message, toolResults })')
        expect(callIdx, 'P1 锚点漂移：streamAssistantResponse 调用点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
        expect(turnEndIdx, 'P1 锚点漂移：成功路径 turn_end(toolResults) 发射点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
        expect(
          callIdx < turnEndIdx,
          'P1 漂移：成功路径 turn_end 不再位于 streamAssistantResponse 之后——assistant message_end 先于 turn_end 的窗口封闭前提破裂，复核 agent-loop.js runLoop 直线序',
        ).toBe(true)
      })

      it('P3①：error/aborted 分支——真实 partial message 的 message_end（流内收敛）先于 turn_end(空工具结果) + return', () => {
        expect(streamBody, 'P3① 锚点漂移：streamAssistantResponse 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
        expect(runLoopBody, 'P3① 锚点漂移：runLoop 函数体切片为空——复核 agent-loop.js 结构').not.toBe('')
        // 流内 error 事件与 done 同 case：result() 闭包（pi 1.0.0：response.result() 包装
        // thinkingLevel 附加后返回）取真实 partial message 并 emit message_end 后返回
        expect(
          /case "done":\s*\n\s*case "error": \{\s*\n\s*const finalMessage = await result\(\);[\s\S]*?await emit\(\{ type: "message_end", message: finalMessage \}\);\s*\n\s*return finalMessage;/.test(streamBody),
          'P3① 漂移：流 error 事件不再收敛出真实 partial message 的 message_end——Esc 中断的「部分流窗口」样本前提破裂，复核 agent-loop.js case "error" 段',
        ).toBe(true)
        // runLoop 分支：stopReason error/aborted → finishTurn 钩子（pi 1.0.0 起失败轮也触发，
        // 扩展 boundary 可表决续跑）→ turn_end(toolResults:[]) → agent_end → return
        expect(
          /if \(message\.stopReason === "error" \|\| message\.stopReason === "aborted"\) \{\s*\n\s*lastCompletedTurn = \{\s*\n\s*message,\s*\n\s*toolResults: \[\],\s*\n\s*context: currentContext,\s*\n\s*newMessages,\s*\n\s*\};\s*\n\s*await config\.finishTurn\?\.\(lastCompletedTurn, signal\);\s*\n\s*await emit\(\{ type: "turn_end", message, toolResults: \[\] \}\);\s*\n\s*await emit\(\{ type: "agent_end", messages: newMessages \}\);\s*\n\s*return;/.test(runLoopBody),
          'P3① 漂移：error/aborted 分支不再是「finishTurn → turn_end(空工具结果) → agent_end → return」结构——复核 agent-loop.js',
        ).toBe(true)
      })

      it('P3②：handleRunFailure 合成四事件序（start→end→turn_end→agent_end）+ failureMessage 形态（assistant role/空 text/EMPTY_USAGE/stopReason 三元）', () => {
        expect(handleFailureBody, 'P3② 锚点漂移：handleRunFailure 方法体切片为空——复核 agent.js 结构').not.toBe('')
        const failure = /const failureMessage = \{[\s\S]*?\n\s{8}\};/.exec(handleFailureBody)
        expect(failure, 'P3② 漂移：failureMessage 构造消失——复核 agent.js handleRunFailure').not.toBeNull()
        const body = failure![0]
        expect(body, 'failureMessage.role 不再是 assistant').toMatch(/role: "assistant",/)
        expect(body, 'failureMessage.content 不再是空文本 text（合成 message_end 将携带非空内容）').toMatch(/content: \[\{ type: "text", text: "" \}\],/)
        expect(body, 'failureMessage.usage 不再引用 EMPTY_USAGE（runtime totalTokens gate 依赖其丢弃合成 turn 的样本）').toMatch(/usage: EMPTY_USAGE,/)
        expect(body, 'failureMessage.stopReason 不再是 aborted?"aborted":"error" 三元').toMatch(/stopReason: aborted \? "aborted" : "error",/)
        // 合成四事件：message_start → message_end → turn_end → agent_end 依次 processEvents
        const seq = [
          'await this.processEvents({ type: "message_start", message: failureMessage });',
          'await this.processEvents({ type: "message_end", message: failureMessage });',
          'await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });',
          'await this.processEvents({ type: "agent_end", messages: [failureMessage] });',
        ].map((s) => handleFailureBody.indexOf(s))
        for (const [i, idx] of seq.entries()) {
          expect(idx, `P3② 锚点漂移：合成事件 #${i + 1}（start/end/turn_end/agent_end）形态改变——复核 agent.js handleRunFailure`).toBeGreaterThan(-1)
        }
        expect(
          seq[0]! < seq[1]! && seq[1]! < seq[2]! && seq[2]! < seq[3]!,
          'P3② 漂移：合成四事件不再按 message_start → message_end → turn_end → agent_end 顺序发射——复核 agent.js handleRunFailure',
        ).toBe(true)
      })

      it('P4：内层循环每 turn 迭代恰一次 streamAssistantResponse 调用（调用点全文件唯一 + 内层 while 直线体）', () => {
        // 全文件唯一调用点（函数定义行无 await 前缀，不重复计数）
        const calls = agentLoop.match(/await streamAssistantResponse\(/g) ?? []
        expect(
          calls.length,
          'P4 漂移：streamAssistantResponse 调用点不再唯一——每 turn 恰一次 LLM 请求的 1:1 配对前提破裂，新口径将产「末窗口 × 全 turn tokens」静默偏高样本，复核 agent-loop.js',
        ).toBe(1)
        // 调用点位于 runLoop 内层 while 直线体：while 头 → turn_start/steering 注入 → 唯一流式调用（无条件执行）
        // pi 1.0.0：steering 注入循环头 = declareToolChanges 包裹（prepared + pending 合并注入）
        const whileIdx = runLoopBody.indexOf('while (hasMoreToolCalls || pendingMessages.length > 0) {')
        const steeringIdx = runLoopBody.indexOf('for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {')
        const callIdx = runLoopBody.indexOf('const message = await streamAssistantResponse(')
        expect(whileIdx, 'P4 锚点漂移：内层 while 条件结构改变——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
        expect(steeringIdx, 'P4 锚点漂移：steering 注入循环消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
        expect(callIdx, 'P4 锚点漂移：streamAssistantResponse 调用点消失——复核 agent-loop.js runLoop').toBeGreaterThan(-1)
        expect(
          whileIdx < steeringIdx && steeringIdx < callIdx,
          'P4 漂移：steering 注入与流式调用的次序改变（设计前提：steering 只注入 user 消息、发生在 turn_start 与 streaming 之间，不产生 assistant message）——复核 agent-loop.js runLoop',
        ).toBe(true)
      })
    })
  },
)
});
