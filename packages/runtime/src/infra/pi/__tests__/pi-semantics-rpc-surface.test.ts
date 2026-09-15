/**
 * PS-03 / PS-10 探针：pi RPC 面——set_thinking_level 无 data + get_available_models 全属性（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-03「set_thinking_level RPC 响应无 data（仅 success）；生效值须 set 后 get_state 补读」
 *   ——runtime 的 set→get_state→effective 回执链（session-service.ts）是唯一正确姿势。
 * - PS-10「get_available_models 返回 Model 全属性（reasoning/thinkingLevelMap 等）；
 *   get_state 不含 models 清单」——U5 能力注册表在线对账的唯一入口。
 *
 * 断言方式：静态直读 pi-coding-agent dist/modes/rpc/rpc-mode.js 的 case 分支构造形态
 * （+ pi-ai types.d.ts 的 Model 属性声明）。dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS
 * 分池。pi 升级后红 = RPC 响应面改形，先复核 PS-03/PS-10 锚点。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-rpc-surface.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const CODING_AGENT_DIST = locatePiDist('pi-coding-agent', 'config.js')
const PI_AI_DIST = locatePiDist('pi-ai', 'models.js')
const SKIP_REASON = CODING_AGENT_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!CODING_AGENT_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

/** 提取 rpc-mode.js 里某 case 分支的窗口文本（到下一个 case 声明或文件尾）。 */
function caseWindow(rpcModeText: string, caseLabel: string): string {
  const start = rpcModeText.indexOf(`case "${caseLabel}":`)
  if (start === -1) return ''
  const rest = rpcModeText.slice(start)
  const next = /\n\s+case "/.exec(rest.slice(10))
  return next ? rest.slice(0, 10 + next.index) : rest
}

describe.skipIf(!CODING_AGENT_DIST)(
  `PS-03 探针：set_thinking_level 响应无 data（静态断言响应构造${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('case 分支存在且调用 session.setThinkingLevel(command.level)', () => {
      const win = caseWindow(rpcMode, 'set_thinking_level')
      expect(win, 'PS-03 漂移：set_thinking_level case 分支消失——RPC 面改形，复核 PS-03 锚点').not.toBe('')
      expect(
        win.includes('session.setThinkingLevel(command.level)'),
        'PS-03 漂移：set_thinking_level 不再透传 command.level 给 session——复核 PS-03',
      ).toBe(true)
    })

    it('响应构造 = success(id, "set_thinking_level") 无第三参（无 data）', () => {
      const win = caseWindow(rpcMode, 'set_thinking_level')
      expect(
        /return success\(id,\s*"set_thinking_level"\);/.test(win),
        'PS-03 漂移：set_thinking_level 响应不再是无 data 形态（上游补了生效值？）——若 pi 已回传生效值，' +
          'runtime 的 set→get_state 补读链可简化，先复核 PS-03 锚点再动 session-service.ts',
      ).toBe(true)
      expect(
        !/success\(id,\s*"set_thinking_level",/.test(win),
        'PS-03 漂移：set_thinking_level 响应出现了 data 参数——语义面变化，复核 PS-03 与 runtime 回执链',
      ).toBe(true)
    })
  },
)

describe.skipIf(!CODING_AGENT_DIST)(
  `PS-10 探针：get_available_models 全属性 / get_state 无 models 清单（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('get_available_models 返回 { models }（getAvailableSnapshot 全量）', () => {
      const win = caseWindow(rpcMode, 'get_available_models')
      expect(
        win.includes('getAvailableSnapshot()') && /return success\(id,\s*"get_available_models",\s*\{ models \}\);/.test(win),
        'PS-10 漂移：get_available_models 不再返回 { models } 全量快照——U5 对账入口改形，复核 PS-10 锚点',
      ).toBe(true)
    })

    it('get_state 快照不含 models 清单（model 字段仅当前模型）', () => {
      const win = caseWindow(rpcMode, 'get_state')
      expect(win, 'PS-10 漂移：get_state case 分支消失——复核 PS-10 锚点').not.toBe('')
      expect(
        !/\bmodels\b/.test(win),
        'PS-10 漂移：get_state 快照出现了 models 集合——状态面与清单面合并？复核 PS-10 与标量状态拉取链',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_AI_DIST)(
  `PS-10 探针：pi-ai Model 类型声明含 reasoning/thinkingLevelMap（静态断言${!PI_AI_DIST ? '｜skip：node_modules/@earendil-works/pi-ai/dist 不可达' : ''}）`,
  () => {
    it('types.d.ts 的 Model 接口声明 reasoning: boolean 与 thinkingLevelMap?: ThinkingLevelMap', () => {
      const types = readFileSync(join(PI_AI_DIST as string, 'types.d.ts'), 'utf-8')
      expect(
        /reasoning:\s*boolean;/.test(types),
        'PS-10 漂移：pi-ai Model 不再声明 reasoning: boolean——能力字段改形，复核 PS-10 锚点 dist/types.d.ts',
      ).toBe(true)
      expect(
        /thinkingLevelMap\?:\s*ThinkingLevelMap;/.test(types),
        'PS-10 漂移：pi-ai Model 不再声明 thinkingLevelMap——档位映射字段改形，复核 PS-10',
      ).toBe(true)
    })
  },
)
