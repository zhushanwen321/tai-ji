/**
 * validate-constraints.mjs 检测（constraints.json「新增约束先登记再写代码」流程的
 * 机器执行点——校验函数自身零覆盖时，26bcad0f7 修过的 enforcement JSON guard 这类
 * 面无回归防线）。
 *
 * 覆盖面（合法条目通过 + 各非法形态各报一条）：
 *   R1 合法条目 → validate 返回空错误清单
 *   R2 id 格式 / 重复
 *   R3 scope 空 / 非法 glob / global 放行
 *   R4 authority 空 / 文件不存在 / 纯锚点放行
 *   R5 enforcement：machine 缺 hook / hook 不存在 / review agent 不存在 / type 非法 / 空数组
 *   R6 dimensions 非数组；constraints 空数组
 *   R7 validateHookExists：§ 内联段特例 / 真实 hook / 不存在
 *
 * 本测试只读仓库既有文件（docs/ARCHITECTURE.md、scripts/validate-constraints.mjs、
 * .agents/skills/pr-cr-fix/agents/review-test-coverage.md），零写操作，不触碰
 * 真实数据目录。
 */
import { describe, it, expect } from 'vitest'

import {
  validate,
  validateHookExists,
} from '../validate-constraints.mjs'

/** 合法基准条目（authority/hook/agent 均指向仓库内真实存在文件；authority 相对 docs/ 解析）。 */
function validConstraint(overrides = {}) {
  return {
    id: 'C-proc-99',
    scope: ['scripts/validate-constraints.mjs'],
    authority: ['ARCHITECTURE.md'],
    enforcement: [{ type: 'machine', hook: 'validate-constraints.mjs' }],
    ...overrides,
  }
}

// ---------- R1 合法条目通过 ----------

describe('R1 合法条目 → 零错误', () => {
  it('全字段合法的登记表通过', () => {
    expect(validate({ constraints: [validConstraint()] })).toEqual([])
  })
  it('dimensions 合法数组不报错；scope global 放行', () => {
    const c = validConstraint({ scope: ['global'], dimensions: ['review:review-test-coverage'] })
    expect(validate({ constraints: [c] })).toEqual([])
  })
})

// ---------- R2 id ----------

describe('R2 id 格式与唯一性', () => {
  it('缺 id → 报 id 格式非法，定位 (missing id)', () => {
    const c = validConstraint()
    delete c.id
    const errors = validate({ constraints: [c] })
    expect(errors).toContainEqual('id 格式非法: (missing id)')
  })
  it('id 格式非法（三位序号 / 未知 topic）各报一条', () => {
    const errors = validate({
      constraints: [validConstraint({ id: 'C-proc-100' }), validConstraint({ id: 'C-unknown-01' })],
    })
    expect(errors).toContainEqual('id 格式非法: C-proc-100')
    expect(errors).toContainEqual('id 格式非法: C-unknown-01')
  })
  it('id 重复报一条', () => {
    const errors = validate({ constraints: [validConstraint(), validConstraint()] })
    expect(errors).toContainEqual('id 重复: C-proc-99')
  })
})

// ---------- R3 scope ----------

describe('R3 scope 校验', () => {
  it('scope 为空数组报一条', () => {
    const errors = validate({ constraints: [validConstraint({ scope: [] })] })
    expect(errors).toContainEqual('C-proc-99: scope 为空')
  })
  it('scope 非法 glob（** 前缀缺失 / 非法字符）各报一条', () => {
    const errors = validate({
      constraints: [validConstraint({ scope: ['packages/**/deep'] }), validConstraint({ id: 'C-ext-99', scope: ['a b'] })],
    })
    expect(errors).toContainEqual('C-proc-99: scope 非法 glob "packages/**/deep"（只支持 <prefix>/** 或精确路径）')
    expect(errors).toContainEqual('C-ext-99: scope 非法 glob "a b"（只支持 <prefix>/** 或精确路径）')
  })
})

// ---------- R4 authority ----------

describe('R4 authority 校验', () => {
  it('authority 为空数组报一条', () => {
    const errors = validate({ constraints: [validConstraint({ authority: [] })] })
    expect(errors).toContainEqual('C-proc-99: authority 为空')
  })
  it('authority 文件不存在报一条', () => {
    const errors = validate({ constraints: [validConstraint({ authority: ['no-such-file.md'] })] })
    expect(errors).toContainEqual('authority 文件不存在: no-such-file.md')
  })
  it('纯锚点引用（# 后无路径）不查文件存在性', () => {
    const c = validConstraint({ authority: ['#§3.2.6'] })
    expect(validate({ constraints: [c] })).toEqual([])
  })
})

// ---------- R5 enforcement ----------

describe('R5 enforcement 校验', () => {
  it('machine 缺 hook 报一条', () => {
    const errors = validate({
      constraints: [validConstraint({ enforcement: [{ type: 'machine' }] })],
    })
    expect(errors).toContainEqual('C-proc-99: machine enforcement 缺 hook')
  })
  it('machine hook 不存在于任何白名单目录报一条', () => {
    const errors = validate({
      constraints: [validConstraint({ enforcement: [{ type: 'machine', hook: 'no-such-hook.mjs' }] })],
    })
    expect(errors).toContainEqual('C-proc-99: hook 不存在于 .githooks/ / scripts/ / 根: no-such-hook.mjs')
  })
  it('review agent 不存在报一条', () => {
    const errors = validate({
      constraints: [validConstraint({ enforcement: [{ type: 'review', agent: 'no-such-agent' }] })],
    })
    expect(errors).toContainEqual('C-proc-99: review agent 不存在: no-such-agent')
  })
  it('enforcement.type 非法报一条', () => {
    const errors = validate({
      constraints: [validConstraint({ enforcement: [{ type: 'audit' }] })],
    })
    expect(errors).toContainEqual('C-proc-99: enforcement.type 非法: audit')
  })
  it('enforcement 为空数组报一条', () => {
    const errors = validate({ constraints: [validConstraint({ enforcement: [] })] })
    expect(errors).toContainEqual('C-proc-99: enforcement 为空')
  })
})

// ---------- R6 表级 ----------

describe('R6 表级校验', () => {
  it('constraints 为空数组报一条', () => {
    expect(validate({ constraints: [] })).toContainEqual('constraints 为空数组')
  })
  it('constraints 缺失报一条且不抛（for 循环对 undefined 防御）', () => {
    expect(validate({})).toContainEqual('constraints 为空数组')
  })
  it('dimensions 非数组报一条', () => {
    const errors = validate({ constraints: [validConstraint({ dimensions: 'review:review-test-coverage' })] })
    expect(errors).toContainEqual('C-proc-99: dimensions 须为数组')
  })
})

// ---------- R7 validateHookExists ----------

describe('R7 validateHookExists 白名单目录', () => {
  it('含 § 的内联段引用放行（无独立脚本）', () => {
    expect(validateHookExists('install-hooks.sh §2c')).toBe(true)
  })
  it('scripts/ 与仓库根白名单命中放行', () => {
    expect(validateHookExists('validate-constraints.mjs')).toBe(true) // scripts/
    expect(validateHookExists('package.json')).toBe(true) // 仓库根
  })
  it('不存在的 hook 拒绝', () => {
    expect(validateHookExists('no-such-hook-anywhere.mjs')).toBe(false)
  })
})
