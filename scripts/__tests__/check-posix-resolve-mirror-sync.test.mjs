/**
 * check-posix-resolve-mirror-sync.mjs 单测（branch-review minor 残余：守卫本体 +
 * --self-test 已交付，但无回归测试、无 CI 挂载——比较逻辑（逐字比对退化为恒真、
 * 语义锚点断言被删）自身退化时无任何红灯。形态照同辈 check-capability-allowlist-sync.test.mjs：
 * 纯函数直测 + tmpdir fixture，CLI 集成用例把守卫脚本复制到 tmp mirror 运行（守卫 ROOT
 * 由 import.meta.url 推导，副本位置使 ROOT 落在 mirror 内——篡改 fixture 才真正改到守卫
 * 读的文件，「篡改即红、还原即绿」的差分才成立）。）
 *
 * 三份函数体从真实仓库源文件动态提取（绿 fixture 的成员源，随真实交付面走）：
 * 各漂移/退化用例篡改 mirror fixture → exit 1，证明守卫非恒绿；另含真实仓库直跑用例。
 *
 * 运行：cd <repo-root> && pnpm exec vitest run scripts/__tests__/check-posix-resolve-mirror-sync.test.mjs
 * （ci.yml「Test - scripts guards」逐文件列举同款口径。）
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UI_ANCHOR,
  RENDERER_ANCHOR,
  UI_LINKS_ANCHOR,
  extractFunctionBody,
} from '../check-posix-resolve-mirror-sync.mjs'
import { createMirrorRoot, installGuardIntoMirror } from './helpers/guard-mirror.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(TEST_DIR, '..', 'check-posix-resolve-mirror-sync.mjs')
const REPO_ROOT = join(TEST_DIR, '..', '..')

// ── 真实仓库比对面（绿 fixture 的成员源；提取失败 = 环境/源文件形态变化，直接红）────

const readReal = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf-8')
const realHtmlPreview = readReal('packages/ui/src/features/chat/html-preview-path.ts')
const realSanitize = readReal('packages/ui/src/features/chat/markdown-sanitize.ts')
const realMarkdownLinks = readReal('packages/ui/src/features/chat/markdown-links.ts')

const mustBody = (text, anchor, label) => {
  const r = extractFunctionBody(text, anchor)
  if (r.error) throw new Error(`${label} 函数体提取失败：${r.error}`)
  return r.text
}

const REAL_UI_BODY = mustBody(realHtmlPreview, UI_ANCHOR, 'ui resolvePosixPath')
const REAL_RENDERER_BODY = mustBody(realSanitize, RENDERER_ANCHOR, 'renderer resolveResourcePath')
const REAL_LINKS_BODY = mustBody(realMarkdownLinks, UI_LINKS_ANCHOR, 'ui resolveHrefPath')

// ── fixture 生成（源文件真实形态：签名行 + 函数体；签名行仅 export/函数名差异）─────────

const signatureOf = (anchor) => `${anchor}(base: string, rel: string): string {`

const srcOf = (anchor, body) => `${signatureOf(anchor)}\n${body}\n`

/**
 * tmp mirror 工厂：目录布局对齐守卫 ROOT 相对路径（packages/ui/src/features/chat 下三份
 * 源文件）。overrides 以「函数体注入」漂移（默认 = 真实函数体三份同款），missing 指定
 * 不落盘的文件。root/落盘/清理/守卫副本装置见 guard-mirror.mjs。
 */
function makeMirror({
  uiBody = REAL_UI_BODY,
  rendererBody = REAL_RENDERER_BODY,
  linksBody = REAL_LINKS_BODY,
  missing = [],
} = {}) {
  const { root, writeAt, cleanup } = createMirrorRoot('posix-resolve-fx-')
  const files = {
    'packages/ui/src/features/chat/html-preview-path.ts': srcOf(UI_ANCHOR, uiBody),
    'packages/ui/src/features/chat/markdown-sanitize.ts': srcOf(RENDERER_ANCHOR, rendererBody),
    'packages/ui/src/features/chat/markdown-links.ts': srcOf(`export ${UI_LINKS_ANCHOR}`, linksBody),
  }
  for (const [rel, content] of Object.entries(files)) {
    if (missing.includes(rel)) continue
    writeAt(rel, content)
  }
  const run = installGuardIntoMirror(root, SCRIPT)
  return { root, run, cleanup }
}

describe('CLI 集成（守卫脚本 × tmp mirror）', () => {
  it('三份一致 → exit 0，锚点在场 + 两两比对报一致', () => {
    const fx = makeMirror()
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('✓ POSIX resolve 三份折叠实现对拍通过')
      expect(r.stdout).toContain('折叠语义锚点全在场')
      expect(r.stdout).toContain(`renderer ${RENDERER_ANCHOR} 函数体与基准逐字一致`)
      expect(r.stdout).toContain(`ui ${UI_LINKS_ANCHOR} 函数体与基准逐字一致`)
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（一份折叠实现改动）→ exit 1，报漂移对与三处同步指引', () => {
    const fx = makeMirror({ rendererBody: REAL_RENDERER_BODY.replace("parts.join('/')", "parts.join('-')") })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('折叠实现漂移')
      expect(r.stderr).toContain(`renderer ${RENDERER_ANCHOR} ≠ 基准`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('一致退化红（三份同款删 `..` 折叠）→ exit 1（语义锚点拦「一致但全错」盲区）', () => {
    const degenerate = (body) => body.replace('parts.pop()', 'parts.length--')
    const fx = makeMirror({
      uiBody: degenerate(REAL_UI_BODY),
      rendererBody: degenerate(REAL_RENDERER_BODY),
      linksBody: degenerate(REAL_LINKS_BODY),
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('缺折叠语义锚点')
      expect(r.stderr).toContain('parts.pop()')
    } finally {
      fx.cleanup()
    }
  })

  it('比对面文件缺失 → exit 1，报缺失路径与迁移同步指引（提取失败一律 fail）', () => {
    const fx = makeMirror({ missing: ['packages/ui/src/features/chat/markdown-links.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('ui markdown-links 源文件 缺失')
    } finally {
      fx.cleanup()
    }
  })
})

describe('真实仓库源文件（守卫对实际交付面非恒绿的反面：当前三份一致）', () => {
  it('直跑真实守卫 → exit 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('✓ POSIX resolve 三份折叠实现对拍通过')
  })
})
