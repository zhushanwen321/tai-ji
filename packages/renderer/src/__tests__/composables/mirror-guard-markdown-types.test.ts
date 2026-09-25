// [镜像守卫 U-A6 / 设计 D4-7 短期层] markdown-types 纯 interface 镜像类型级守卫。
//
// 镜像两侧（零运行时代码，行为守卫不存在可实现形态——设计 D4-7 裁定为类型级守卫）：
// - renderer：composables/logic/markdown.ts 的 MarkdownSegment +
//   composables/logic/markdown-incremental.ts 的 IncrementalRenderResult / IncrementalRenderCache
// - ui：features/chat/markdown-types.ts 的 MarkdownSegment / IncrementalMarkdownResult /
//   IncrementalMarkdownCache（文件头自证「需人工同步本镜像」）
//
// 守卫形态（core 先例 background-task.ts 的 BackgroundTaskMirrorEqualsContract 同型）：
// Equal<X, Y> 是严格双向同构断言——任一侧删字段/改字段类型/加必填字段即编译期红灯
// （renderer 侧壳新增可选字段时结构性子类型不拦截，该方向仍靠人工同步，镜像注释已登记）。
// 契约生效通道 = vue-tsc typecheck-test 白名单（tsconfig.typecheck-test.json include 本文件），
// vitest 运行时部分是样本双向赋值的执行面（vitest esbuild 转译跳过类型检查，类型红灯只来自
// vue-tsc——两条通道各自真实可红）。
//
// 运行：cd packages/renderer && npx vitest run src/__tests__/composables/mirror-guard-markdown-types.test.ts
// 类型：cd packages/renderer && npx vue-tsc --noEmit -p tsconfig.typecheck-test.json
import { describe, it, expect } from 'vitest'
import type {
  IncrementalMarkdownCache,
  IncrementalMarkdownResult,
  MarkdownSegment,
} from '@taiji/ui'
import type { MarkdownSegment as RendererMarkdownSegment } from '@/composables/logic/markdown'
import type {
  IncrementalRenderCache,
  IncrementalRenderResult,
} from '@/composables/logic/markdown-incremental'

/** 严格双向同构判别（TS 官方 issue 形态，core background-task.ts 同款） */
type Equal<X, Y> = (<T>() => T extends X ? true : false) extends <T>() => T extends Y ? true : false
  ? true
  : false
type Expect<T extends boolean> = T

/** 两侧 import 同源断言：ui markdown-types ↔ renderer markdown.ts 主镜像类型 */
export type MarkdownSegmentMirrorContract = Expect<Equal<MarkdownSegment, RendererMarkdownSegment>>
/** ui IncrementalMarkdownResult ↔ renderer IncrementalRenderResult（D-5 增量渲染结果镜像） */
export type IncrementalResultMirrorContract = Expect<Equal<IncrementalMarkdownResult, IncrementalRenderResult>>
/** ui IncrementalMarkdownCache ↔ renderer IncrementalRenderCache（D-5 缓存句柄结构镜像） */
export type IncrementalCacheMirrorContract = Expect<Equal<IncrementalMarkdownCache, IncrementalRenderCache>>

describe('镜像守卫：markdown-types 纯 interface 镜像（ui ↔ renderer 类型级）', () => {
  it('样本对象双向赋值（运行时执行面；类型面红灯由 vue-tsc typecheck-test 承载）', () => {
    const fromUi = (s: MarkdownSegment): RendererMarkdownSegment => s
    const toUi = (s: RendererMarkdownSegment): MarkdownSegment => s

    // 全量路径形态（可选字段缺省）
    const text: MarkdownSegment = { type: 'text', content: '<p>hello</p>' }
    expect(toUi(fromUi(text))).toEqual(text)

    // streaming-fence 全字段形态（segId/lang/mermaid 齐备）
    const fence: MarkdownSegment = {
      type: 'streaming-fence',
      content: 'const x = 1',
      segId: 3,
      lang: 'ts',
      mermaid: false,
    }
    const roundTrip = toUi(fromUi(fence))
    expect(roundTrip.segId).toBe(3)
    expect(roundTrip.lang).toBe('ts')
    expect(roundTrip.mermaid).toBe(false)

    // 增量结果镜像双向赋值
    const result: IncrementalMarkdownResult = {
      prefixSegments: [text],
      tailSegments: [fence],
      stableBoundary: 7,
      mode: 'incremental',
    }
    const toUiResult = (r: IncrementalMarkdownResult): IncrementalRenderResult => r
    expect(toUiResult(result).stableBoundary).toBe(7)

    // 缓存句柄镜像双向赋值（ui 侧只持有/透传的 opaque handle）
    const cache: IncrementalMarkdownCache = {
      boundary: 7,
      prefixText: '# title\n',
      prefixSegments: [text],
      nextSegId: 4,
      envResourceBaseDir: '/tmp/workspace',
    }
    const toUiCache = (c: IncrementalMarkdownCache): IncrementalRenderCache => c
    expect(toUiCache(cache).nextSegId).toBe(4)
  })
})
