/**
 * PS-71 探针：pi-coding-agent 扩展命令 handler 抛错的 extension_error 载荷标记契约
 * （pi1-disposition-chat-flow D10③ —— errorEvent === 'command' 过滤判据的值域锚定，
 * 与 D5③ 文案锚定（PS-22/23）同形态）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-71「命令 handler 抛错 → emitError 恒 event:"command" + extensionPath
 *   "command:<命令名>" 模板」——runtime event-adapter handleExtensionError 原样透传为
 *   extension.error WS 消息的 errorEvent 字段（extensionPath 改名 extensionName）；
 *   packages/core/src/domain/chat/useChat.ts handleExtensionErrorFrame 以
 *   `errorEvent !== 'command'` 做命令失败 toast 的放行过滤（非命令来源静默，D10③），
 *   并以 extensionName 的 "command:" 前缀剥出可读命令名。
 *
 * 断言方式（P-D1 代码形态断言，与 PS-22/23 同族）：静态直读
 * dist/core/agent-session.js 的 _tryExecuteExtensionCommand catch 分支，标记值全文件
 * 唯一性 + 所属分支位置断言，失真即红。dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS
 * 分池。pi 升级红 = 标记值/载荷形态漂移 → useChat.ts 过滤静默失效（命令失败零反馈，
 * D10③ 盲区回归）。处置流程与 pi-rejection 同族：先复核锚点 dist/core/agent-session.js
 * _tryExecuteExtensionCommand catch 分支 → 同步 useChat.ts 的 'command' 判据值与
 * "command:" 前缀剥离（过滤判据与展示名两个消费点都挂在该载荷上）→ 全绿后更新
 * docs/pi-semantics.json 本条 verifiedWith。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-extension-command-error.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
  `PS-71 探针：命令 handler 抛错的 event 标记值 = "command"（D10③ 过滤判据值域锚定${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('catch 分支恒产 event:"command" + extensionPath "command:<名>" 模板，且 "command" 值全文件唯一（非命令来源不共用该值）', () => {
      const win = methodWindow(SESSION_SRC, 'async _tryExecuteExtensionCommand(text) {')
      expect(
        win,
        'PS-71 漂移：_tryExecuteExtensionCommand 方法消失/改签名——复核 PS-71 锚 dist/core/agent-session.js _tryExecuteExtensionCommand',
      ).not.toBe('')

      // 标记值全文件恰出现 1 次（值域唯一性：其他错误来源共用该值 = 过滤判据把非命令
      // 错误也放进 toast；标记值改名 = 判据静默失效、命令失败零反馈——两个方向都红）
      expect(
        count(SESSION_SRC, 'event: "command"'),
        'PS-71 漂移：event:"command" 标记值数量变化——useChat.ts 的 errorEvent !== \'command\' 过滤判据失效（命令失败零 toast，D10③ 盲区回归）；处置流程与 pi-rejection 同族：复核 dist _tryExecuteExtensionCommand catch 分支 → 同步 useChat.ts 判据值 → 更新 docs/pi-semantics.json PS-71 verifiedWith',
      ).toBe(1)

      // 分支位置：该标记值位于方法窗口内 catch 分支的 emitError 载荷中（不在 catch 内 =
      // 错误来源改形，过滤语义须复审）
      const catchIdx = win.indexOf('catch (err) {')
      expect(
        catchIdx,
        'PS-71 漂移：handler 抛错不再走 catch 分支（错误吞掉或改走别的上报面？）——复核 PS-71',
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
