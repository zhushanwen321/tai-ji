/**
 * check-capability-allowlist-sync.mjs 单测（R1 一致性审查：守卫本体 + pre-commit 触发段已交付，
 * 但守卫自身无回归测试、--self-test 无自动化挂载点——比较逻辑（setDiff 被改成子集、第 ② 步被删）
 * 自身退化时无任何红灯。设计 §10 u1 点名「形态照搬 check-thinking-levels.mjs 双清单对拍先例」，
 * 先例正是为「守卫自身假绿」补的测试，故本守卫的回归保护形态随行补上。）
 *
 * 组织方式照同辈 check-thinking-levels.test.mjs 惯例：纯函数直测 + tmpdir fixture，CLI 集成用例
 * 把守卫脚本复制到 tmp mirror 运行（守卫 ROOT 由 import.meta.url 推导，副本位置使 ROOT 落在
 * mirror 内——篡改 fixture 才真正改到守卫读的文件，「篡改即红、还原即绿」的差分才成立）。
 *
 * 比对面成员集从真实仓库源文件动态提取（pi 无关、随真实交付面走）：绿 = fixture 与真实仓库一致；
 * 各漂移用例篡改任一侧 → exit 1，证明守卫非恒绿。另含真实仓库直跑用例（守卫对实际交付面绿）。
 *
 * 运行：cd <repo-root> && pnpm exec vitest run scripts/__tests__/check-capability-allowlist-sync.test.mjs
 * （ci.yml「Test - scripts guards」逐文件列举同款口径。）
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractInitializer,
  extractSubArrayLiterals,
  extractArrayConst,
  extractRecordValues,
} from '../check-capability-allowlist-sync.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(TEST_DIR, '..', 'check-capability-allowlist-sync.mjs')
const REPO_ROOT = join(TEST_DIR, '..', '..')

// ── 真实仓库比对面（绿 fixture 的成员源；提取失败 = 环境/源文件形态变化，直接红）────

const readReal = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf-8')
const realSystemPrompt = readReal('extensions/taiji/system-prompt/src/index.ts')
const realSanitize = readReal('packages/renderer/src/composables/logic/markdown-sanitize.ts')

const mustValues = (result, label) => {
  if (result.error) throw new Error(`${label} 提取失败：${result.error}`)
  return result.values
}

const REAL_CAP_TAGS = mustValues(
  extractRecordValues(realSystemPrompt, 'CAPABILITY_INLINE_TAG_FAMILIES'),
  'CAPABILITY_INLINE_TAG_FAMILIES',
)
const REAL_CAP_ATTRS = mustValues(
  extractArrayConst(realSystemPrompt, 'CAPABILITY_PRESENTATION_ATTRS'),
  'CAPABILITY_PRESENTATION_ATTRS',
)
const REAL_FORBIDDEN_BLOCK = extractInitializer(realSystemPrompt, 'CAPABILITY_FORBIDDEN')
if (REAL_FORBIDDEN_BLOCK.error) throw new Error(`CAPABILITY_FORBIDDEN 提取失败：${REAL_FORBIDDEN_BLOCK.error}`)
const REAL_FORBIDDEN_TAGS = mustValues(
  extractSubArrayLiterals(REAL_FORBIDDEN_BLOCK.text, 'tags'),
  'CAPABILITY_FORBIDDEN.tags',
)
const REAL_FORBIDDEN_ATTRS = mustValues(
  extractSubArrayLiterals(REAL_FORBIDDEN_BLOCK.text, 'attributes'),
  'CAPABILITY_FORBIDDEN.attributes',
)
const REAL_ALLOWED_TAGS = mustValues(extractArrayConst(realSanitize, 'ALLOWED_TAGS'), 'ALLOWED_TAGS')
const REAL_ALLOWED_ATTRS = mustValues(extractArrayConst(realSanitize, 'ALLOWED_ATTR'), 'ALLOWED_ATTR')

// ── fixture 生成（源文件真实形态：常量块 + 净化配置）─────────────────────────

const quoted = (items) => items.map((x) => `'${x}'`).join(', ')

const systemPromptSrc = ({ tags, attrs, forbiddenTags, forbiddenAttrs }) =>
  [
    `export const CAPABILITY_INLINE_TAG_FAMILIES: Readonly<Record<string, readonly string[]>> = {`,
    `  all: [${quoted(tags)}],`,
    `}`,
    ``,
    `export const CAPABILITY_PRESENTATION_ATTRS: readonly string[] = [${quoted(attrs)}]`,
    ``,
    `export const CAPABILITY_FORBIDDEN: {`,
    `  readonly tags: readonly string[]`,
    `  readonly attributes: readonly string[]`,
    `} = {`,
    `  tags: [${quoted(forbiddenTags)}],`,
    `  attributes: [${quoted(forbiddenAttrs)}],`,
    `}`,
    ``,
  ].join('\n')

const sanitizeSrc = ({ tags, attrs, allowData = true, allowAria = true }) => {
  const config = [
    `const SANITIZE_CONFIG = {`,
    `  ALLOWED_TAGS,`,
    `  ALLOWED_ATTR,`,
    ...(allowData ? [`  ALLOW_DATA_ATTR: false,`] : []),
    ...(allowAria ? [`  ALLOW_ARIA_ATTR: false,`] : []),
    `}`,
    ``,
  ]
  return [`const ALLOWED_TAGS = [${quoted(tags)}]`, `const ALLOWED_ATTR = [${quoted(attrs)}]`, ...config].join('\n')
}

/**
 * tmp mirror 工厂：目录布局对齐守卫的 ROOT 相对路径（extensions/taiji/system-prompt/src、
 * packages/renderer/src/composables/logic）。overrides 覆盖任一侧成员集或净化配置锚点（漂移
 * 注入点），missing 指定不落盘的文件。
 *
 * root 取 realpath：Node 对入口模块 import.meta.url 做 realpath，而 process.argv[1] 保留调用方
 * 路径——macOS os.tmpdir() 是 /var/folders → /private/var/folders 符号链接，两者不一致会让守卫
 * 的 isMain 判定为 false，脚本被 import 而不执行 main（恒 exit 0）。realpath 后两条路径同源。
 */
function makeMirror({
  capTags = REAL_CAP_TAGS,
  capAttrs = REAL_CAP_ATTRS,
  forbiddenTags = REAL_FORBIDDEN_TAGS,
  forbiddenAttrs = REAL_FORBIDDEN_ATTRS,
  sanitizeTags = REAL_ALLOWED_TAGS,
  sanitizeAttrs = REAL_ALLOWED_ATTRS,
  allowData = true,
  allowAria = true,
  missing = [],
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cap-allowlist-fx-')))
  const writeAt = (rel, content) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const files = {
    'extensions/taiji/system-prompt/src/index.ts': systemPromptSrc({
      tags: capTags,
      attrs: capAttrs,
      forbiddenTags,
      forbiddenAttrs,
    }),
    'packages/renderer/src/composables/logic/markdown-sanitize.ts': sanitizeSrc({
      tags: sanitizeTags,
      attrs: sanitizeAttrs,
      allowData,
      allowAria,
    }),
  }
  for (const [rel, content] of Object.entries(files)) {
    if (missing.includes(rel)) continue
    writeAt(rel, content)
  }
  const guardCopy = join(root, 'scripts', 'check-capability-allowlist-sync.mjs')
  mkdirSync(dirname(guardCopy), { recursive: true })
  copyFileSync(SCRIPT, guardCopy)
  const run = () => spawnSync(process.execPath, [guardCopy], { cwd: root, encoding: 'utf-8' })
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }
}

describe('CLI 集成（守卫脚本 × tmp mirror）', () => {
  it('两侧一致 → exit 0，三条正面/负面清单逐一报一致 + aria/data 锚点绿', () => {
    const fx = makeMirror()
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('✓ capability 清单对拍守卫通过')
      expect(r.stdout).toContain(`正面标签清单与 ALLOWED_TAGS 一致（${REAL_CAP_TAGS.length} 项`)
      expect(r.stdout).toContain(`正面属性清单与 ALLOWED_ATTR 一致（${REAL_CAP_ATTRS.length} 项）`)
      expect(r.stdout).toContain('data-* 通配以 ALLOW_DATA_ATTR=false')
      expect(r.stdout).toContain('aria-* 面以 ALLOW_ARIA_ATTR=false')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（清单缺标签 = 白名单新增未告知）→ exit 1，报缺失成员与恢复动作', () => {
    const fx = makeMirror({ capTags: REAL_CAP_TAGS.slice(0, -1) })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('正面标签清单与 ALLOWED_TAGS 漂移')
      expect(r.stderr).toContain(`白名单新增未入清单: ${REAL_CAP_TAGS[REAL_CAP_TAGS.length - 1]}`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（清单多出属性 = 教会了会被剥的能力）→ exit 1，报多出成员（双向相等非子集）', () => {
    const fx = makeMirror({ capAttrs: [...REAL_CAP_ATTRS, 'bogus-attr'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('正面属性清单与 ALLOWED_ATTR 漂移')
      expect(r.stderr).toContain('清单多出未放行属性: bogus-attr')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（净化白名单多出标签未入清单）→ exit 1（证明第 ① 步非恒绿）', () => {
    const fx = makeMirror({ sanitizeTags: [...REAL_ALLOWED_TAGS, 'bogus-tag'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('白名单新增未入清单: bogus-tag')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（禁用清单声明的标签实际在 ALLOWED_TAGS 内）→ exit 1（负面清单语义锚）', () => {
    const fx = makeMirror({ forbiddenTags: [...REAL_FORBIDDEN_TAGS, REAL_ALLOWED_TAGS[0]] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('禁用标签清单与剥除语义矛盾')
      expect(r.stderr).toContain(REAL_ALLOWED_TAGS[0])
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（声明剥 data-* 但净化层缺 ALLOW_DATA_ATTR=false）→ exit 1（构造性全剥锚点）', () => {
    const fx = makeMirror({ allowData: false })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('未显式 ALLOW_DATA_ATTR: false')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（净化层缺 ALLOW_ARIA_ATTR=false → 任意 aria-* 越过声明面）→ exit 1（属性面完备性锚点）', () => {
    const fx = makeMirror({ allowAria: false })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('未显式 ALLOW_ARIA_ATTR: false')
      expect(r.stderr).toContain('声明清单 ≠ 有效放行面')
    } finally {
      fx.cleanup()
    }
  })

  it('比对面文件缺失 → exit 1，报缺失路径与迁移同步指引（提取失败一律 fail）', () => {
    const fx = makeMirror({ missing: ['packages/renderer/src/composables/logic/markdown-sanitize.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('渲染净化源文件 缺失')
    } finally {
      fx.cleanup()
    }
  })
})

describe('真实仓库源文件（守卫对实际交付面非恒绿的反面：当前两侧一致）', () => {
  it('直跑真实守卫 → exit 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('✓ capability 清单对拍守卫通过')
  })
})
