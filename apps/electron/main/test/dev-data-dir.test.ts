/**
 * dev 数据目录受控采信行为矩阵（R-13 修复：utils/dev-data-dir.ts 纯函数守护）。
 *
 * 被测函数纯词法解析（path.resolve + 树内包含判定），无任何 fs 访问——用例只喂
 * 字符串、断言返回值，不建目录不落盘（故无需 mkdtemp 夹具；真实数据目录零接触）。
 * main.ts isDev 块的接线（调用 resolveDevDataDir + 时序）由
 * main-dev-datadir-pin.test.ts 源码守护覆盖。
 *
 * 运行：cd apps/electron/main && npx vitest run test/dev-data-dir.test.ts
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveDevDataDir } from '../utils/dev-data-dir.js'

/** 注入的假 home：与真实 homedir 解耦（被测函数只做词法判定，目录无需存在） */
const HOME = path.join(path.sep, 'home', 'tester')
const DEV_ROOT = path.join(HOME, '.taiji-dev')

/** env 快捷构造（只保留被测键，其余键与判定无关） */
function env(dataDir?: string, e2e?: string): NodeJS.ProcessEnv {
  return { TAIJI_AGENT_DATA_DIR: dataDir, TAIJI_E2E: e2e }
}

describe('resolveDevDataDir 受控采信行为矩阵', () => {
  describe('钉死分支（未设 / 泄漏 / 树外）', () => {
    it('未设值 → 钉死 ~/.taiji-dev', () => {
      expect(resolveDevDataDir(env(undefined), HOME)).toBe(DEV_ROOT)
    })

    it('空字符串 → 钉死（非空才算外部值）', () => {
      expect(resolveDevDataDir(env(''), HOME)).toBe(DEV_ROOT)
    })

    it('宿主泄漏形态 ~/.taiji（prod 目录，2026-09-08 事故原形态）→ 拒绝，钉死', () => {
      expect(resolveDevDataDir(env(path.join(HOME, '.taiji')), HOME)).toBe(DEV_ROOT)
    })

    it('树外绝对路径（/tmp 下任意目录）→ 拒绝，钉死', () => {
      expect(resolveDevDataDir(env(path.join(path.sep, 'tmp', 'leak')), HOME)).toBe(DEV_ROOT)
    })

    it('词法逃逸形态 ~/.taiji-dev/../.taiji → resolve 消解 .. 后已出树，拒绝', () => {
      expect(resolveDevDataDir(env(`${DEV_ROOT}${path.sep}..${path.sep}.taiji`), HOME)).toBe(DEV_ROOT)
    })

    it('前缀混淆形态 ~/.taiji-devish（共享前缀的兄弟目录）→ 拒绝（sep 边界判，非字符串前缀）', () => {
      expect(resolveDevDataDir(env(`${DEV_ROOT}ish`), HOME)).toBe(DEV_ROOT)
    })
  })

  describe('采信分支（~/.taiji-dev 树内）', () => {
    it('装配器实例目录 ~/.taiji-dev/instances/<worktree> → 采信（R-13 修复主场景）', () => {
      const instance = path.join(DEV_ROOT, 'instances', 'dev-0.10.3')
      expect(resolveDevDataDir(env(instance), HOME)).toBe(instance)
    })

    it('树根本身 ~/.taiji-dev → 采信', () => {
      expect(resolveDevDataDir(env(DEV_ROOT), HOME)).toBe(DEV_ROOT)
    })

    it('树内值带冗余段（instances/foo/../bar）→ resolve 归一后仍在树内，采信归一结果', () => {
      expect(
        resolveDevDataDir(env(path.join(DEV_ROOT, 'instances', 'foo', '..', 'bar')), HOME),
      ).toBe(path.join(DEV_ROOT, 'instances', 'bar'))
    })

    it('尾随分隔符形态 → 归一后采信', () => {
      expect(resolveDevDataDir(env(`${DEV_ROOT}${path.sep}`), HOME)).toBe(DEV_ROOT)
    })
  })

  describe('e2e 受控装配豁免（原样保留）', () => {
    it('TAIJI_E2E=1 + 树外 mkdtemp 形态目录 → 采信（e2e 例外不回归）', () => {
      const tmpDataDir = path.join(path.sep, 'tmp', 'e2e-mkdtemp-x1')
      expect(resolveDevDataDir(env(tmpDataDir, '1'), HOME)).toBe(tmpDataDir)
    })

    it('TAIJI_E2E=1 但外部值非空才豁免——空值仍钉死', () => {
      expect(resolveDevDataDir(env(undefined, '1'), HOME)).toBe(DEV_ROOT)
      expect(resolveDevDataDir(env('', '1'), HOME)).toBe(DEV_ROOT)
    })

    it('TAIJI_E2E 非 "1" 值（0 / true）不构成豁免，泄漏形态仍被拒', () => {
      expect(resolveDevDataDir(env(path.join(HOME, '.taiji'), '0'), HOME)).toBe(DEV_ROOT)
      expect(resolveDevDataDir(env(path.join(HOME, '.taiji'), 'true'), HOME)).toBe(DEV_ROOT)
    })
  })
})
