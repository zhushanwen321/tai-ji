/**
 * dev-only mock releaseChecker（自动升级 P2 半 E2E 验证用）。
 *
 * 通过 TAIJI_DEV_MOCK_UPDATE=1 环境变量启用（main.ts 检测后注入）。
 * 返回伪造的 LatestReleaseInfo（version 999.999.999 永远比当前版本新），
 * 让前端 UpdateButton 显示「可升级」态，便于 Playwright 截图验证。
 *
 * 真实升级流程（download + install）仍会因 dev 模式被 MacUpdater 拒绝
 * （app.isPackaged=false 抛 UpdateError），这是有意为之——
 * P2 只验证「检测 → UI 显示」，不验证「真实替换」（P3 才做）。
 *
 * 安全说明：MockReleaseChecker 的代码会被 vite 打包进 prod bundle
 * （vite 不做条件编译），但 main.ts 用 `isDev && DEV_MOCK_UPDATE_ENABLED`
 * 双重保护，prod 构建即使环境变量被误设也永不实例化此类。
 */
import type { LatestReleaseInfo, UpdateSource } from '@taiji/shared'
import type { IReleaseChecker } from '../interfaces.js'

/** SHA-256 摘要的十六进制字符长度（mock 占位用 'a' 填充，长度必须合法否则下游校验报错）。 */
const SHA256_HEX_LENGTH = 64

/**
 * 伪造的 LatestReleaseInfo。
 *
 * version 设为 999.999.999：compare-versions 比较时恒大于任何真实版本，
 * 确保前端 UpdateButton 一定能进入 available 态。
 * releaseNotes 含 markdown 元素（标题、列表、代码块），用于验证
 * hover 浮层的 markdown-it + shiki 渲染（HTML 含 <h2>/<pre>/<code>）；
 * 另含 A8 验收扩展段（tech-design markdown-html-sanitize-render §4 A8）：
 * HTML 白名单段（details/summary、align 居中 p）、`:---:` 列对齐表格、
 * 超宽表格——分别对应「HTML 段渲染、列对齐生效、表格形态与对话流宿主
 * 一致（窄表收缩/超宽滚动，360px HoverCard 窄容器极端样本）」三个判据。
 */
const MOCK_RELEASE: LatestReleaseInfo = {
  version: '999.999.999',
  tagName: 'v999.999.999',
  releaseNotes: [
    '## 测试版本（dev mock）',
    '',
    '- P2 半 E2E 验证用的伪造 release',
    '- hover 此区域应渲染为 HTML（markdown-it + shiki）',
    '',
    '```ts',
    'const x = 42',
    '```',
    // 以下三段为 A8 验收样本（tech-design markdown-html-sanitize-render §4 A8）：
    // ① HTML 白名单渲染 ② `:---:` 列对齐转写生效 ③ 超宽表在 360px 容器横向滚动
    '',
    '<details>',
    '<summary>折叠区块标题（点击展开）</summary>',
    '<p>折叠区块正文：展开后可见此段文本，验证 details/summary 在白名单内渲染。</p>',
    '</details>',
    '',
    '<p align="center">居中段落：验证带 align 属性的 p 保留居中效果。</p>',
    '',
    '### 列对齐表格',
    '',
    '| 左对齐列 | 居中对齐列 | 右对齐列 |',
    '|:---|:---:|---:|',
    '| 左对齐样本一 | 居中样本一 | 右对齐样本一 |',
    '| 左对齐样本二 | 居中样本二 | 右对齐样本二 |',
    '',
    '### 超宽表格（应横向滚动）',
    '',
    '| 功能模块名称与归属业务域说明列 | 变更类型与影响范围边界说明条目 | 兼容性风险等级评估结论说明条目 | 回归验证覆盖面与用例规模说明列 | 依赖包版本同步状态与锁文件说明列 | 文档同步完成度与漂移检查说明列 | 性能基准对比结论与采样窗口说明列 | 发布门禁校验结果与放行状态说明列 |',
    '|---|---|---|---|---|---|---|---|',
    '| 更新检测通道与代理网络接入状态 | 悬停浮层渲染链路与宿主样式匹配状态 | 净化白名单策略与标签属性基线状态 | 像素级截图比对与类别清单判定状态 | 上游依赖锁文件同步与版本门禁校验 | 领域术语表条目新增与语义漂移核对 | 冷启动耗时采样与性能基准线对比 | 发布门禁校验结果与放行状态记录 |',
    '| 更新检测通道接入 | 悬停浮层渲染链路 | 白名单策略基线 | 像素级截图比对 | 上游锁文件同步 | 术语表条目核对 | 启动耗时采样 | 静态检查全绿 |',
  ].join('\n'),
  publishedAt: new Date().toISOString(),
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/dev-mock',
  assets: {
    // macArm64Dmg 是必须的（MacUpdater 走此 asset）；指向不存在的 URL，
    // 真实下载时会失败——但 P2 不走到这步（只验证检测 + UI）。
    // downloadUrl 用合法的 GitHub URL（即使 404），以便通过 validateRelease
    // 白名单校验（install 路径会校验从 preloaded 读出的 release）。
    macArm64Dmg: {
      name: 'TaiJi-mac-arm64.dmg',
      downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v999.999.999/TaiJi-mac-arm64.dmg',
      size: 0,
      sha256: 'a'.repeat(SHA256_HEX_LENGTH),
    },
  },
}

/**
 * dev mock releaseChecker 实现。
 *
 * checkForLatestRelease 直接返回 MOCK_RELEASE，不做任何网络请求。
 * 忽略 currentVersion / force 参数（mock 永远返回「有新版」）。
 * fetchReleaseByTag（多源改造 IReleaseChecker 必需方法）同样返回 MOCK_RELEASE：
 * P2 只验证「检测 → UI 显示」，下载段跨源降级在 dev 模式会被 MacUpdater 拒绝，
 * 永不消费此方法——返回固定 mock 保持「永远有新版」的 mock 语义一致。
 */
export class MockReleaseChecker implements IReleaseChecker {
  async checkForLatestRelease(
    _currentVersion: string,
    _opts?: { force?: boolean },
  ): Promise<LatestReleaseInfo | null> {
    return MOCK_RELEASE
  }

  async fetchReleaseByTag(
    _source: UpdateSource,
    _tag: string,
  ): Promise<LatestReleaseInfo | null> {
    return MOCK_RELEASE
  }
}

/**
 * dev mock 开关：TAIJI_DEV_MOCK_UPDATE=1 启用。
 *
 * 单独导出（而非内联 process.env 读取）便于：
 * 1. main.ts 注入点清晰可读（isDev && DEV_MOCK_UPDATE_ENABLED）
 * 2. grep 跟踪环境变量的所有消费点
 */
export const DEV_MOCK_UPDATE_ENABLED = process.env.TAIJI_DEV_MOCK_UPDATE === '1'
