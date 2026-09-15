/**
 * normalizePiToolResult 双实现对照测试（W3 移交，R2-TC S1，仿 file-lock-parity 模式）。
 *
 * runtime 侧 infra/pi/normalize-tool-result.ts（实时路径 SSOT：event-adapter 消费）与
 * core 侧 domain/chat/apply-entry-utils.ts（reducer 消费：registry tool_call_end /
 * computeToolCallFill）是同一归一规则的两份孪生实现——迁移副本而非 import（core 不依赖
 * runtime，包依赖方向约束）。两份并存是 W20 已知分叉（收敛到 shared 留待后续 wave），
 * 分叉期间纯靠注释互指的纪律同步会漂移：实时路径与重放路径（live ≡ reload，关键规则 9）
 * 的归一输出一旦分叉，同一条 toolResult 在重开 session 后渲染漂移且等价性守卫归因困难。
 *
 * 本测试对同一输入组双侧调用、共同契约字段（output / outputRaw / images）断言 deep
 * equal——任一侧单方面改动（过滤规则 / join 分隔符 / ANSI 正则 / images 空块判定）
 * 都会先于线上漂移红掉。
 *
 * import 取舍（对齐 file-lock-parity 先例）：core 包不是 runtime 的依赖，对照测试以
 * 相对路径直连其 workspace 源码；core 侧模块移位时本测试的 import 会先红，额外起到
 * 「孪生实现位置契约」的护栏作用。
 */
import { describe, expect, it } from 'vitest'

import { normalizePiToolResult as runtimeNormalize } from '../src/infra/pi/normalize-tool-result.js'
import { normalizePiToolResult as coreNormalize } from '../../core/src/domain/chat/apply-entry-utils.js'

/** 共同契约字段抽取：双侧输出收敛到 { output, outputRaw, images } 后 deep equal。
 *  runtime 版额外产 details（raw.details 提取）——core 消费路径的 details 由 handler
 *  直接读 entry.message.details（registry tool_call_end），不属归一契约，不参与 parity。 */
function commonFields(r: { output: string; outputRaw?: string; images?: Array<{ data: string; mimeType: string }> }) {
  return { output: r.output, outputRaw: r.outputRaw, images: r.images }
}

describe('normalizePiToolResult parity（runtime 实时路径 ↔ core reducer 路径）', () => {
  // 任务点名的四个输入组 + 边界补充，覆盖三态判定全分支
  const cases: Array<{ name: string; raw: unknown }> = [
    // 组 1：ANSI 转义序列（string 形态）
    { name: 'string 含 ANSI（outputRaw 保留原始）', raw: '\x1b[31mhello\x1b[0m world' },
    { name: 'string 含复合 ANSI（1;32m）', raw: '\x1b[1;32mgreen bold\x1b[0m' },
    { name: 'string 纯文本（无 outputRaw）', raw: 'plain output' },
    { name: 'string 空串', raw: '' },
    // 组 2：content-array 含图片块
    { name: 'content text + image 混合', raw: { content: [
      { type: 'text', text: 'screenshot below' },
      { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
    ] } },
    { name: 'content 双空 image 块过滤（data 与 mimeType 均空）', raw: { content: [
      { type: 'image', data: '', mimeType: '' },
      { type: 'image', data: 'keep', mimeType: 'image/jpeg' },
    ] } },
    { name: 'content text 块含 ANSI', raw: { content: [{ type: 'text', text: '\x1b[32mgreen\x1b[0m' }] } },
    { name: 'content 多 text 块 join', raw: { content: [
      { type: 'text', text: 'foo' },
      { type: 'text', text: 'bar' },
    ] } },
    { name: 'content text 缺 text 字段（畸形块按空串）', raw: { content: [{ type: 'text' }, { type: 'text', text: 'ok' }] } },
    { name: 'content 非识别类型块忽略', raw: { content: [{ type: 'tool_use', name: 'x' }, { type: 'text', text: 'keep' }] } },
    // 组 3：非对象 raw（原始值形态）
    { name: 'number', raw: 42 },
    { name: 'boolean', raw: true },
    { name: 'null', raw: null },
    { name: 'undefined', raw: undefined },
    // 组 4：空 content
    { name: '空 content 数组', raw: { content: [] } },
    // 补充：非 content 形态对象（JSON.stringify 分支）与数组
    { name: '普通对象 JSON.stringify', raw: { foo: 'bar', n: 1 } },
    { name: '数组 JSON.stringify', raw: [1, 2, 3] },
    // 补充：runtime 版独有 details 携带时共同字段不漂移
    { name: 'content + details（runtime 提取 details，共同字段不受影响）', raw: {
      content: [{ type: 'text', text: 'x' }],
      details: { __gui__: { v: 1 } },
    } },
  ]

  for (const c of cases) {
    it(`${c.name}：双侧 output/outputRaw/images deep equal`, () => {
      expect(commonFields(coreNormalize(c.raw))).toEqual(commonFields(runtimeNormalize(c.raw)))
    })
  }

  it('core 版不产 details 字段（details 归 handler 直读 entry.message.details，非归一契约）', () => {
    const raw = { content: [{ type: 'text', text: 'x' }], details: { __gui__: { v: 1 } } }
    expect('details' in coreNormalize(raw)).toBe(false)
    // runtime 版照常提取（形态差异锚定，防未来「顺手对齐」抹掉语义差异）
    expect(runtimeNormalize(raw).details).toEqual({ __gui__: { v: 1 } })
  })

  it('双侧 outputRaw 不变量：仅在含 ANSI 时出现且 !== output（对称回归在双侧同构成立）', () => {
    const ansiCases: unknown[] = ['\x1b[31mred\x1b[0m', { content: [{ type: 'text', text: '\x1b[33myellow\x1b[0m' }] }]
    for (const raw of ansiCases) {
      for (const fn of [coreNormalize, runtimeNormalize]) {
        const r = fn(raw)
        expect(r.outputRaw).toBeDefined()
        expect(r.outputRaw).not.toBe(r.output)
      }
    }
  })
})
