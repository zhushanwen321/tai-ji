/**
 * i18n-frontend-p2 U7 + U8: locale key 双侧对齐 + 组件模板 CJK 残留扫描（W5）。
 *
 * U7: 扫 packages/renderer/src/i18n/locales/zh-CN 与 en-US 双侧，断言每个子模块
 *     文件 key 集合完全一致（嵌套 key 也算）。
 * U8: 扫 components 下所有 .vue 文件的 template 块，断言无新增 CJK 字符（豁免清单外）。
 *
 * 这两个测试是"机械闸门"——任何漏网的中文 UI 文案或 locale desync 都会被捕获。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales')
const COMPONENTS_DIR = resolve(__dirname, '../../components')

interface LocaleObject {
  [key: string]: string | LocaleObject
}

/** 读 .ts locale 文件为对象（export default {...}） */
function loadLocaleObject(filePath: string): LocaleObject {
  const src = readFileSync(filePath, 'utf-8')
  // 极简解析：只支持 export default { ... } 形式（项目内 locale 全是这种）
  const match = src.match(/export\s+default\s+(\{[\s\S]*\})\s*$/)
  if (!match) throw new Error(`无法解析 locale 文件: ${filePath}`)
  // 用 Function 构造器 + 闭包模拟（避免引入额外依赖）
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const obj = new Function(`return (${match[1]});`)() as LocaleObject
  return obj
}

/** 拍平嵌套对象为 '.' 路径集合 */
function flattenKeys(obj: LocaleObject, prefix = ''): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      for (const sub of flattenKeys(v, fullKey)) out.add(sub)
    } else {
      out.add(fullKey)
    }
  }
  return out
}

/** 拍平嵌套对象为 [key 路径, 消息值] 对（仅叶子字符串）——U9 用（需要值不只 key） */
function flattenEntries(obj: LocaleObject, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      out.push(...flattenEntries(v, fullKey))
    } else {
      out.push([fullKey, v])
    }
  }
  return out
}

/** 列出指定目录下所有 .ts 文件（不含子目录递归——locales 子目录就是子模块） */
function listTsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f))
}

/** 递归列 .vue 文件 */
function listVueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...listVueFiles(full))
    } else if (full.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 提取 .vue 的顶层 <template> 块体（开标签之后、配对的顶层闭标签之前——与原
 * 非贪婪正则的捕获组语义一致，唯截断点从「第一个 </template>」修正为「配对的
 * 顶层 </template>」）。
 *
 * 栈深度计数而非非贪婪正则（/<template>([\s\S]*?)<\/template>/）：它会在第一个
 * </template> 截断——组件内嵌套 <template>（slot / v-if 形态）之后的模板后半段
 * 逃过 U8 CJK 扫描（审查 F4 盲区）。自闭合（<template #slot />）不进栈
 * （alternation 自闭合分支在前，防 [^>]*> 先吞）。
 */
function extractTemplate(source: string): string {
  const tokens = source.matchAll(/<template\b[^>]*\/>|<template\b[^>]*>|<\/template>/g)
  let depth = 0
  let contentStart = -1
  for (const t of tokens) {
    if (t[0] === '</template>') {
      depth--
      if (depth === 0) return source.slice(contentStart, t.index)
    } else if (t[0].endsWith('/>')) {
      continue // 自闭合：无块体，不影响深度
    } else {
      if (depth === 0) contentStart = (t.index ?? 0) + t[0].length
      depth++
    }
  }
  return ''
}

describe('U7: locale key 双侧对齐（zh-CN === en-US）', () => {
  const zhDir = join(LOCALES_DIR, 'zh-CN')
  const enDir = join(LOCALES_DIR, 'en-US')
  const zhFiles = listTsFiles(zhDir)
  const enFiles = listTsFiles(enDir)

  it('双侧子模块文件数量一致', () => {
    const zhNames = zhFiles.map((f) => f.split('/').pop()).sort()
    const enNames = enFiles.map((f) => f.split('/').pop()).sort()
    expect(enNames).toEqual(zhNames)
  })

  it.each(
    zhFiles.map((f) => ({ name: f.split('/').pop()!, zh: f, en: join(enDir, f.split('/').pop()!) })),
  )('$name 双侧 key 集合完全一致', ({ zh, en }) => {
    const zhKeys = flattenKeys(loadLocaleObject(zh))
    const enKeys = flattenKeys(loadLocaleObject(en))
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
    const extraInEn = [...enKeys].filter((k) => !zhKeys.has(k))
    expect({ missingInEn, extraInEn }).toEqual({ missingInEn: [], extraInEn: [] })
  })
})

describe('U8: 组件 <template> 无新增 CJK 字符（豁免清单外）', () => {
  /** 豁免清单：已知含 CJK 但属于合理使用的位置（mock fixtures / icon SVG / 数据值） */
  const ALLOW_FILES = new Set<string>([
    // （W1 re-home：Card.vue 等 GUI 原语已迁至 @taiji/ui 包，不在本目录扫描范围，条目移除）
  ])

  it.each(listVueFiles(COMPONENTS_DIR))('%s 模板无新增 CJK 字符', (filePath) => {
    const rel = filePath.split('/packages/renderer/src/')[1]
    if (ALLOW_FILES.has(rel)) return
    const source = readFileSync(filePath, 'utf-8')
    const tpl = extractTemplate(source)
    // 移除 HTML 注释（<!-- ... -->）
    const tplNoComment = tpl.replace(/<!--[\s\S]*?-->/g, '')
    // 检测 CJK Unified Ideographs U+4E00-U+9FFF
    const cjkMatches = tplNoComment.match(/[\u4e00-\u9fff]/g) || []
    if (cjkMatches.length > 0) {
      // 输出首个 CJK 字符所在行（帮助定位）
      const lines = tplNoComment.split('\n')
      let firstLine = -1
      for (let i = 0; i < lines.length; i++) {
        if (/[\u4e00-\u9fff]/.test(lines[i])) {
          firstLine = i + 1
          break
        }
      }
      throw new Error(
        `${rel} 模板含 ${cjkMatches.length} 个 CJK 字符，首个在第 ${firstLine} 行: ${cjkMatches.slice(0, 3).join('')}`,
      )
    }
  })
})

/**
 * U8a: extractTemplate 嵌套 <template> 盲区回归锁定。
 *
 * 旧实现（非贪婪正则 /<template>([\s\S]*?)<\/template>/）在第一个 </template>
 * 截断——组件内嵌套 <template>（slot / v-if）之后的模板后半段不参与 CJK 扫描。
 * 栈深度修复后全段可达；以下 fixture 用例防正则退化回潜（合成源码直接单测提取器，
 * 不依赖 components 目录的偶然形态）。
 */
describe('U8a: extractTemplate 嵌套 <template> 盲区（回归锁定）', () => {
  /** 嵌套闭合之后的模板后段含 CJK——旧正则的 0 检出盲区形态。 */
  const nestedFixture = [
    '<template>',
    '  <div>outer before</div>',
    '  <Comp>',
    '    <template #header>',
    '      <span>inner</span>',
    '    </template>',
    '  </Comp>',
    '  <p>嵌套闭合之后的中文残留</p>',
    '  <template v-if="ok"><em>二层嵌套中文</em></template>',
    '</template>',
    '<script setup lang="ts">',
    '// script 段中文注释不应入扫描',
    '</script>',
  ].join('\n')

  it('顶层块完整覆盖到配对闭标签（嵌套闭合之后的后段仍参与扫描）', () => {
    const tpl = extractTemplate(nestedFixture)
    expect(tpl).toContain('outer before')
    expect(tpl).toContain('inner')
    expect(tpl).toContain('嵌套闭合之后的中文残留') // 旧正则截断点之后
    expect(tpl).toContain('二层嵌套中文')
    expect(tpl).not.toContain('script 段中文注释') // 顶层闭标签后不外溢
    // CJK 检出面（U8 同款剥离注释后计数）非空——盲区形态下后段 2 处全漏
    expect(tpl.replace(/<!--[\s\S]*?-->/g, '').match(/[\u4e00-\u9fff]/g)).not.toBeNull()
  })

  it('自闭合内部 <template #slot /> 不破坏深度计数', () => {
    const source = [
      '<template>',
      '  <Comp>',
      '    <template #header />',
      '    <template #footer><i>x</i></template>',
      '  </Comp>',
      '  <p>自闭合之后的中文</p>',
      '</template>',
    ].join('\n')
    const tpl = extractTemplate(source)
    expect(tpl).toContain('自闭合之后的中文')
    // 块体不含顶层开标签本身（与旧捕获组语义一致；内部带属性的 <template #...> 不受影响）
    expect(tpl).not.toContain('<template>')
  })

  it('无 template 块返回空串（原语义不变）', () => {
    expect(extractTemplate('<script setup lang="ts"></script>')).toBe('')
  })
})

/**
 * U9: locale 消息字符串无裸 `@`（vue-i18n linked-message 语法冲突守卫）。
 *
 * 背景：vue-i18n message format 里 `@` 是 linked message 起始符，消息值里的字面 `@`
 * （如「调用 @subagent 工具」）会被编译器按 linked 语法解析 → 运行时 console 编译
 * 告警（2026-09-12 Gate B 真机验收在 `sidebar.subagentList.emptyHint` 实测）。修法 =
 * vue-i18n 字面量插值 `{'@'}` 转义（t() 输出仍为字面 @）。本守卫扫双侧全部消息
 * 字符串，剥掉合法 `{'@'}` 后仍含 `@` 即红——覆盖未来新增的任何 key。
 * [2026-09-16] 原事故锚二（侧栏子代理列表的空态提示键）随侧栏任务 tab 退役删除
 * （该键的消费组件同批退役，文案承载面迁 composer 任务托盘的 `panel.tray.*`，措辞去掉了
 * @subagent 提法）——运行时锚点收敛为下方唯一一条 `settings.preset.builtinExtensionHint`；
 * 上位「逐文件全量扫描」用例不受影响。
 */
describe('U9: locale 消息无裸 @（linked-message 语法冲突守卫）', () => {
  it.each(['zh-CN', 'en-US'] as const)('%s 全部消息字符串无未转义 @', (locale) => {
    const violations: string[] = []
    for (const file of listTsFiles(join(LOCALES_DIR, locale))) {
      const name = file.split('/').pop()
      for (const [key, value] of flattenEntries(loadLocaleObject(file))) {
        const stripped = value.split("{'@'}").join('')
        if (stripped.includes('@')) violations.push(`${locale}/${name} ${key}`)
      }
    }
    expect(
      violations,
      `裸 @ 触发 vue-i18n linked-message 编译告警，需用 {'@'} 转义：\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('转义 key 转义后 t() 输出含字面 @ 且编译零告警', async () => {
    const { createI18n } = await import('vue-i18n')
    const zhCN = (await import('../../i18n/locales/zh-CN')).default
    const logs: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => logs.push(`warn: ${String(args[0])}`))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(`error: ${String(args[0])}`))
    try {
      const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })
      expect(i18n.global.t('settings.preset.builtinExtensionHint')).toContain('@zhushanwen/pi-agent-ext')
      expect(logs).toEqual([])
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
