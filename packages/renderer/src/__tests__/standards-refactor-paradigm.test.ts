import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * docs/STANDARDS.md 重构范式章节（FR4 AC7）存在性断言。
 * 纯文档 wave 的机器可验 gate：验证「## 10. 重构范式」章节已固化
 * （三段式 / 信号识别表 / 落地要求，对齐 .xyz-harness/2026-08-05-arch-fix-v2/07 §优化 4）。
 */
const standards = readFileSync(resolve(__dirname, '../../../../docs/STANDARDS.md'), 'utf-8')

describe('docs/STANDARDS.md 重构范式章节（FR4 AC7）', () => {
  it('章节存在：## 10. 重构范式', () => {
    expect(standards).toContain('## 10. 重构范式')
  })

  it('10.1 三段式定义完整（逻辑归位/壳装配/facade 消费）', () => {
    expect(standards).toContain('**逻辑归位**')
    expect(standards).toContain('**壳装配**')
    expect(standards).toContain('**facade 消费**')
    // 反模式对照：非「为绕 lint 行数限制拆 *Impl」
    expect(standards).toContain('*Impl')
    expect(standards).toContain('行数')
  })

  it('10.2 信号识别表 4 类信号齐全', () => {
    expect(standards).toContain('*Impl` 后缀函数为绕 max-lines')
    expect(standards).toContain('容器组件 > 400 行')
    expect(standards).toContain('同类逻辑散落多处')
    expect(standards).toContain('深模块有独立测试价值')
  })

  it('10.3 落地要求 3 条齐全', () => {
    const section = standards.split('### 10.3 落地要求')[1] ?? ''
    // 3 条：写入 standards.md / 后续重构统一遵循 / review 检查信号
    expect(section).toContain('范式写入 `docs/STANDARDS.md`')
    expect(section).toContain('统一遵循三段式')
    expect(section).toContain('review 检查新代码')
  })
})
