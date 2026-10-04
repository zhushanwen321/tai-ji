/**
 * PS-57 探针：pi RPC 模式 stdout 消息按写入顺序到达（FIFO）——notify-once 兑现链前提守卫。
 *
 * 登记条目（docs/pi-semantics.json PS-57）：全部协议消息（response / 事件 / extension_ui_request）
 * 汇经 rpc-mode 的 output 单点 writeRawStdout(serializeJsonLine(obj))，事件流经 session.subscribe
 * 回调逐条 output；writeRawStdout 以 promise tail 链串行化（rawStdoutWriteTail =
 * tail.then(() => writeRawStdoutChunk(text))），底层 write 的异步回调与背压重试
 * （ENOBUFS/EAGAIN/EWOULDBLOCK → 10ms 重试）都在 tail 链上排队——写序 = 调用序、不并行不乱序。
 *
 * 承重（ADR-0087）：delivery 内核 onSettled 受理回执（port.send 同栈同步触发）先于其后的
 * agent_settled 事件被 runtime 处理——armed→injected 锚定与 settled 兑现的先后关系以 stdout
 * FIFO 为前提；pi 若改为并行/分通道输出，先后关系失锚且无显式信号，故以本探针拦为红灯。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi 语义断言权威源，见 AGENTS.md）。
 * dist 不可达时 skip 不 fail；凭证无关、不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-stdout-fifo.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const RPC_DIST = locatePiDist('pi-coding-agent', 'config.js')
const SKIP_REASON = RPC_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!RPC_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!RPC_DIST)(
  `PS-57 探针：stdout 消息单点 + tail 链串行化（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
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
          'output 单点（分通道/直写 stdout），事件与其前后的受理回执消息的顺序保证失锚。' +
          '恢复动作：复核事件转发路径，确认顺序语义后更新本探针',
      ).toBe(true)
    })

    it('语义③：writeRawStdout 以 promise tail 链串行化（写序 = 调用序的机械保证）', () => {
      expect(
        outputGuard.includes('rawStdoutWriteTail = rawStdoutWriteTail.then('),
        'PS-57 漂移：writeRawStdout 的 tail 链串行化形态消失——写入改为并行/无序（FIFO 前提失锚），' +
          'notify-once 受理回执先于 agent_settled 处理的保证不复存在。恢复动作：复核 output-guard.js ' +
          '写入机制，若顺序保证由其他机制承担则重写本条 claim 与探针，否则升级为 pi 语义漂移处理',
      ).toBe(true)
    })

    it('语义④：背压重试限流于写入错误码（重试在 tail 链回调内，不改写序）', () => {
      expect(
        count(outputGuard, 'EAGAIN') >= 1 && count(outputGuard, 'ENOBUFS') >= 1,
        'PS-57 漂移：背压重试错误码词表（ENOBUFS/EAGAIN）消失——背压处理机制改形，' +
          'tail 链重试是否仍保序须复核 output-guard.js 后更新本探针',
      ).toBe(true)
    })
  },
)
