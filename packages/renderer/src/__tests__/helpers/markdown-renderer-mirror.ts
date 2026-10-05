import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

/**
 * ui 侧 MarkdownRenderer 镜像函数提取器（U-A6 镜像守卫测试专用 helper，设计 D4-7 短期层）。
 *
 * 背景：ui→renderer 依赖禁令使 ui 包内的相对路径判定/resolve 与 base64 解码函数只能以镜像
 * 形态存在（与 renderer markdown-sanitize.ts 的 isRelativeResourcePath/resolveResourcePath、
 * markdown.ts 的 decodeBase64 同标准，两侧注释互指，改动需同批同步——镜像纪律同
 * markdown-types.ts 协议镜像）。守卫测试喂同输入断言同输出：任一侧语义漂移即红灯。
 *
 * 提取方式（零生产代码改动）：从 ui 侧 markdown-links.ts（镜像纯函数模块）源码中按顶层
 * 声明锚点提取函数文本，经转译（剥离 TS 类型注解）后在 node:vm 沙箱构造可调用函数——
 * chat 内部模块不在 ui 包 exports 白名单，renderer 无法 import，源码提取是零生产代码
 * 改动的可达路径。语义保真由提取即源码本身保证：改 ui 侧函数语义，守卫下一次运行
 * 提取到的就是新语义。
 */

const MARKDOWN_LINKS_TS = resolve(__dirname, '../../../../ui/src/features/chat/markdown-links.ts')

/** ui 侧提取函数签名（与 renderer 侧对应导出函数同型） */
export interface UiMarkdownRendererMirrors {
  isRelativeHref: (value: string) => boolean
  resolveHrefPath: (base: string, rel: string) => string
  decodeB64: (b64: string) => string
}

/** 提取 markdown-links.ts 顶层声明（export 可选前缀；函数体顶格、闭括号顶格；const 单行） */
function extractTopLevelBlock(src: string, name: string, kind: 'function' | 'const'): string {
  const re =
    kind === 'function'
      ? new RegExp(`^(?:export )?function ${name}\\([\\s\\S]*?^\\}`, 'm')
      : new RegExp(`^(?:export )?const ${name} = .*$`, 'm')
  const m = src.match(re)
  if (!m) {
    throw new Error(
      `镜像守卫提取失败：markdown-links.ts 中未找到顶层 ${kind} ${name}。` +
        `ui 侧镜像函数被改名/移动/缩进调整——守卫失效需人工对位：核对 ui 侧函数与 ` +
        `renderer 侧镜像（markdown-sanitize.ts / markdown.ts）语义是否仍一致，` +
        `再更新本 helper 的提取锚点。镜像纪律见两测文件头注释。`,
    )
  }
  return m[0]
}

/**
 * 加载 ui 侧三个镜像函数。转译走 vite 8 官方导出 transformWithOxc（vitest 同源依赖，零新增
 * 依赖面；旧 transformWithEsbuild 在 vite 8 已废弃且其环境自检与本测试 jsdom realm 不兼容）。
 * 函数体内含 TS 注解（如 const parts: string[]），故整段转译而非正则剥注解；转译失败显式红。
 */
export async function loadUiMarkdownRendererMirrors(): Promise<UiMarkdownRendererMirrors> {
  const linksSrc = readFileSync(MARKDOWN_LINKS_TS, 'utf8')
  // 片段行首剥 export 修饰：vm 沙箱是 Script（CommonJS）语义不吃 ESM 语法，转译也不剥
  // export——剥前缀后与组件内裸声明形态一致
  const ts = [
    extractTopLevelBlock(linksSrc, 'SCHEME_RE', 'const'),
    extractTopLevelBlock(linksSrc, 'isRelativeHref', 'function'),
    extractTopLevelBlock(linksSrc, 'resolveHrefPath', 'function'),
    extractTopLevelBlock(linksSrc, 'decodeB64', 'function'),
  ]
    .map((block) => block.replace(/^export /, ''))
    .join('\n')
  const { transformWithOxc } = await import('vite')
  const { code } = await transformWithOxc(ts, 'markdown-renderer-mirror-extract.ts', { lang: 'ts' })
  // vm 沙箱注入宿主 atob / TextDecoder / Uint8Array（decodeB64 体内引用，统一 realm 避免
  // 跨 realm typed array 传递；字符串是 primitive 无 realm 问题）。沙箱自带其余 ECMAScript 内建。
  return runInNewContext(`${code}\n;({ isRelativeHref, resolveHrefPath, decodeB64 })`, {
    atob: (s: string) => atob(s),
    TextDecoder,
    Uint8Array,
  }) as UiMarkdownRendererMirrors
}

/**
 * UTF-8 → base64 对拍参照（与 composables/markdown-base64.test.ts 的 referenceB64 同型）：
 * encodeURIComponent 把非 ASCII 转成 %XX（UTF-8 字节的 percent 编码），逐 %XX 还原为单字节
 * 字符后 btoa——与 TextEncoder 产出的 UTF-8 字节序列逐字节等价。供 base64 镜像守卫从
 * 任意文本构造合法 base64 输入。
 */
export function referenceB64(text: string): string {
  const escaped = encodeURIComponent(text)
  const parts: string[] = []
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i]
    if (ch === '%') {
      parts.push(String.fromCharCode(parseInt(escaped.slice(i + 1, i + 3), 16)))
      i += 2
    } else {
      parts.push(ch)
    }
  }
  return btoa(parts.join(''))
}
