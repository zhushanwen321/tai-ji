/**
 * RT-8#3 npm 包名路径穿越修复验证（code-harden 审计批次 1）：
 * `parseSpec` 不校验包名，`join(nodeModulesDir, name)` 后 rmSync(recursive,force)/
 * renameSync 可被 `../../` 逃逸写删 node_modules 之外任意目录；name 可来自外部
 * clone 仓库 package.json 的依赖名。修复 = validateNpmName 白名单（第一向）+
 * resolve 后 isUnderOrEqual 双向守卫（第二向），install/uninstall 调用点全接。
 *
 * 运行：cd packages/runtime && npx vitest run test/npm-installer-name-validation.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateNpmName,
  installPackage,
  uninstallPackage,
  NpmInstallError,
} from '../src/infra/installers/npm-installer.js'
import { isUnderOrEqual } from '../src/utils/path-utils.js'

describe('RT-8#3: validateNpmName 白名单（非法名必抛，消息含恢复动作）', () => {
  it.each([
    ['../', '相对上跳'],
    ['../../x', '多级上跳'],
    ['/etc/passwd', '绝对路径'],
    ['a/../../b', '符号链接形态名（中段上跳）'],
    ['@scope/../pkg', '含 .. 的 scoped 名'],
    ['@scope/..', 'scoped 尾段为 ..（join 后 = nodeModulesDir 本身）'],
    ['..', '纯上跳段'],
    ['.', '当前段'],
    ['@scope/pkg/extra', 'scoped 多段斜杠'],
    ['@/pkg', '空 scope'],
    ['@scope/', '空包段'],
    ['@scope', '缺 / 的 scoped 前缀'],
    ['.hidden-pkg', '前导点'],
    ['_private', '前导下划线'],
    ['Upper-Case', '大写字母'],
    ['has space', '空格'],
    ['has~tilde', '非白名单字符 ~'],
    ['leading ', '尾随空格'],
  ])('拒绝 %s（%s）', (name) => {
    expect(() => validateNpmName(name)).toThrow(NpmInstallError)
    expect(() => validateNpmName(name)).toThrow(/Invalid package name/)
    expect(() => validateNpmName(name)).toThrow(/tampering|blocked/)
  })

  it('空名与超长名（>214）拒绝', () => {
    expect(() => validateNpmName('')).toThrow(/Invalid package name/)
    expect(() => validateNpmName('a'.repeat(215))).toThrow(/214/)
  })

  it.each([
    ['lodash', '普通包'],
    ['@scope/pkg', 'scoped 包'],
    ['@zhushanwen/pi-todo', '真实 scoped 包'],
    ['left-pad', '连字符'],
    ['a.b.c', '点分段'],
    ['a_b', '下划线中缀'],
    ['tiny', '短名'],
  ])('放行合法名 %s（%s）', (name) => {
    expect(() => validateNpmName(name)).not.toThrow()
  })
})

describe('RT-8#3: isUnderOrEqual 守卫语义（node_modules 边界判定）', () => {
  const nodeModulesDir = '/proj/node_modules'

  it.each([
    ['../', '相对上跳'],
    ['../../x', '多级上跳'],
    ['a/../../b', '中段上跳'],
  ])('join(nodeModulesDir, %s) 逃出边界 → isUnderOrEqual false（%s）', (name) => {
    expect(isUnderOrEqual(nodeModulesDir, join(nodeModulesDir, name))).toBe(false)
  })

  it('绝对路径 child（边界外）→ isUnderOrEqual false', () => {
    expect(isUnderOrEqual(nodeModulesDir, '/etc/passwd')).toBe(false)
  })

  it.each([
    ['lodash', '普通包'],
    ['@scope/pkg', 'scoped 包'],
  ])('join(nodeModulesDir, %s) 在边界内 → isUnderOrEqual true（%s）', (name) => {
    expect(isUnderOrEqual(nodeModulesDir, join(nodeModulesDir, name))).toBe(true)
  })
})

describe('RT-8#3: 调用点接线（uninstall/install 在 rmSync 前拒绝越界名）', () => {
  let root: string
  let nodeModulesDir: string
  let outsideDir: string
  let outsideFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'npm-name-guard-'))
    nodeModulesDir = join(root, 'node_modules')
    mkdirSync(nodeModulesDir)
    // node_modules 之外的诱饵：非法名若穿透守卫会被 rmSync 递归删除
    outsideDir = join(root, 'outside')
    mkdirSync(outsideDir)
    outsideFile = join(outsideDir, 'precious.txt')
    writeFileSync(outsideFile, 'must-survive', 'utf-8')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('uninstallPackage 遇 ../ 越界名：抛错 + node_modules 外目录原样保留', async () => {
    await expect(uninstallPackage('../../outside', nodeModulesDir)).rejects.toThrow(NpmInstallError)
    expect(existsSync(outsideFile)).toBe(true)
    expect(existsSync(outsideDir)).toBe(true)
  })

  it.each([
    ['a/../../outside', '中段上跳'],
    ['@scope/../outside', 'scoped 尾段上跳'],
  ])('uninstallPackage 遇 %s（%s）：抛错 + 外部目录保留', async (name) => {
    await expect(uninstallPackage(name, nodeModulesDir)).rejects.toThrow(/Invalid package name|escapes node_modules/)
    expect(existsSync(outsideFile)).toBe(true)
  })

  it('installPackage 遇越界名：在发起任何网络请求前即抛（validateNpmName 前置于 fetchMetadata）', async () => {
    await expect(installPackage('../../outside', nodeModulesDir)).rejects.toThrow(/Invalid package name/)
    expect(existsSync(outsideFile)).toBe(true)
  })

  it('uninstallPackage 合法名：不抛（目录不存在时安静返回）', async () => {
    await expect(uninstallPackage('lodash', nodeModulesDir)).resolves.toBeUndefined()
  })

  it('uninstallPackage 合法 scoped 名且目录存在：只删包目录，node_modules 本体保留', async () => {
    const pkgDir = join(nodeModulesDir, '@scope', 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'index.js'), 'x', 'utf-8')

    await expect(uninstallPackage('@scope/pkg', nodeModulesDir)).resolves.toBeUndefined()
    expect(existsSync(pkgDir)).toBe(false)
    expect(existsSync(nodeModulesDir)).toBe(true)
  })
})
