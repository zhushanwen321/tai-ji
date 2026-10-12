import { describe, expect, it } from 'vitest'

// dom-core 脚手架冒烟测试（scaffold wave）：
// - jsdom 环境生效验证（vitest.config.ts 的 environment: 'jsdom'）
// - barrel re-export 链路可编译可解析（src/index.ts → ./composer/input 空占位）
// - workspace 链接验证（deps @taiji/core / @taiji/shared 可解析）
// scaffold 阶段无业务逻辑代码，三用例守卫包结构与测试环境本身。
describe('dom-core jsdom environment', () => {
  it('document is available (jsdom environment active)', () => {
    const el = document.createElement('div')
    expect(el.tagName).toBe('DIV')
  })
})

describe('dom-core package structure', () => {
  // 动态 import 用例的超时按 vite-node 冷 transform 粒度校准：全量递归跑测时
  // barrel/workspace 链首次 transform 可超默认 5s（并发分片下更甚），断言本身不变。
  it('barrel resolves (src/index.ts → ./composer/input placeholder)', { timeout: 20_000 }, async () => {
    const mod = await import('../index')
    expect(mod).toBeDefined()
  })

  it('workspace deps resolve (@taiji/core + @taiji/shared links)', { timeout: 20_000 }, async () => {
    const core = await import('@taiji/core')
    const shared = await import('@taiji/shared')
    expect(core).toBeDefined()
    expect(shared).toBeDefined()
  })
})
