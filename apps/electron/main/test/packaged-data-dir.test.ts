/**
 * 打包数据目录受控采信行为矩阵（utils/packaged-data-dir.ts 纯函数守护）。
 *
 * 与 dev-data-dir.test.ts 镜像对称（~/.taiji 树 ↔ ~/.taiji-dev 树），差异：
 * 无 TAIJI_E2E 豁免——e2e（launch-app*）全部以非打包形态运行（app.isPackaged=false
 * 走 dev 分支豁免），打包分支无受控注入场景，不加推测性豁免。
 *
 * 被测函数纯词法解析（path.resolve + 树内包含判定），无任何 fs 访问——用例只喂
 * 字符串、断言返回值，不建目录不落盘（故无需 mkdtemp 夹具；真实数据目录零接触）。
 * main.ts 打包分支的接线（调用 resolvePackagedDataDir + 时序）由
 * main-dev-datadir-pin.test.ts（packaged describe）源码守护覆盖。
 *
 * 运行：cd apps/electron/main && npx vitest run test/packaged-data-dir.test.ts
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolvePackagedDataDir } from '../utils/packaged-data-dir.js'

/** 注入的假 home：与真实 homedir 解耦（被测函数只做词法判定，目录无需存在） */
const HOME = path.join(path.sep, 'home', 'tester')
const PROD_ROOT = path.join(HOME, '.taiji')
const DEV_ROOT = path.join(HOME, '.taiji-dev')

/** env 快捷构造（只保留被测键，其余键与判定无关） */
function env(dataDir?: string): NodeJS.ProcessEnv {
  return { TAIJI_AGENT_DATA_DIR: dataDir }
}

describe('resolvePackagedDataDir 受控采信行为矩阵', () => {
  describe('钉死分支（未设 / 泄漏 / 树外）', () => {
    it('未设值 → 钉死 ~/.taiji（打包态正常形态：env 由 main 本块赋值，无需外部注入）', () => {
      expect(resolvePackagedDataDir(env(undefined), HOME)).toBe(PROD_ROOT)
    })

    it('空字符串 → 钉死（非空才算外部值）', () => {
      expect(resolvePackagedDataDir(env(''), HOME)).toBe(PROD_ROOT)
    })

    it('宿主残留 dev 值 ~/.taiji-dev/instances/... → 拒绝，钉死（镜像防泄漏：防打包版写 dev 目录）', () => {
      expect(resolvePackagedDataDir(env(path.join(DEV_ROOT, 'instances', 'dev-0.10.3')), HOME)).toBe(PROD_ROOT)
    })

    it('树外绝对路径（/tmp 下任意目录）→ 拒绝，钉死', () => {
      expect(resolvePackagedDataDir(env(path.join(path.sep, 'tmp', 'leak')), HOME)).toBe(PROD_ROOT)
    })

    it('词法逃逸形态 ~/.taiji/../.taiji-dev → resolve 消解 .. 后已出树，拒绝', () => {
      expect(resolvePackagedDataDir(env(`${PROD_ROOT}${path.sep}..${path.sep}.taiji-dev`), HOME)).toBe(PROD_ROOT)
    })

    it('前缀混淆形态 ~/.taijiish（共享前缀的兄弟目录）→ 拒绝（sep 边界判，非字符串前缀）', () => {
      expect(resolvePackagedDataDir(env(`${PROD_ROOT}ish`), HOME)).toBe(PROD_ROOT)
    })

    it('大小写变体 ~/.TAIJI → 拒绝，钉死规范根（设计内残差：不 casefold——大小写不敏感卷上钉回根即变体命中的同一物理目录，Linux 上变体是树外另一目录钉回也正确；casefold 反而会在 Linux 误采信）', () => {
      expect(resolvePackagedDataDir(env(path.join(HOME, '.TAIJI')), HOME)).toBe(PROD_ROOT)
      expect(resolvePackagedDataDir(env(path.join(HOME, '.TAIJI', 'agent')), HOME)).toBe(PROD_ROOT)
    })
  })

  describe('采信分支（~/.taiji 树内）', () => {
    it('树内子路径 ~/.taiji/electron 等 → 采信', () => {
      const sub = path.join(PROD_ROOT, 'electron')
      expect(resolvePackagedDataDir(env(sub), HOME)).toBe(sub)
    })

    it('树根本身 ~/.taiji → 采信', () => {
      expect(resolvePackagedDataDir(env(PROD_ROOT), HOME)).toBe(PROD_ROOT)
    })

    it('树内值带冗余段（foo/../bar）→ resolve 归一后仍在树内，采信归一结果', () => {
      expect(
        resolvePackagedDataDir(env(path.join(PROD_ROOT, 'foo', '..', 'bar')), HOME),
      ).toBe(path.join(PROD_ROOT, 'bar'))
    })

    it('尾随分隔符形态 → 归一后采信', () => {
      expect(resolvePackagedDataDir(env(`${PROD_ROOT}${path.sep}`), HOME)).toBe(PROD_ROOT)
    })
  })
})
