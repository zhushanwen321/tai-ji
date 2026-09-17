/**
 * SSOT + 机器守卫：plugin-sdk ↔ extension-protocol GUI 协议类型镜像。
 *
 * 镜像两端：
 * - 宿主 SDK 发布面：packages/plugin-sdk/src/types.ts GUI 协议段（约 :29-195，以导出名为
 *   准）——GuiComponent / GuiComponentProps / GuiRenderResult / WidgetMeta / StatItem /
 *   TreeItem 等，面向插件作者对外发布（published API 兼容承诺）
 * - 协议包副本：packages/extension-protocol/src/core/types.ts 全文件（本文件同目录）
 *
 * 两侧是注释级手工镜像（无生成脚本、无 import 复用——依赖方向是 plugin-sdk → 本包，
 * 反向 import 会成环，本包 node_modules 亦无 plugin-sdk 链接），同步靠人肉纪律，本测试
 * 把纪律机器化：fs 读两侧源文件，按顶层 export 切块、规范化空白后逐块严格相等——
 * 任一侧改动未同步另一侧（字段/枚举值）即红，报错消息指向同步动作。
 *
 * 守卫边界（normalizeBlock 语义）：独立注释行（整行 JSDoc、`//` 段）被剥离、不参与
 * 比较——独立注释块漂移不红，靠两侧文件内「改动须同步另一侧」的人肉注释约束；
 * 行尾内联注释随所在行保留参与比较，内联注释漂移即红。
 *
 * 覆盖方向：plugin-sdk 无 vitest 环境（无 test script / vitest 配置 / 测试文件），守卫
 * 落本包侧运行（本包 vitest include 覆盖 src 目录下全部 *.test.ts，自动收编本文件）。
 *
 * 形态说明：镜像面是纯类型 + 单常量，无双侧可共用的运行时锚点，故用源码文本结构探针
 * （仓库先例：session-manager/validation.test.ts 的 readFileSync 源码断言、.githooks
 * check_env_whitelist_sync.py 的镜像逐项相等语义）。
 *
 * 运行：cd packages/extension-protocol && npx vitest run src/core/plugin-sdk-types-mirror.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SDK_TYPES_TS = resolve(__dirname, '../../../plugin-sdk/src/types.ts')
const CORE_TYPES_TS = resolve(__dirname, './types.ts')

/** 镜像面清单：两包必须同时存在且逐块相等的导出名。 */
const MIRRORED_EXPORTS = [
  'PROTOCOL_VERSION',
  'GuiComponent',
  'GuiComponentType',
  'GuiComponentProps',
  'GuiRenderResult',
  'WidgetMeta',
  'StatItem',
  'TreeItem',
  'TreeItemIcon',
] as const

/** 剥离独立注释行（JSDoc/`//` 行不守卫）、tab 归一、逐行 trim + 压行内空白——行尾内联注释随行保留参与比较。 */
function normalizeBlock(lines: string[]): string {
  return lines
    .map((l) => l.replace(/\t/g, '  '))
    .filter((l) => {
      const t = l.trim()
      return t !== '' && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//')
    })
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .join('\n')
}

/** 源码 → 顶层导出块映射（块 = 列 0 的 export 行起，到下一个列 0 export 行前）。 */
function splitTopLevelExports(source: string): Map<string, string> {
  const blocks = new Map<string, string>()
  let current: { name: string; lines: string[] } | undefined
  for (const line of source.split('\n')) {
    if (/^export\s/.test(line)) {
      if (current) blocks.set(current.name, normalizeBlock(current.lines))
      const declared = /^(?:export\s+)(?:interface|type|const|function|class|enum)\s+([A-Za-z0-9_]+)/.exec(line)
      // 无声明名的 export（如 `export type { A, B }` re-export）用行文本作键，不参与镜像比对
      current = { name: declared?.[1] ?? `__raw__:${line.trim()}`, lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.set(current.name, normalizeBlock(current.lines))
  return blocks
}

describe('plugin-sdk ↔ extension-protocol GUI 协议类型镜像守卫（SSOT + 机器守卫）', () => {
  const sdkBlocks = splitTopLevelExports(readFileSync(SDK_TYPES_TS, 'utf-8'))
  const coreBlocks = splitTopLevelExports(readFileSync(CORE_TYPES_TS, 'utf-8'))

  it('镜像面双侧在位：清单内导出名两侧都存在（缺失侧点名）', () => {
    for (const name of MIRRORED_EXPORTS) {
      expect(sdkBlocks.has(name), `packages/plugin-sdk/src/types.ts 缺少 export ${name}（镜像面缺失，须同步另一侧或更新 MIRRORED_EXPORTS）`).toBe(true)
      expect(coreBlocks.has(name), `packages/extension-protocol/src/core/types.ts 缺少 export ${name}（镜像面缺失，须同步另一侧或更新 MIRRORED_EXPORTS）`).toBe(true)
    }
  })

  it('逐块规范化相等：任一侧改动未同步另一侧（字段/枚举值/行尾内联注释）即红；独立注释行不守卫', () => {
    for (const name of MIRRORED_EXPORTS) {
      expect(
        sdkBlocks.get(name),
        `plugin-sdk/src/types.ts 的 ${name} 与 extension-protocol/src/core/types.ts 漂移——手工镜像改动须同步另一侧`,
      ).toBe(coreBlocks.get(name))
    }
  })
})
