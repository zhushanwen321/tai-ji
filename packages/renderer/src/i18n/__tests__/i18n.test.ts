/**
 * renderer i18n 域测试合并文件（round6 测试提速，同被测对象簇：i18n 装配与 locale 资源）。
 *
 * 本文件由以下五文件原样搬运合并（describe/it 名零改动；三源原 node pragma 因
 * lazy-load 节需要 window/localStorage 统一为默认 happy-dom——fs 扫描节在 happy-dom
 * 下行为不变，实测绿灯）：
 * - src/__tests__/i18n/i18n-value-smoke.test.ts
 * - src/__tests__/i18n/locale-sync-check.test.ts
 * - src/__tests__/i18n/locale-key-usage-guard.test.ts（含三节裸块；zhCN 绑定更名
 *   zhCNAggregated 防与 compile 节撞名）
 * - src/__tests__/i18n/locale-message-compile.test.ts（zhCN/enUS 更名 zhCNFull/enUSFull）
 * - src/__tests__/i18n/i18n-lazy-load.test.ts（resetModules + 动态 import 自隔离）
 *
 * 目录位移注：src/__tests__/i18n/ 与 src/i18n/__tests__/ 同深（src/<x>/__tests__/），
 * 各 __dirname 相对锚（'../../components'、'../../i18n/locales'、style.css 类）与
 * REPO_ROOT 上溯 5 级均不变；唯 locale-key-usage-guard 的 locale 聚合 import 改
 * '../locales/zh-CN'。
 *
 * 运行：cd packages/renderer && npx vitest run src/i18n/__tests__/i18n.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ══════════════ 源: src/__tests__/i18n/i18n-value-smoke.test.ts ══════════════
/**
 * i18n 翻译值 smoke（原 panel-i18n-p2 / thinking-levels-i18n / w3-i18n-keys 三文件并入——
 * 同质同构：无 mock、直 import locale 模块或 i18n 单例，锁「key 存在 + 翻译值」双语文案）。
 *
 * 覆盖：
 * - panel.git 按钮与状态 pill 的 en-US 值 + 源码 t() 接线（GitPanel）
 * - SideDrawer tab / SegmentedTab label 走 i18n key（不回退 key 本身）
 * - SegmentedTab.vue 不再含 'Agents'/'Flows' 英文硬编码（locale-sync-check U8 只防 CJK，
 *   此断言是其英文侧补集）
 * - thinking-levels 7 档 labelKey 完整 + getDisplayLabel 双语值 + minimal 补齐（U10）
 * - THINKING_STRATEGIES 3 项 labelKey + en-US 值
 * - sidebar.update 静态字面键（newVersionWithVersion / versionTransition / downloading /
 *   error / retry 等）双语存在 + 插值占位符（{version}/{from}/{to}）；升级失败 toast 的
 *   upgradeFailed 族键
 *   是真正的动态组装键（use-app-update-errors.ts 的 resolveFailedToastKey 拼接
 *   `sidebar.update.${mapped}` / upgradeFailedInstaller / 兜底 upgradeFailed，
 *   escape 出 locale-key-usage-guard 的字面扫描，键存在性由 upgradeFailed* 专用用例检查）
 * - settings.update testProxy keys 完整性
 * - landing 模式改名（D4）值的回归锁定：`newTask.presetSelect.*` 用「模式」措辞
 *   （R3 补完——landing 侧曾漏改，改名落地无测试覆盖即会再次回退）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/i18n/i18n-value-smoke.test.ts
 */
import i18n, { setLocale } from '@/i18n'
import zhCN from '@/i18n/locales/zh-CN/sidebar'
import enUS from '@/i18n/locales/en-US/sidebar'
import zhCNSettings from '@taiji/ui/locale/zh-CN/settings'
import enUSSettings from '@taiji/ui/locale/en-US/settings'
import zhNewTask from '@taiji/ui/locale/zh-CN/newTask'
import enNewTask from '@taiji/ui/locale/en-US/newTask'
import {
  THINKING_LEVELS,
  getDisplayLabel,
} from '@/components/panel/thinking-levels'
import { THINKING_STRATEGIES } from '@taiji/core'

// ── panel（原 panel-i18n-p2.test.ts U5）──

describe('GitPanel en-US locale 显示英文按钮 + 状态 pill', () => {
  it('Stage / Unstage / Commit 三按钮英文文案 + 源码走 t()', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('panel.git.stage')).toBe('Stage')
    expect(i18n.global.t('panel.git.unstage')).toBe('Unstage')
    expect(i18n.global.t('panel.git.commit')).toBe('Commit')
    // 源码验证模板走 t() 调用（非硬编码）
    const source = readFileSync(
      resolve(__dirname, '../../components/panel/GitPanel.vue'),
      'utf-8',
    )
    expect(source).toContain("t('panel.git.stage')")
    expect(source).toContain("t('panel.git.unstage')")
    expect(source).toContain("t('panel.git.commit')")
  })

  it('状态 pill en-US 值: Clean / Staged / Dirty / Conflict', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('panel.git.pillClean')).toBe('Clean')
    expect(i18n.global.t('panel.git.pillStaged')).toBe('Staged')
    expect(i18n.global.t('panel.git.pillDirty')).toBe('Dirty')
    expect(i18n.global.t('panel.git.pillConflict')).toBe('Conflict')
  })

  it('SideDrawer tab label 走 i18n key', async () => {
    await setLocale('en-US')
    // tabTerminal / tabBrowser / tabGit / tabDoc / tabDetail / tabTrace key 存在且非空
    for (const k of ['tabTerminal', 'tabBrowser', 'tabGit', 'tabDoc', 'tabDetail', 'tabTrace']) {
      const label = i18n.global.t(`panel.sideDrawer.${k}`)
      expect(label).toBeTruthy()
      expect(label).not.toBe(`panel.sideDrawer.${k}`)
    }
  })
})

// ── sidebar（原 panel-i18n-p2.test.ts U6）──

describe('Sidebar zh-CN locale + SegmentedTab tab label i18n', () => {
  it('sessionList 错误态重试按钮 === \'重试\'（zh-CN）', async () => {
    await setLocale('zh-CN')
    expect(i18n.global.t('sidebar.retry')).toBe('重试')
  })

  it('SegmentedTab tab label 走 i18n key（三 tab 终态：session/file/plugin）', async () => {
    await setLocale('zh-CN')
    const sessionLabel = i18n.global.t('sidebar.segmentedTab.session')
    const fileLabel = i18n.global.t('sidebar.segmentedTab.file')
    const pluginLabel = i18n.global.t('sidebar.segmentedTab.plugin')
    expect(sessionLabel).toBeTruthy()
    expect(fileLabel).toBeTruthy()
    expect(pluginLabel).toBeTruthy()
    // 不应回退到 key 本身（说明 key 缺失）
    expect(sessionLabel).not.toBe('sidebar.segmentedTab.session')
    expect(fileLabel).not.toBe('sidebar.segmentedTab.file')
    expect(pluginLabel).not.toBe('sidebar.segmentedTab.plugin')
  })

  it('SegmentedTab.vue 源码不再含 \'Agents\' / \'Flows\' 硬编码字面量', () => {
    const source = readFileSync(
      resolve(__dirname, '../../components/sidebar/SegmentedTab.vue'),
      'utf-8',
    )
    expect(source).not.toMatch(/label:\s*['"]Agents['"]/)
    expect(source).not.toMatch(/label:\s*['"]Flows['"]/)
    // 2026-09-16 三 tab 终态：subagents / workflows 两枚 tab 值不再出现在 tab 定义里
    expect(source).not.toMatch(/value:\s*['"]subagents['"]/)
    expect(source).not.toMatch(/value:\s*['"]workflows['"]/)
  })
})

// ── thinking-levels（原 thinking-levels-i18n.test.ts；死 import ThinkingLevelPopover 已删）──

describe('thinking-levels 数据源 i18n 化', () => {
  it('THINKING_LEVELS 7 档 labelKey 双语可解析（非 key 回退）', async () => {
    expect(THINKING_LEVELS).toHaveLength(7)
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await setLocale(locale)
      for (const opt of THINKING_LEVELS) {
        expect(opt.labelKey).toBeDefined()
        expect(typeof opt.labelKey).toBe('string')
        expect(opt.labelKey).toMatch(/^composable\.thinkingLevel\./)
        // 缺 key 时 vue-i18n 回退为 key 本身——解析值等于 key 即漏翻
        expect(i18n.global.t(opt.labelKey!)).not.toBe(opt.labelKey)
      }
    }
  })

  it('en-US + on-off map 时 high 档 currentLabel === \'On\'', async () => {
    await setLocale('en-US')
    // on-off 模式：map 只有 off + high
    const map = { off: 'off', high: 'high' }
    const label = getDisplayLabel('high', map)
    expect(label).toBe('On')
  })

  it('zh-CN + 全档 map 时 high 档 currentLabel === \'高\'', async () => {
    await setLocale('zh-CN')
    const map = { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
    const label = getDisplayLabel('high', map)
    expect(label).toBe('高')
  })

  it('THINKING_STRATEGIES 3 项 labelKey 双语可解析（非 key 回退；en-US 精确值由下方用例锁定）', async () => {
    expect(THINKING_STRATEGIES).toHaveLength(3)
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await setLocale(locale)
      for (const s of THINKING_STRATEGIES) {
        expect(s.labelKey).toBeDefined()
        expect(typeof s.labelKey).toBe('string')
        expect(s.labelKey).toMatch(/^composable\.thinkingStrategy\./)
        expect(i18n.global.t(s.labelKey!)).not.toBe(s.labelKey)
      }
    }
  })

  it('en-US locale 下 THINKING_STRATEGIES 翻译为 All Levels / On / Off / High / Max', async () => {
    await setLocale('en-US')
    const labels = THINKING_STRATEGIES.map((s) => i18n.global.t(s.labelKey!))
    expect(labels).toEqual(['All Levels', 'On / Off', 'High / Max'])
  })

  it('zh-CN/en-US 均存在 composable.thinkingLevel.minimal（pi 七档枚举补齐）', async () => {
    const minimalOpt = THINKING_LEVELS.find((o) => o.level === 'minimal')
    expect(minimalOpt).toBeDefined()
    await setLocale('zh-CN')
    expect(i18n.global.t(minimalOpt!.labelKey)).toBe('极简')
    await setLocale('en-US')
    expect(i18n.global.t(minimalOpt!.labelKey)).toBe('Minimal')
  })
})

// ── sidebar.update / settings.update keys（原 w3-i18n-keys.test.ts）──

describe('sidebar.update / settings.update 双语 keys 存在', () => {
  it('sidebar.update 新增 keys 中英双语存在（含插值占位符）', () => {
    // newVersionWithVersion
    expect(zhCN.update.newVersionWithVersion).toBeDefined()
    expect(enUS.update.newVersionWithVersion).toBeDefined()
    expect(zhCN.update.newVersionWithVersion).toContain('{version}')
    expect(enUS.update.newVersionWithVersion).toContain('{version}')

    // versionTransition
    expect(zhCN.update.versionTransition).toBeDefined()
    expect(enUS.update.versionTransition).toBeDefined()
    expect(zhCN.update.versionTransition).toContain('{from}')
    expect(zhCN.update.versionTransition).toContain('{to}')
    expect(enUS.update.versionTransition).toContain('{from}')
    expect(enUS.update.versionTransition).toContain('{to}')
  })

  it('sidebar.update 原有 keys 仍存在', () => {
    expect(zhCN.update.newVersion).toBeDefined()
    expect(enUS.update.newVersion).toBeDefined()
    expect(zhCN.update.downloading).toBeDefined()
    expect(enUS.update.downloading).toBeDefined()
    expect(zhCN.update.error).toBeDefined()
    expect(enUS.update.error).toBeDefined()
    expect(zhCN.update.retry).toBeDefined()
    expect(enUS.update.retry).toBeDefined()
  })

  it('sidebar.update.upgradeFailed* 族（动态组装键）生产源码与双语 locale 对齐', () => {
    // 键清单从生产动态组装点提取（use-app-update-errors.ts：LAUNCH_FAILURE_ERROR_KEYS
    // 值 + win 安装器动态码 + 兜底 upgradeFailed），防新增键漏翻或键名漂移
    const source = readFileSync(
      resolve(__dirname, '../../composables/features/settings/use-app-update-errors.ts'),
      'utf-8',
    )
    const prodKeys = [...new Set(source.match(/upgradeFailed[A-Za-z]*/g) ?? [])].sort()

    // 实际键名集合：兜底 1 + 错误码细分 8 + win 安装器动态码 1
    const registeredKeys = [
      'upgradeFailed',
      'upgradeFailedAppRunning',
      'upgradeFailedBackup',
      'upgradeFailedExtract',
      'upgradeFailedInstaller',
      'upgradeFailedInternal',
      'upgradeFailedMove',
      'upgradeFailedReadOnly',
      'upgradeFailedSha',
      'upgradeFailedSwap',
    ] as const
    expect(prodKeys).toEqual([...registeredKeys].sort())

    // 全部键 zh-CN / en-US 双语存在
    for (const k of registeredKeys) {
      expect(zhCN.update[k]).toBeDefined()
      expect(enUS.update[k]).toBeDefined()
    }
  })

  it('settings.update testProxy 相关 keys 存在', () => {
    expect(zhCNSettings.update.testProxy).toBeDefined()
    expect(enUSSettings.update.testProxy).toBeDefined()
    expect(zhCNSettings.update.testSuccess).toBeDefined()
    expect(enUSSettings.update.testSuccess).toBeDefined()
    expect(zhCNSettings.update.testFailed).toBeDefined()
    expect(enUSSettings.update.testFailed).toBeDefined()
  })
})

// ── landing 模式改名（D4，设计 `mode-system-composer-density` §6.4）──

describe('landing 改名 D4：newTask.presetSelect 用户可见文案用「模式」', () => {
  it('zh-CN 标题 / 空态不做旧词，锁定 tooltip 用「以「{name}」创建」', async () => {
    await setLocale('zh-CN')
    expect(i18n.global.t('newTask.presetSelect.title')).toBe('选择启动模式')
    expect(i18n.global.t('newTask.presetSelect.noPresets')).toBe('暂无模式')
    // 占位符必须是 {name}（消费方 @taiji/ui PresetSelectChip.vue 传 { name }）
    expect(
      i18n.global.t('newTask.presetSelect.presetLockedTooltip', { name: '调度模式' }),
    ).toBe('此会话以「调度模式」创建，不可更改')
  })

  it('en-US 镜像同义文案（title / 空态 / 锁定 tooltip）', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('newTask.presetSelect.title')).toBe('Launch mode')
    expect(i18n.global.t('newTask.presetSelect.noPresets')).toBe('No modes')
    expect(
      i18n.global.t('newTask.presetSelect.presetLockedTooltip', { name: 'Dispatch' }),
    ).toBe('This session was created with "Dispatch" and cannot be changed')
  })

  it('已改值的叶子不含旧词（zh「预设」/ en "preset"）', () => {
    // 词表断言（不经 t()）：防未来用「旧词 + 模式」这类混合形态绕过
    expect(zhNewTask.presetSelect.title).not.toContain('预设')
    expect(zhNewTask.presetSelect.noPresets).not.toContain('预设')
    expect(zhNewTask.presetSelect.legacySessionTooltip).not.toContain('预设')
    expect(enNewTask.presetSelect.title.toLowerCase()).not.toContain('preset')
    expect(enNewTask.presetSelect.noPresets.toLowerCase()).not.toContain('preset')
    expect(enNewTask.presetSelect.legacySessionTooltip.toLowerCase()).not.toContain('preset')
  })
})

// ══════════════ 源: src/__tests__/i18n/locale-sync-check.test.ts ══════════════
/**
 * i18n-frontend-p2 U7 + U8: locale key 双侧对齐 + 组件模板 CJK 残留扫描（W5）。
 *
 * U7: 扫 packages/renderer/src/i18n/locales/zh-CN 与 en-US 双侧，断言每个子模块
 *     文件 key 集合完全一致（嵌套 key 也算）。
 * U8: 扫 components 下所有 .vue 文件的 template 块，断言无新增 CJK 字符（豁免清单外）。
 *
 * 这两个测试是"机械门禁"——任何漏网的中文 UI 文案或 locale desync 都会被捕获。
 */

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales')
const COMPONENTS_DIR = resolve(__dirname, '../../components')

interface LocaleObject {  // oe-exempt:20261027:test:
  [key: string]: string | LocaleObject
}

/** 读 .ts locale 文件为对象（export default {...}） */
function loadLocaleObject(filePath: string): LocaleObject {
  const src = readFileSync(filePath, 'utf-8')
  // 极简解析：只支持 export default { ... } 形式（项目内 locale 全是这种）
  const match = src.match(/export\s+default\s+(\{[\s\S]*\})\s*$/)
  if (!match) throw new Error(`无法解析 locale 文件: ${filePath}`)
  // 用 Function 构造器 + 闭包模拟（避免引入额外依赖）
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 用 Function 构造器模拟 locale 表达式求值是该测试的被测机制本身（避免引入额外求值依赖）
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
 * 逃过 U8 CJK 扫描（审查 F4 盲区）。自关闭（<template #slot />）不进栈
 * （alternation 自关闭分支在前，防 [^>]*> 先吞）。
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
      continue // 自关闭：无块体，不影响深度
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
  /** 嵌套结束标签之后的模板后段含 CJK——旧正则的 0 检出盲区形态。 */
  const nestedFixture = [
    '<template>',
    '  <div>outer before</div>',
    '  <Comp>',
    '    <template #header>',
    '      <span>inner</span>',
    '    </template>',
    '  </Comp>',
    '  <p>嵌套结束标签之后的中文残留</p>',
    '  <template v-if="ok"><em>二层嵌套中文</em></template>',
    '</template>',
    '<script setup lang="ts">',
    '// script 段中文注释不应入扫描',
    '</script>',
  ].join('\n')

  it('顶层块完整覆盖到配对闭标签（嵌套结束标签之后的后段仍参与扫描）', () => {
    const tpl = extractTemplate(nestedFixture)
    expect(tpl).toContain('outer before')
    expect(tpl).toContain('inner')
    expect(tpl).toContain('嵌套结束标签之后的中文残留') // 旧正则截断点之后
    expect(tpl).toContain('二层嵌套中文')
    expect(tpl).not.toContain('script 段中文注释') // 顶层闭标签后不外溢
    // CJK 检出面（U8 同款剥离注释后计数）非空——盲区形态下后段 2 处全漏
    expect(tpl.replace(/<!--[\s\S]*?-->/g, '').match(/[\u4e00-\u9fff]/g)).not.toBeNull()
  })

  it('自关闭内部 <template #slot /> 不破坏深度计数', () => {
    const source = [
      '<template>',
      '  <Comp>',
      '    <template #header />',
      '    <template #footer><i>x</i></template>',
      '  </Comp>',
      '  <p>自关闭之后的中文</p>',
      '</template>',
    ].join('\n')
    const tpl = extractTemplate(source)
    expect(tpl).toContain('自关闭之后的中文')
    // 块体不含顶层开标签本身（与旧捕获组语义一致；内部带属性的 <template #...> 不受影响）
    expect(tpl).not.toContain('<template>')
  })

  it('无 template 块返回空串（原语义不变）', () => {
    expect(extractTemplate('<script setup lang="ts"></script>')).toBe('')
  })
})

/**
 * U9: locale 消息字符串无裸 `@`（vue-i18n linked-message 语法冲突检查）。
 *
 * 背景：vue-i18n message format 里 `@` 是 linked message 起始符，消息值里的字面 `@`
 * （如「调用 @subagent 工具」）会被编译器按 linked 语法解析 → 运行时 console 编译
 * 告警（2026-09-12 Gate B 真机验收在 `sidebar.subagentList.emptyHint` 实测）。修法 =
 * vue-i18n 字面量插值 `{'@'}` 转义（t() 输出仍为字面 @）。本检查扫双侧全部消息
 * 字符串，剥掉合法 `{'@'}` 后仍含 `@` 即红——覆盖未来新增的任何 key。
 * [2026-09-16] 原事故锚二（侧栏子代理列表的空态提示键）随侧栏任务 tab 退役删除
 * （该键的消费组件同批退役，文案承载面迁 composer 任务托盘的 `panel.tray.*`，措辞去掉了
 * @subagent 提法）——运行时锚点收敛为下方唯一一条 `settings.preset.builtinExtensionHint`；
 * 上位「逐文件全量扫描」用例不受影响。
 */
describe('U9: locale 消息无裸 @（linked-message 语法冲突检查）', () => {
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

// ══════════════ 源: src/__tests__/i18n/locale-key-usage-guard.test.ts ══════════════
/**
 * 反向检查：`panel.*` / `settings.providerEdit.*` / `composable.*` 的 locale 叶子 key 必须被源码消费。
 *
 * 存在动机：
 * 仓库已有「引用 → 存在」检查（provider-edit-key-existence.test.ts，防裸 key 透出），
 * 但没有反方向检查，于是多年迭代后 locale 里积累了大量零引用死键（本检查落地时
 * 一次清扫了 97 条，见 commit message）。本测试补上「存在 → 被引用」这条通路。
 *
 * 判定语义：
 * - 消费者 = 仓库源码里的字面全路径引用（`t('panel.x.y')`、key 映射表里的字符串等）。
 *   `__tests__` / `*.test.*` / `e2e/` 不算消费者——测试断言只能证明「key 存在」，
 *   不能证明 UI 会渲染它（否则给死键补一行断言就能让检查永远绿）。
 * - 消费者之外，唯一合法豁免是 ALLOWLIST 里的显式条目（常量数组 + 逐条理由）。
 *   禁止整段正则/目录豁免——那会把检查变成橡皮图章。
 *
 * 自证不空转（防「扫描根写错 → 空集合恒绿」）：
 * - 叶子 key 数量与被引用数量都有下界断言；
 * - allowlist 必须与「实际零引用集合」精确相等——已恢复引用的 key 留在 allowlist 里
 *   同样会红，强制清理过期豁免。
 *
 * 扫描范围：仓库根由 import.meta.url 相对推导（不写死绝对路径），排除
 * node_modules / dist / .git / test-results 等产物目录与 locale 目录本体。
 *
 * 单文件多源合并（3 源同装载簇，全 node 环境源码扫描/locale 断言、零 vi.mock）：
 * locale-key-usage-guard（本节，最大源）+ provider-edit-key-existence +
 * usage-definition-check——三者路径推导均基于 __dirname / import.meta.url 的同目录
 * 相对上溯（合并文件仍在本目录，推导不变），扫描器均排除 __tests__（不自扫）。
 * 各节以裸块隔离节内常量与 helper（REPO_ROOT / SKIP_DIRS 等同名异值常量不串）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/i18n/locale-key-usage-guard.test.ts
 */
import zhPanel from '@taiji/ui/locale/zh-CN/panel'
import enPanel from '@taiji/ui/locale/en-US/panel'
import zhSettings from '@taiji/ui/locale/zh-CN/settings'
import enSettings from '@taiji/ui/locale/en-US/settings'
import zhComposable from '@taiji/ui/locale/zh-CN/composable'
import zhCNAggregated from '../locales/zh-CN'

type LocaleNode = { [key: string]: string | LocaleNode }

/** 仓库根：本文件位于 packages/renderer/src/i18n/__tests__/，上溯 5 级 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** 扫描的源码后缀（先明确集合，避免把产物/文档/二进制读进来） */
const SOURCE_EXT = /\.(vue|ts|tsx|js|jsx|mjs|cjs)$/
/** 不递归进入的目录（产物 / 依赖 / 版本库 / 测试结果 / harness 记录） */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'out',
  'build',
  'coverage',
  'test-results',
  '.git',
  '.vite',
  'release',
  '.taiji-harness',
])
/** 测试文件不算消费者（理由见文件头） */
const TEST_PATH = new RegExp(`${sep}__tests__${sep}|${sep}e2e${sep}|\\.test\\.|\\.spec\\.`)

/**
 * 显式 allowlist：零字面引用但允许保留的 key。
 * 每条必须写清「为什么留」；动态组装可达的必须写明构造点 file:line。
 * 当前无动态组装可达项（生产源码里 `panel.*` / `settings.providerEdit.*` 全部是字面引用；
 * 仅测试文件存在 `panel.sideDrawer.${k}` / `panel.trace.${k}` / `panel.context.${key}` 形式的
 * 模板拼接，而测试不是消费者，故不为它们开豁免）。
 */
const SUBAGENT_MODEL_SOURCE_REASON =
  '动态组装可达：packages/renderer/src/composables/features/subagent/useSubagentModel.ts:358 ' +
  '(`panel.sideDrawer.subagentModelSource.${source}`) 与 :362 ' +
  '(`panel.sideDrawer.subagentModelSourceTitle.${source}`)，source 取值域 = SubagentModelSource ' +
  '(packages/shared/src/subagent.ts:44, 即 explicit/frontmatter/preference/default)'

const ALLOWLIST: readonly { key: string; reason: string }[] = [
  { key: 'panel.sideDrawer.subagentModelSource.explicit', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSource.frontmatter', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSource.preference', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSource.default', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.explicit', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.frontmatter', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.preference', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.default', reason: SUBAGENT_MODEL_SOURCE_REASON },
  // chat-flow-consistency U1 停止/截断提示行：key 由 core notice-text.ts:40 动态组装
  //（`panel.message.chatNotice.${key}`，ChatNoticeKey 闭集枚举）经 useMessageEffects.ts:40
  // 的 translator 注入消费——静态字面扫描不可达，动态组装闭集登记于此。
  { key: 'panel.message.chatNotice.stoppedBeforeStart', reason: 'core notice-text ChatNoticeKey 闭集动态组装（notice-text.ts:40 + useMessageEffects.ts:40 translator 注入）' },
  { key: 'panel.message.chatNotice.truncatedMaxTokens', reason: 'core notice-text ChatNoticeKey 闭集动态组装（notice-text.ts:40 + useMessageEffects.ts:40 translator 注入）' },
  { key: 'panel.message.chatNotice.truncatedContentFilter', reason: 'core notice-text ChatNoticeKey 闭集动态组装（notice-text.ts:40 + useMessageEffects.ts:40 translator 注入）' },
]

/** 拍平嵌套 locale 对象为叶子 key 全路径 */
function flattenLeaves(node: LocaleNode, prefix: string): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const full = `${prefix}.${key}`
    if (value !== null && typeof value === 'object') out.push(...flattenLeaves(value, full))
    else out.push(full)
  }
  return out
}

/**
 * 扫全仓源码收集字面引用：对每个命名空间，把「命名空间 + 后续点分路径 + 引号收尾」
 * 整体取出（贪婪匹配到引号），因此更长的 key 不会被截断成短 key。
 */
function collectLiteralRefs(namespaces: readonly string[]): Set<string> {
  const refs = new Set<string>()
  const patterns = namespaces.map(
    (ns) => new RegExp(`\\b(${ns.replace(/\./g, '\\.')}\\.[A-Za-z0-9_.]+)(?=["'\`])`, 'g'),
  )
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (full.includes(`${sep}i18n${sep}locales${sep}`)) continue
      if (TEST_PATH.test(relative(REPO_ROOT, full))) continue
      const source = readFileSync(full, 'utf-8')
      if (!namespaces.some((ns) => source.includes(`${ns}.`))) continue
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) refs.add(match[1])
      }
    }
  }
  walk(REPO_ROOT)
  return refs
}

const NAMESPACES = ['panel', 'settings.providerEdit', 'composable'] as const
const LEAVES: Record<(typeof NAMESPACES)[number], string[]> = {
  panel: flattenLeaves(zhPanel as unknown as LocaleNode, 'panel'),
  'settings.providerEdit': flattenLeaves(
    (zhSettings as unknown as { providerEdit: LocaleNode }).providerEdit,
    'settings.providerEdit',
  ),
  composable: flattenLeaves(zhComposable as unknown as LocaleNode, 'composable'),
}

/**
 * 扫描通路自证下界（防空集合恒绿）。数值取当前真实量的安全打折值：
 * panel 369 / providerEdit 165 / composable 40 叶子、全仓扫到 500+ 引用——下界留在明显低于
 * 实况的档位，避免正常增删 key 触发假红，又足以在扫描根写错/正则失效时立刻暴露。
 */
const MIN_PANEL_LEAVES = 300
const MIN_PROVIDER_EDIT_LEAVES = 100
const MIN_COMPOSABLE_LEAVES = 30
const MIN_SCANNED_REFS = 300

const REFS = collectLiteralRefs(NAMESPACES)
const UNREFERENCED = NAMESPACES.flatMap((ns) => LEAVES[ns].filter((key) => !REFS.has(key)))
const ALLOWED = new Set(ALLOWLIST.map((entry) => entry.key))

describe('locale 反向检查：panel.* / settings.providerEdit.* / composable.* 无零引用死键', () => {
  it('扫描通路有效：叶子 key 与被引用数量都有合理下界（防空集合恒绿）', () => {
    expect(LEAVES.panel.length).toBeGreaterThan(MIN_PANEL_LEAVES)
    expect(LEAVES['settings.providerEdit'].length).toBeGreaterThan(MIN_PROVIDER_EDIT_LEAVES)
    expect(LEAVES.composable.length).toBeGreaterThan(MIN_COMPOSABLE_LEAVES)
    expect(REFS.size).toBeGreaterThan(MIN_SCANNED_REFS)
  })

  it('每个叶子 key 都被仓库源码引用（或登记在 ALLOWLIST）', () => {
    const problems = UNREFERENCED.filter((key) => !ALLOWED.has(key))
    const detail = problems
      .map(
        (key) =>
          `  - ${key}\n` +
          '      处置二选一：\n' +
          '        (1) 删键 —— 在 packages/ui/src/locale/{zh-CN,en-US}/ 对应文件里同号删除\n' +
          '            （locale-sync-check 检查要求双侧键集合一致，只删一侧会红）；\n' +
          '        (2) 保留 —— 仅当存在动态组装可达时，把 key 加入本文件顶部的 ALLOWLIST 常量，\n' +
          '            并在 reason 里写明「由哪一处、什么形式可达（file:line）」；无动态可达不得豁免。',
      )
      .join('\n')
    expect(
      problems,
      `以下 ${problems.length} 个 ${NAMESPACES.join(' / ')} 叶子 key 在仓库源码中零引用（疑似死键）：\n${detail}`,
    ).toEqual([])
  })

  it('ALLOWLIST 无过期条目：登记为豁免的 key 必须当前确实零引用', () => {
    const stale = ALLOWLIST.map((entry) => entry.key).filter((key) => !UNREFERENCED.includes(key))
    expect(
      stale,
      `以下 ALLOWLIST 条目已恢复（或本就存在）源码引用，属过期豁免，请从 ALLOWLIST 删除：\n${stale
        .map((key) => `  - ${key}`)
        .join('\n')}`,
    ).toEqual([])
  })
})

/** 按「Allowlist 键形态 = 动态组装可达」的前提，正向断言这些键在真实 locale 消息里可解析出文案 */
function resolveLocaleKey(messages: unknown, key: string): unknown {
  const path = key.split('.')
  return path.slice(1).reduce<unknown>(
    (node, segment) =>
      node !== null && typeof node === 'object'
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    messages,
  )
}

describe('ALLOWLIST 动态组装键的真实 i18n 解析断言', () => {
  it.each([
    ['zh-CN', zhPanel],
    ['en-US', enPanel],
  ] as const)('%s：每个动态组装键都解析到非空字符串（防键形态错配退化为显示键名）', (_locale, messages) => {
    for (const entry of ALLOWLIST) {
      const resolved = resolveLocaleKey(messages, entry.key)
      expect(resolved, `key ${entry.key} 在 ${_locale} locale 中不可解析`).toEqual(expect.any(String))
      expect(resolved as string).not.toBe('')
      expect(resolved as string).not.toBe(entry.key)
    }
  })
})


// ══════════ 来源：provider-edit-key-existence.test.ts ══════════
{

const REPO_ROOT = resolve(__dirname, '../../../../..')
/** providerEdit key 的源码消费根；locale 与测试自身不算消费方 */
const SCAN_ROOTS = [join(REPO_ROOT, 'packages/ui/src'), join(REPO_ROOT, 'packages/renderer/src')]
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist'])
const SOURCE_EXT = /\.(vue|ts|js|mjs)$/
/** `providerEdit.<key>` 且 key 后紧跟引号/反引号收尾（动态拼接不匹配） */
const KEY_REF = /providerEdit\.([A-Za-z0-9_]+)(?=["'`])/g
/**
 * `panel.context.quotaFail<Reason>` 字面引用（reason→key 映射表消费，见 useQuotaQuery.ts
 * QUOTA_FAIL_REASON_KEYS）。原 quota-reason-i18n.test.ts 的显式数组职责由本扫描吸收
 * （该数组范式曾自证失败：数组漏列 → 删 locale 值仍全绿，见原文件头 U-3 补齐记录）。
 * 限定 quotaFail 前缀：panel.context 下非 quota 语义的 key 不在本检查范围。 */
const PANEL_CONTEXT_KEY_REF = /panel\.context\.(quotaFail[A-Za-z0-9_]+)(?=["'`])/g

/** 本改动新增的 providerEdit key（locale 基线 62a9651e5 → HEAD 的 providerEdit 新增键全量） */
const NEW_UI_KEYS_REQUIRED = [
  'quotaTypeFirstHint',
  'quotaEnableHintIdle',
  'quotaProviderCredentialMissing',
  'quotaProviderCredentialPendingSave',
  'quotaExclusiveKeyPlaceholder',
  'quotaCredentialSourceLabel',
  'quotaSourceProvider',
  'quotaSourceExclusive',
  'quotaSourceProviderOauthHint',
  'quotaSourceProviderApiKeyHint',
  'quotaSourceExclusiveHint',
  'quotaConfigureFail',
  'quotaSaveAndTest',
  'quotaSaveAndTestRunning',
  'quotaReadyHint',
  'quotaMissingCookie',
  'quotaMissingApiKey',
  'quotaMissingWorkspace',
  'quotaSaveAndTestFail',
  'quotaFetchFailUnauthorizedCookie',
  'quotaFetchFailNoCredential',
  'quotaFetchFailNoCredentialCookie',
  'quotaRequiredBadge',
  'quotaConfiguredBadge',
] as const

type FlatLocale = Record<string, string | undefined>

const ZH_PROVIDER_EDIT = (zhSettings as unknown as { providerEdit: FlatLocale }).providerEdit
const EN_PROVIDER_EDIT = (enSettings as unknown as { providerEdit: FlatLocale }).providerEdit

/** 扫源码收集 `providerEdit.<key>` / `panel.context.quotaFail*` 引用；同 key 只记首个出现文件（用于报错定位） */
function collectSourceRefs(ref: RegExp): Map<string, string> {
  const refs = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (full.includes(`${sep}i18n${sep}locales${sep}`)) continue
      for (const m of readFileSync(full, 'utf-8').matchAll(ref)) {
        if (!refs.has(m[1])) refs.set(m[1], full)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return refs
}

describe('providerEdit i18n key 存在性机器门禁（U-3）', () => {
  const refs = collectSourceRefs(KEY_REF)
  // panel.context quotaFail 简短文案（原 quota-reason-i18n.test.ts 的 panel.context describe 并入）
  const panelContextRefs = collectSourceRefs(PANEL_CONTEXT_KEY_REF)

  it('源码扫描通路有效（扫到的 key 数量足以证明根路径与正则生效）', () => {
    expect(
      refs.size,
      '未从 packages/ui/src + packages/renderer/src 扫到足量 providerEdit key，扫描根/正则可能失效',
    ).toBeGreaterThan(100)
  })

  it('panel.context 扫描通路有效（quotaFail key 下界自证，防空集合恒绿）', () => {
    expect(
      panelContextRefs.size,
      `panel.context.quotaFail 扫描数量异常（期望 ≥6 个 reason 映射，实得 ${panelContextRefs.size}），扫描根/正则可能失效`,
    ).toBeGreaterThanOrEqual(6)
  })

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 本改动新增的 ${NEW_UI_KEYS_REQUIRED.length} 个 providerEdit key 都存在且非空`, () => {
      const providerEdit = locale === 'zh-CN' ? ZH_PROVIDER_EDIT : EN_PROVIDER_EDIT
      const missing = NEW_UI_KEYS_REQUIRED.filter((key) => {
        const value = providerEdit[key]
        return typeof value !== 'string' || value.trim().length === 0
      })
      expect(missing, `${locale} 缺失/空值的新增 key: ${missing.join(', ')}`).toEqual([])
    })
  }

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被 UI/renderer 源码引用的 providerEdit key 都存在且非空`, () => {
      const providerEdit = locale === 'zh-CN' ? ZH_PROVIDER_EDIT : EN_PROVIDER_EDIT
      const problems: string[] = []
      for (const [key, file] of refs) {
        const value = providerEdit[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }

  const ZH_PANEL_CONTEXT = (zhPanel as unknown as { context: FlatLocale }).context
  const EN_PANEL_CONTEXT = (enPanel as unknown as { context: FlatLocale }).context
  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被源码引用的 panel.context.quotaFail key 都存在且非空`, () => {
      const context = locale === 'zh-CN' ? ZH_PANEL_CONTEXT : EN_PANEL_CONTEXT
      const problems: string[] = []
      for (const [key, file] of panelContextRefs) {
        const value = context[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }
})

}

// ══════════ 来源：usage-definition-check.test.ts ══════════
{

// ── 定义面：聚合树叶子路径全集 ──────────────────────────────────────────────

const definedLeafKeys = new Set<string>()

function collectPaths(node: unknown, prefix: string): void {
  if (node === null || typeof node !== 'object') {
    definedLeafKeys.add(prefix)
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    collectPaths(v, prefix ? `${prefix}.${k}` : k)
  }
}

collectPaths(zhCNAggregated, '')
const namespaces = new Set(Object.keys(zhCNAggregated))

/** key 在定义树存在 = 叶子，或是有子节点的内部节点（后者承载「拼接子 key」类用法，
 * 如 settings.compat.thinkingFormat.options + '.${suffix}' 的选项前缀组合）。 */
function isDefined(key: string): boolean {
  if (definedLeafKeys.has(key)) return true
  const prefix = `${key}.`
  for (const k of definedLeafKeys) {
    if (k.startsWith(prefix)) return true
  }
  return false
}

// ── 使用面：源码扫描（renderer + ui 双根；locale 定义文件本身排除）──────────

const RENDERER_SRC = resolve(__dirname, '../..')
const UI_SRC = resolve(__dirname, '../../../../ui/src')
const SCAN_EXTENSIONS = new Set(['.vue', '.ts', '.tsx'])

/** 测试文件不算使用面（与 locale-key-usage-guard 反向守卫同口径：测试里的假 key 是
 * mock 形态不是渲染真值，扫入只产噪声；D3 的 9 个错位 key 全在生产源码）。 */
function isTestFile(path: string): boolean {
  return /__tests__\/|\.test\.|\.spec\./.test(path)
}

/** 定义文件排除：locale 对象的键名/值不是使用面（键是裸词、值是文案），扫入只产噪声。 */
function isDefinitionFile(path: string): boolean {
  return path.includes(`${join('i18n', 'locales')}/`) || path.includes(`${join('locale')}/`)
}

function walkSources(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules') continue
      walkSources(full, out)
    } else if (SCAN_EXTENSIONS.has(name.slice(name.lastIndexOf('.'))) && !name.endsWith('.d.ts') && !isDefinitionFile(full) && !isTestFile(full)) {
      out.push(full)
    }
  }
}

const sources: string[] = []
walkSources(RENDERER_SRC, sources)
walkSources(UI_SRC, sources)

/** 静态 key 字面量（单双引号——t() 直调、映射表值、测试断言里的 key 同扫）。 */
const EXACT_RE = /['"]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)['"]/g
/** 动态模板前缀（反引号 + 插值——取 ${ 前的静态前缀段）。 */
const TEMPLATE_PREFIX_RE = /`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)\$\{/g
/** 反引号整 key（无插值）。 */
const TEMPLATE_EXACT_RE = /`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)`/g

/**
 * 白名单（b 路线）：字面形态与 i18n key 无法区分的非 i18n 字面量。
 * 新增条目必须带 reason；撤销时连 reason 一并删。
 */
const USAGE_WHITELIST: ReadonlyArray<{ literal: string; kind: 'exact' | 'prefix'; reason: string }> = [
  {
    literal: 'canvas.updated',
    kind: 'exact',
    reason: 'runtime broker 全局广播事件名（WS 消息类型，use-canvas-sync 订阅）——canvas 恰为 i18n 顶层命名空间，形态无法区分',
  },
  {
    literal: 'app.config.errorHandler',
    kind: 'exact',
    reason: 'Vue 全局错误处理器 API 名（boot/error-reporter 注释引用），非 i18n key',
  },
  {
    literal: 'find.query.value',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（FindBar v-model="find.query.value"），非 i18n key',
  },
  { literal: 'btw.create', kind: 'exact', reason: 'WS 消息类型（ServerMessageMap 索引 / command 名），btw 恰为 i18n 命名空间' },
  { literal: 'btw.remove', kind: 'exact', reason: 'WS 消息类型（command 名）' },
  {
    literal: 'sidebar.collapsed',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（v-if="sidebar.collapsed"），非 i18n key',
  },
  {
    literal: 'sidebar.widthPx',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（SidebarResizeHandle :aria-valuenow="sidebar.widthPx"），非 i18n key',
  },
  {
    literal: 'sidebar.activeTab',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（v-model="sidebar.activeTab"），非 i18n key',
  },
  { literal: 'panel.header', kind: 'exact', reason: 'PanelHeader 的 view-id 标识字符串（视图定位 id），非 i18n key' },
  { literal: 'app.info', kind: 'exact', reason: 'runtime 全局广播事件名（onGlobalType 订阅），非 i18n key' },
  { literal: 'app.thinking.cycle', kind: 'exact', reason: 'composer 快捷动作 ID（快捷键映射表值），非 i18n key' },
  { literal: 'app.model.cycleForward', kind: 'exact', reason: 'composer 快捷动作 ID（同上）' },
  { literal: 'app.model.cycleBackward', kind: 'exact', reason: 'composer 快捷动作 ID（同上）' },
  { literal: 'app.message.copy', kind: 'exact', reason: 'composer 快捷动作 ID（同上）' },
  { literal: 'sidebar.tab', kind: 'exact', reason: '扩展宿主 placement 枚举值（placement === "sidebar.tab"），非 i18n key' },
  { literal: 'rollingRestart.status', kind: 'exact', reason: 'RPC 命令名（command("rollingRestart.status")），非 i18n key' },
  { literal: 'workspace.detected', kind: 'exact', reason: 'WS 消息类型（ServerMessageMap 索引），非 i18n key' },
]

interface Violation { // oe-exempt:20261015:test:守卫违规条目形状（测试 harness 数据结构，非抽象接口单实现）
  file: string
  line: number
  kind: 'exact' | 'prefix'
  literal: string
}

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++
  return line
}

const violations: Violation[] = []

for (const file of sources) {
  const content = readFileSync(file, 'utf-8')
  const checkExact = (key: string, index: number): void => {
    if (!namespaces.has(key.split('.')[0])) return
    if (USAGE_WHITELIST.some((w) => w.kind === 'exact' && w.literal === key)) return
    if (!isDefined(key)) violations.push({ file, line: lineOf(content, index), kind: 'exact', literal: key })
  }
  const checkPrefix = (prefix: string, index: number): void => {
    if (!namespaces.has(prefix.split('.')[0])) return
    if (USAGE_WHITELIST.some((w) => w.kind === 'prefix' && w.literal === prefix)) return
    let hasAnchor = false
    for (const k of definedLeafKeys) {
      if (k.startsWith(prefix)) {
        hasAnchor = true
        break
      }
    }
    if (!hasAnchor) violations.push({ file, line: lineOf(content, index), kind: 'prefix', literal: prefix })
  }
  for (const m of content.matchAll(EXACT_RE)) checkExact(m[1], m.index ?? 0)
  for (const m of content.matchAll(TEMPLATE_EXACT_RE)) checkExact(m[1], m.index ?? 0)
  for (const m of content.matchAll(TEMPLATE_PREFIX_RE)) checkPrefix(m[1], m.index ?? 0)
}

describe('i18n 使用面 vs 定义面守卫', () => {
  it('源码引用的每个静态 key 都在 zh-CN 聚合树中存在', () => {
    const exactMisses = violations.filter((v) => v.kind === 'exact')
    expect(
      exactMisses.map((v) => `${v.file.replace(RENDERER_SRC, '<renderer>').replace(UI_SRC, '<ui>')}:${v.line} → ${v.literal}`),
    ).toEqual([])
  })

  it('每个动态模板前缀在定义树中至少有一个落点 key', () => {
    const prefixMisses = violations.filter((v) => v.kind === 'prefix')
    expect(
      prefixMisses.map((v) => `${v.file.replace(RENDERER_SRC, '<renderer>').replace(UI_SRC, '<ui>')}:${v.line} → ${v.literal}*`),
    ).toEqual([])
  })

  it('定义树非空（聚合树 import 未被构建变化打断）', () => {
    expect(definedLeafKeys.size).toBeGreaterThan(100)
    expect(namespaces.has('panel')).toBe(true)
  })
})

}

// ══════════════ 源: src/__tests__/i18n/locale-message-compile.test.ts ══════════════
import { baseCompile } from '@intlify/message-compiler'
import type { CompileError } from '@intlify/message-compiler'
import enUSFull from '@/i18n/locales/en-US'
import zhCNFull from '@/i18n/locales/zh-CN'

/**
 * renderer 组合 locale 的消息编译检查测试。
 *
 * 背景（2026-10-15 事故）：vue-i18n 懒编译——t(key) 首次渲染时才编译文案。文案里的
 * 裸 `{` 被当占位符起始，token 非法即抛 INVALID_TOKEN_IN_PLACEHOLDER（code 2）；裸 `@`
 * 抛 INVALID_LINKED_FORMAT（code 10）。编译发生在渲染函数内，同步 throw → 渲染树崩溃
 * （MCP 添加弹窗切「代码」tab 白屏：codeHint / codePlaceholder 含字面 JSON 花括号）。
 *
 * 本测试遍历 renderer 装配后的全量 messages（ui 域经 @taiji/ui/locale/* 传入 +
 * renderer 自有域），对每条叶子文案跑真实编译器——SSOT 聚合层另有同型检查
 * （packages/ui/src/locale/__tests__/locale.test.ts）。
 *
 * onError 必须挂「收集不抛」形态：裸调 baseCompile 不挂 onError 时解析器静默吞错，
 * 任何不挂 onError 的体检都是假绿。
 */

/** 深度遍历 messages 树，对每条叶子字符串跑真实消息编译器，收集编译错误（issue 形状就地内联，不留单一实现接口） */
function collectCompileIssues(locale: string, node: unknown, path: string) {
  const issues: { locale: string; path: string; code: number | undefined; message: string }[] = []
  if (typeof node === 'string') {
    let thrown: CompileError | null = null
    baseCompile(node, {
      location: false,
      jit: true,
      onError: (error) => {
        thrown ??= error
      },
    })
    if (thrown) issues.push({ locale, path, code: thrown.code, message: thrown.message })
    return issues
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectCompileIssues(locale, value, `${path}[${index}]`).forEach((issue) => issues.push(issue)))
    return issues
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectCompileIssues(locale, value, path ? `${path}.${key}` : key).forEach((issue) => issues.push(issue))
    }
  }
  return issues
}

describe('renderer 组合 locale 消息编译检查', () => {
  it('检查自检：已知坏样本（裸 { 与裸 @）必须被检出（防 walker 失效假绿）', () => {
    const issues = collectCompileIssues('self-check', { brace: '{ "x": 1 }', at: 'run pnpm --filter @taiji/x build' }, '')
    expect(issues.map((issue) => issue.path).sort()).toEqual(['at', 'brace'])
  })

  it.each([
    ['zh-CN', zhCNFull],
    ['en-US', enUSFull],
  ])('%s 全量叶子文案经 @intlify 消息编译器零编译错误', (locale, messages) => {
    const issues = collectCompileIssues(locale, messages, '')
    expect(issues).toEqual([])
  })
})

// ══════════════ 源: src/__tests__/i18n/i18n-lazy-load.test.ts ══════════════
/**
 * W03 Q1-2：i18n 惰性 locale 加载。
 *
 * - 默认（无偏好）启动只注册 zh-CN，en-US 不在初始 messages（动态 import 拆 chunk，不进首屏）
 * - setLocale('en-US') 动态 import + setLocaleMessage 后文案为英文，zh-CN 可切回
 * - en-US 偏好冷启动：模块解析（top-level await）完成即 en-US 可用，无回退闪烁
 * - 连续快速切换后写胜（过期的动态加载完成晚到不回写 locale）
 * - [Fix-2] fallbackLocale 'en-US' 懒加载的兜底恢复：启动后 idle 预载（幂等检查零重复注册）
 * - [Fix-3] en-US 动态 import 失败：内部 catch + 可操作 warn，locale 停留旧值、无 unhandledrejection
 *
 * 每个用例经 vi.resetModules + 动态 import 取全新模块实例（i18n 是模块级单例，
 * loadedLocales / initialLocale 都在模块状态里，不复位会互相污染）。
 */

const SYSTEM_KEY = 'taiji:system-settings'

async function importFreshI18n() {
  vi.resetModules()
  return import('@/i18n')
}

describe('i18n 惰性 locale 加载（Q1-2）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('默认（无偏好）启动只注册 zh-CN，en-US 未载入', async () => {
    const mod = await importFreshI18n()
    expect(mod.getLocale()).toBe('zh-CN')
    expect(Object.keys(mod.default.global.getLocaleMessage('zh-CN')).length).toBeGreaterThan(0)
    // en-US 未注册（动态 import 拆 chunk，不进首屏）
    expect(mod.default.global.getLocaleMessage('en-US')).toEqual({})
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it("setLocale('en-US') 后文案为英文，且 zh-CN 可切回", async () => {
    const mod = await importFreshI18n()
    await mod.setLocale('en-US')
    expect(mod.getLocale()).toBe('en-US')
    // 动态 import + setLocaleMessage 已注册 en-US messages
    expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
    expect(mod.default.global.t('settings.title')).toBe('Settings')
    // 切回 zh-CN（初始已载入，命中缓存）
    await mod.setLocale('zh-CN')
    expect(mod.getLocale()).toBe('zh-CN')
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it('en-US 偏好冷启动：模块解析完成即 en-US 可用（top-level await，无回退闪烁）', async () => {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ locale: 'en-US' }))
    const mod = await importFreshI18n()
    // import resolve 时 en-US 已在模块解析内补齐（否则首帧会是裸 key / 中文回退）
    expect(mod.getLocale()).toBe('en-US')
    expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
    expect(mod.default.global.t('settings.title')).toBe('Settings')
  })

  it('连续快速切换时后写胜：先发的 en-US 动态加载晚到不回写过期 locale', async () => {
    const mod = await importFreshI18n()
    const first = mod.setLocale('en-US') // 触发动态 import（较慢）
    await mod.setLocale('zh-CN') // zh-CN 已载入，立即生效（后写）
    await first // 先发的 en-US 加载完成，seq 已过期 → 不回写
    expect(mod.getLocale()).toBe('zh-CN')
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it('[Fix-2] fallback 预载：idle 回调触发后 en-US messages 已注册（zh-CN 缺 key 兜底恢复）', async () => {
    // happy-dom 无 requestIdleCallback，注入可控桩验证主路径（Electron/Chromium 走此路径；
    // 缺失环境的 setTimeout 回落调用同一 loadEnUsMessages，不单独展开）
    const idleCallbacks: Array<() => void> = []
    window.requestIdleCallback = ((cb: () => void) => {
      idleCallbacks.push(cb)
      return idleCallbacks.length
    }) as typeof window.requestIdleCallback
    try {
      const mod = await importFreshI18n()
      // 预载回调已注册，但尚未触发：en-US 仍未加载（不阻塞首屏）
      expect(idleCallbacks).toHaveLength(1)
      expect(mod.default.global.getLocaleMessage('en-US')).toEqual({})
      idleCallbacks[0]!() // 触发 idle 回调（内部 void loadEnUsMessages()）
      await vi.waitFor(() => {
        expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
      }, { interval: 1 })
      // fallback 兜底恢复：locale 仍 zh-CN，en-US messages 可供回退
      expect(mod.getLocale()).toBe('zh-CN')
    } finally {
      delete window.requestIdleCallback
    }
  })

  it('[Fix-2] en-US 已加载时 idle 预载零开销（幂等检查：不重复 import/setLocaleMessage）', async () => {
    const idleCallbacks: Array<() => void> = []
    window.requestIdleCallback = ((cb: () => void) => {
      idleCallbacks.push(cb)
      return idleCallbacks.length
    }) as typeof window.requestIdleCallback
    try {
      const mod = await importFreshI18n()
      await mod.setLocale('en-US') // en-US 已动态加载
      const before = mod.default.global.getLocaleMessage('en-US')
      // 此时触发启动时注册的 idle 预载回调：loadedLocales 幂等检查早退，
      // 不重复 import / setLocaleMessage → messages 对象引用不变
      idleCallbacks[0]!()
      await Promise.resolve()
      expect(mod.default.global.getLocaleMessage('en-US')).toBe(before)
      expect(mod.getLocale()).toBe('en-US')
    } finally {
      delete window.requestIdleCallback
    }
  })

  it('[Fix-3] en-US 动态 import 失败：可操作 warn + locale 停留旧值 + 无 unhandledrejection', async () => {
    vi.doMock('@/i18n/locales/en-US', () => {
      throw new Error('en-US chunk 404 (mock)')
    })
    try {
      const mod = await importFreshI18n()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // 失败在 setLocale 内部 catch：promise 正常 resolve（不会变 unhandledrejection）
        await expect(mod.setLocale('en-US')).resolves.toBeUndefined()
        // warn 被调且指向恢复动作（重试 setLocale / 检查构建产物），非静默
        expect(warnSpy).toHaveBeenCalled()
        const msgs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
        expect(msgs).toContain("setLocale('en-US')")
        expect(msgs).toContain('产物')
        // locale 停留旧值：messages 缺失下切换只会显示裸 key，不切换
        expect(mod.getLocale()).toBe('zh-CN')
        expect(mod.default.global.t('settings.title')).toBe('设置')
      } finally {
        warnSpy.mockRestore()
      }
    } finally {
      vi.doUnmock('@/i18n/locales/en-US')
    }
  })
})
