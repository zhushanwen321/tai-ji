/**
 * provider-importer 测试族共享 vi.mock 注册（import 即生效）。
 *
 * 默认 mock 三面：provider-parser（parseProviders 默认 null = 源未安装，各用例用
 * mockReturnValue 覆盖）；pi-provider-store（getProviderNames 默认空 = 无冲突，
 * upsertProvider 默认 no-op，ensureProviderInWhitelist 白名单守卫补全避免 No export）；
 * provider-catalog（isCatalogProvider 默认 false = 保持自定义 provider 行为）。
 *
 * [时序约束] vitest 只 hoist 测试文件本体的 vi.mock 调用；本模块的注册按测试文件的
 * import 顺序生效——必须 import 在被 mock 模块（../provider-importer.js 等）之前。
 */
import { vi } from 'vitest'

vi.mock('../provider-parser.js', () => ({
  parseProviders: vi.fn(() => null),
}))

vi.mock('../../../infra/pi/pi-provider-store.js', () => ({
  getProviderNames: vi.fn(() => []),
  upsertProvider: vi.fn(() => ({})),
  // wave3 边界1：applyImport 导入成功后调 ensureProviderInWhitelist（白名单守卫），mock 补全避免 No export 报错
  ensureProviderInWhitelist: vi.fn(),
}))

vi.mock('../../provider-catalog.js', () => ({
  isCatalogProvider: vi.fn(() => false),
}))
