// bootstrap —— 应用启动编排入口（IF1 契约）。
//
// 真编排：被 renderer App.vue onMounted 真实调用（bootstrap({ platform: resolvePlatform() })），
// 显式 await 串联五步，无隐式 import 顺序依赖（AC6）。
//
// 时序链（renderer-package-topology.md §11.0.3）：
//   providePlatform(port) → initConnection() → restoreSessions() →
//   registerMountPoints() → scanContributions()
//
// platform 先于连接编排由 await 链代码顺序结构化保证（死锁防线从注释变代码顺序）。
// [HISTORICAL] 2026-08-04 死锁事故：platform 注入曾晚于连接编排（core ws-client.connect
// 第一步 getPlatform() fail-fast 无 platform → 永远「连接中」），原靠 main.ts 挂载前
// 手工注入防死锁；现由五步首尾顺序构造性消除（providePlatform 幂等纯赋值，与壳
// main.ts 早期注入共存无害——后者保障 App.vue setup 期 settings init 与 HMR）。
//
// await 语义（D2 裁决②）：initConnection resolve = 连接编排已提交，非 connected——
// useConnection().init() 内 connectWs 不等握手（fire-and-forget）；connected 驱动的
// 视图初始化留在壳侧（App.vue watch connectionState）。
//
// ES1 失败语义：任一步 reject/throw 由 await 自然中断后续并向上抛出（不吞错、不包装，
// 保留原 stack）。启动失败必须可见，壳捕获后展示降级 UI。
import type { PlatformPort } from './platform/port'
// namespace import：bootstrap 内部经 portNs.providePlatform() 调用，使单测 vi.spyOn(portNs,
// 'providePlatform') 走属性访问可靠（不依赖 ESM live binding 细节）。
import * as portNs from './platform/port'
import { useConnection } from './transport/use-connection'
import type { MountPointRegistry } from './extension-host/mount-point-registry'
import type { ContributionRegistry } from './extension-host/contribution-registry'

// ── 步骤实现 ──────────────────────────────────────────────────────

// 连接编排提交（D2 裁决②）：发现 runtime 端口并 connectWs。resolve 即编排已提交——
// 不等待 connected（握手/auth 异步，connected 驱动的视图初始化留壳侧）。
// init() 只消费 env.isMock（mock/真实由壳 env 端口注入），无连接模式参数（双开关源删一）；
// ConnectionPorts 未注入时 useConnection().init() 自身 warn 降级（ES2），bootstrap 层不加守卫。
export async function initConnection(): Promise<void> {
  console.log('[bootstrap] step 2/5 initConnection')
  await useConnection().init()
}

// no-op 占位——subscribed sessions 现状是 subscription-state 内存态（无持久化），真实实现等
// core SessionService + 订阅持久化 + ws-client auth 扩展三件套（remote/mobile 波次）后归 core
// coordination，本波不伪造语义（R3 减法修正）。
export async function restoreSessions(): Promise<void> {
  console.log('[bootstrap] step 3/5 restoreSessions')
}

// ExtensionHost 注册表注入点（对齐 subscription-state 注入模式：core 定义注入函数，壳装配时 set，
// 未注入 warn 降级不抛错——ES2 防御，单测可不注入直接测其他步骤）。
let mountRegistryImpl: MountPointRegistry | undefined
let contributionRegistryImpl: ContributionRegistry | undefined

/** 壳装配时注入 ExtensionHost 注册表（§12.1 wiring）。未注入时 registerMountPoints/scanContributions warn 降级。 */
export function setExtensionRegistries(registries: {
  mountPoints: MountPointRegistry
  contributions: ContributionRegistry
}): void {
  mountRegistryImpl = registries.mountPoints
  contributionRegistryImpl = registries.contributions
}

// 壳向 ExtensionHost 注册挂载点（sidebar.tab / panel.header / composer.toolbar / statusbar）
export async function registerMountPoints(): Promise<void> {
  console.log('[bootstrap] step 4/5 registerMountPoints')
  if (!mountRegistryImpl) {
    console.warn('[bootstrap] registerMountPoints: registry not injected, skip (setExtensionRegistries)')
    return
  }
  // Tier 1 挂载点（§12.1，对齐 audit §12.1 步骤 1）：sidebar tab / panel header / composer toolbar / statusbar。
  // 命名 SSOT = SDK/descriptor-types（'sidebar.tab' | 'panel.header' | 'composer.toolbar' | 'statusbar'），
  // renderer ViewHost view-id 按同名路由（MF-8：曾用 'panel.header.action' 导致 listMountPoints 与
  // 渲染端名字失配）。
  mountRegistryImpl.register('sidebar.tab')
  mountRegistryImpl.register('panel.header')
  mountRegistryImpl.register('composer.toolbar')
  mountRegistryImpl.register('statusbar')
}

// 扫描 plugin manifest 注册声明式贡献（views/menus/commands/statusBarItems/slashCommands/configuration）
export async function scanContributions(): Promise<void> {
  console.log('[bootstrap] step 5/5 scanContributions')
  if (!contributionRegistryImpl) {
    console.warn('[bootstrap] scanContributions: registry not injected, skip (setExtensionRegistries)')
    return
  }
  contributionRegistryImpl.registerBuiltin()
  // loadExternal：external plugin descriptors 经 runtime 透传（s3 通道未完成，ERR5 降级——空数组 no-op）
  contributionRegistryImpl.loadExternal([])
}

// bootstrap 内部步骤表（命名导出，供单测 vi.spyOn(bootstrapSteps, '<fn>') 验证 ES1 顺序 + reject 中断）。
// 聚合为对象使 spy 走属性访问（可靠），不依赖 ESM live binding 细节。
export const bootstrapSteps = {
  initConnection,
  restoreSessions,
  registerMountPoints,
  scanContributions,
}

export interface BootstrapOptions {
  platform: PlatformPort
}

// bootstrap —— 启动编排入口（IF1）。显式 await 串联五步。
// 注意：五步均为显式 await，无隐式 import 副作用（TC4 grep gate 验证）。
export async function bootstrap(options: BootstrapOptions): Promise<void> {
  console.log('[bootstrap] step 1/5 providePlatform')
  await portNs.providePlatform(options.platform)
  await bootstrapSteps.initConnection()
  await bootstrapSteps.restoreSessions()
  await bootstrapSteps.registerMountPoints()
  await bootstrapSteps.scanContributions()
}
