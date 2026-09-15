/**
 * MarkdownSegment —— markdown 渲染段类型（ui 展示层关心的渲染单元）。
 *
 * renderer 壳的 renderMarkdownSegments（markdown.ts，依赖 shiki/markdown-it）产出此类型，
 * 经 ChatViewDeps.renderMarkdown 注入 ui 的 MarkdownRenderer。
 *
 * - text 段：渲染后的 HTML 字符串（含代码块/链接等，走 v-html）
 * - mermaid 段：原始 mermaid 源码（走 MermaidRenderer 组件渲染）
 * - streaming-fence 段（D-5 增量渲染，W22 协议 / W23 消费）：未闭合 fence 的流式占位
 *   ——content 为 fence 内已到达源码，lang 为语言名，mermaid 标记是否 mermaid fence；
 *   占位 UI（语言名 + spinner 行）由 MarkdownRenderer 特殊渲染
 *
 * 协议镜像同步：与 renderer composables/logic/markdown.ts 的 MarkdownSegment 扩展（W22 的
 * segId/lang/mermaid/streaming-fence）做结构对齐，防壳侧漂移——镜像不只为 deps 赋值提供
 * 类型，更是增量协议在 ui 侧的形状契约（壳侧删字段/改字段类型方向的漂移会被结构化类型在
 * 编译期拦下；壳侧新增字段不拦截——结构性子类型允许超集，需人工同步本镜像）：
 * segId 是 D-5 增量渲染的段稳定键（renderIncremental 首次产出时分配，前缀段跨帧不变），
 * 渲染树 v-for 按 segId 取 key（全量渲染路径不携带，undefined）。
 */
export interface MarkdownSegment {
  type: 'text' | 'mermaid' | 'streaming-fence'
  content: string
  /** 段稳定键（D-5 增量渲染）：单调递增、前缀段跨帧不变；全量路径不携带。
   *  例外：streaming-fence 占位段的 segId 每帧重分配（tail 段每帧重建），组件侧对该类型
   *  用固定哨兵 key 跨帧复用 DOM（spinner 不因重建重启），不依赖 segId。 */
  segId?: number
  /** streaming-fence 专属：fence 语言名（info 首词；空 info 归一为 'text'） */
  lang?: string
  /** streaming-fence 专属：是否 mermaid fence */
  mermaid?: boolean
}

/** D-5 增量渲染结果（renderer 壳 renderIncremental 输出的镜像类型，W22 协议 / W23 消费）。
 *  渲染树 = [...prefixSegments, ...tailSegments]；前缀段引用恒等（缓存命中帧零重渲染），
 *  tail 段每帧重建。与 renderer composables/logic/markdown.ts 的 IncrementalRenderResult
 *  结构对齐（壳侧删字段/改字段类型方向的漂移会被结构化类型在编译期拦下；壳侧新增字段
 *  不拦截——结构性子类型允许超集，需人工同步本镜像）。 */
export interface IncrementalMarkdownResult {
  prefixSegments: MarkdownSegment[]
  tailSegments: MarkdownSegment[]
  stableBoundary: number
  mode: 'incremental' | 'fallback-full'
}

/** D-5 增量渲染缓存句柄（renderer 壳 IncrementalRenderCache 的结构镜像）。
 *  ui 侧只持有/透传（opaque handle）：创建与原地更新都在 renderer 壳的 renderIncremental 内，
 *  ui 不读写其字段。结构镜像（而非 unknown）保证壳侧实现与协议同步。 */
export interface IncrementalMarkdownCache {
  boundary: number
  prefixText: string
  prefixSegments: MarkdownSegment[]
  nextSegId: number
  envFilePaths?: Set<string>
  envLocalFiles?: Set<string>
}
