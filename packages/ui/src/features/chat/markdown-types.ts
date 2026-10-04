/**
 * markdown 渲染协议类型 —— ui 单一源（SSOT）。
 *
 * 渲染纯逻辑（markdown.ts / markdown-incremental.ts，依赖 markdown-it/shiki/katex，
 * 经 `@taiji/ui` 渲染 subpath 导出）产出/消费本文件类型，经 ChatViewDeps.renderMarkdown
 * 注入 ui 的 MarkdownRenderer。桌面壳与移动壳共用同一协议面。
 *
 * - text 段：渲染后的 HTML 字符串（含代码块/链接等，走 v-html）
 * - mermaid 段：原始 mermaid 源码（走 MermaidRenderer 组件渲染）
 * - streaming-fence 段（D-5 增量渲染，W22 协议 / W23 消费）：未闭合 fence 的流式占位
 *   ——content 为 fence 内已到达源码，lang 为语言名，mermaid 标记是否 mermaid fence；
 *   占位 UI（语言名 + spinner 行）由 MarkdownRenderer 特殊渲染
 *
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

/**
 * renderMarkdown / renderIncremental 的 env 参数：贯穿 core rule（state.env）+ renderer
 * rule（markdown-it 渲染规则第 4 参），随渲染调用逐帧透传。
 *
 * - filePaths：当前 session 项目里文件的**完整路径**集合（如 {'src/index.ts', 'packages/x.ts'}）。
 *   含/路径识别的白名单——正文里的裸路径（如 src/foo.ts）必须命中此集合才链接化。
 *   数据源：useFileSearch.load 的全量递归 file.search 结果（FileNode[]，每次现拉），扁平化为 FileNode.path Set。
 * - localFiles：当前 session 项目里文件的 **basename** 集合（如 {'design.md', 'README.md'}）。
 *   裸 basename（无 / 前缀，如 design.md）识别的白名单。
 *   数据源：同上，扁平化为 FileNode.name Set。
 *
 * 两者首渲染时可能为空集（fileSearch 未加载）→ 路径降级纯文本，加载完成后响应式重渲染。
 *
 * - copyLabel：代码块复制按钮的 i18n 文案（title 属性）。ui 渲染模块不 import 任何壳层
 *   i18n 单例（ui 无 `@/i18n` 可址），文案由宿主壳在渲染入口注入（ComposerInput 的
 *   t deps token 同族先例）；未注入时按钮省略 title 属性。每次渲染调用求值，locale
 *   切换后下一帧即生效（增量前缀缓存内已 bake 的段随前缀冻结，属既有机制语义）。
 */
export interface MarkdownEnv {
  /** 含/路径识别的白名单（FileNode.path 集合，相对 cwd，无前导 /） */
  filePaths?: Set<string>
  /** 裸 basename 识别的白名单（FileNode.name 集合） */
  localFiles?: Set<string>
  /** 代码块复制按钮 title 文案（宿主壳注入的 i18n 文案，如 zh「复制」/ en「Copy」） */
  copyLabel?: string
}

/** D-5 增量渲染结果（renderIncremental 输出，W22 协议 / W23 消费）。
 *  渲染树 = [...prefixSegments, ...tailSegments]；前缀段引用恒等（缓存命中帧零重渲染），
 *  tail 段每帧重建。 */
export interface IncrementalMarkdownResult {
  prefixSegments: MarkdownSegment[]
  tailSegments: MarkdownSegment[]
  stableBoundary: number
  mode: 'incremental' | 'fallback-full'
}

/** D-5 增量渲染缓存句柄（renderIncremental 创建与原地更新）。
 *  ui 侧只持有/透传（opaque handle）：创建与原地更新都在渲染模块的 renderIncremental 内，
 *  ui 不读写其字段。结构化定义（而非 unknown）保证实现与协议同步。 */
export interface IncrementalMarkdownCache {
  boundary: number
  prefixText: string
  prefixSegments: MarkdownSegment[]
  nextSegId: number
  envFilePaths?: Set<string>
  envLocalFiles?: Set<string>
}
