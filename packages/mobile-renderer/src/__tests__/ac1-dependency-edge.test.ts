// AC1 回归护栏（W1）：mobile-renderer → @taiji/core + @taiji/ui 物理依赖边。
// 断言锚点 = package.json dependencies（workspace:*）：依赖边由包拓扑声明护住，
// 消费方（bootstrap.ts）真实 import 由 vue-tsc 验证，不在本测试做源码文本正则断言
//（源码文本断言保护的是实现细节，曾绑架 main.ts 保留死 import）。
//
// M1d-01：禁止边与白名单校验——
//   - 允许边白名单：@taiji/core / dom-core / ui / shared（架构分层 shared←core←dom-core←ui←mobile）
//   - 禁止边：@taiji/renderer（渲染壳包不得依赖桌面壳，违反分层）
//   - 故意把 @taiji/renderer 加进 dependencies 会让本测试红（护栏有效）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录），package.json 在其下
const pkgRoot = process.cwd()

/** 允许依赖的 @taiji/* 包白名单（arch-fix-v2 分层：shared←core←dom-core←ui←mobile 装配层） */
const ALLOWED_TAIJI_DEPS = ['@taiji/core', '@taiji/dom-core', '@taiji/ui', '@taiji/shared'] as const

/** 禁止依赖集合（壳包不得反向依赖上层/渲染层） */
const FORBIDDEN_TAIJI_DEPS = ['@taiji/frontend', '@taiji/renderer'] as const

describe('AC1: mobile-renderer 包拓扑依赖边', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8')) as {
    dependencies: Record<string, string>
  }

  it('package.json dependencies 含 @taiji/core（workspace:*）', () => {
    expect(pkg.dependencies['@taiji/core']).toBe('workspace:*')
  })

  it('package.json dependencies 含 @taiji/ui（workspace:*）', () => {
    expect(pkg.dependencies['@taiji/ui']).toBe('workspace:*')
  })

  it('所有 @taiji/* 依赖 ∈ 允许边白名单（core/dom-core/ui/shared）', () => {
    const taijiDeps = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@taiji/'))
    expect(taijiDeps.length).toBeGreaterThan(0)
    for (const dep of taijiDeps) {
      expect(ALLOWED_TAIJI_DEPS).toContain(dep)
    }
  })

  it('禁止依赖集不在 dependencies（@taiji/renderer 等，M1d-01 负向护栏）', () => {
    for (const dep of FORBIDDEN_TAIJI_DEPS) {
      expect(pkg.dependencies[dep]).toBeUndefined()
    }
  })
})
