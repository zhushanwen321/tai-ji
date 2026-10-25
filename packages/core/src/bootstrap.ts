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
import type { PluginDescriptorLike } from './extension-host/types'

// ── 步骤实现 ──────────────────────────────────────────────────────

// 连接编排提交（D2 裁决②）：发现 runtime 端口并 connectWs。resolve 即编排已提交——
// 不等待 connected（握手/auth 异步，connected 驱动的视图初始化留壳侧）。
// init() 只消费 env.isMock（mock/真实由壳 env 端口注入），无连接模式参数（双开关源删一）；
// ConnectionPorts 未注入时 useConnection().init() 自身 warn 降级（ES2），bootstrap 层不加检查。
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

/**
 * 声明通路订阅源注入点（容器扩展点统一 §6.2）：壳装配时传入 config.plugins 的订阅原语
 * （生产 = core transport api 的 onPlugins，返回退订函数）。bootstrap 对 transport api
 * 域保持 import 零依赖（编排层只消费注入端口，与 setExtensionRegistries 同范式）；
 * 未注入时 scanContributions 的 external 声明通路降级跳过（warn 出声，builtin 照常注册）。
 */
let pluginListSubscribe: ((handler: (plugins: PluginDescriptorLike[]) => void) => () => void) | undefined

export function setPluginListSource(subscribe: (handler: (plugins: PluginDescriptorLike[]) => void) => () => void): void {
  pluginListSubscribe = subscribe
}

// 壳向 ExtensionHost 注册挂载点（sidebar.tab / panel.header / composer.toolbar）
export async function registerMountPoints(): Promise<void> {
  console.log('[bootstrap] step 4/5 registerMountPoints')
  if (!mountRegistryImpl) {
    console.warn('[bootstrap] registerMountPoints: registry not injected, skip (setExtensionRegistries)')
    return
  }
  // Tier 1 挂载点（§12.1，对齐 audit §12.1 步骤 1）：sidebar tab / panel header / composer toolbar。
  // 命名 SSOT = SDK/descriptor-types（'sidebar.tab' | 'panel.header' | 'composer.toolbar'），
  // renderer ViewHost view-id 按同名路由（MF-8：曾用 'panel.header.action' 导致 listMountPoints 与
  // 渲染端名字失配）。
  mountRegistryImpl.register('sidebar.tab')
  mountRegistryImpl.register('panel.header')
  mountRegistryImpl.register('composer.toolbar')
  // Provider 页挂载位（provider-plugin-access D2/U2）：授权流程与条目扩展内容由插件用
  // GuiComponent 树填充（宿主只画容器），视图归属为全局域 scope（无会话归属，分区键
  // global:<mountId>:<pluginId>）。消费方 = U6 Provider 页接入（u-provider-page）。
  mountRegistryImpl.register('provider.authorize')
  mountRegistryImpl.register('provider.detail-extra')
  // 容器位挂载点三族（容器扩展点统一 §7.2 挂载点注册）：drawer.tab（右抽屉标签页）/
  // overlay.content（浮层内容类型——§6.8 内容注册表形态，非标签页）/ settings.section
  //（设置页分区）。该机制连续第三次真实扩位且零渲染端改动；三族的渲染端派生消费由
  // ContentSlotRegistry 派生视图承接（U6/U7/U8 接线）。
  mountRegistryImpl.register('drawer.tab')
  mountRegistryImpl.register('overlay.content')
  mountRegistryImpl.register('settings.section')
}

// 声明通路订阅句柄（容器扩展点统一 §6.2）：scanContributions 重复调用时先退订旧订阅
// 再重建（dispose-and-rebuild 习语）——闭包绑定当次注入的 registry 实例，防
// setExtensionRegistries 换实例后旧订阅写旧表（对齐 ensureMountPointsSync 的 R2-2 教训）。
let pluginListUnobserve: (() => void) | undefined

// 扫描 plugin manifest 注册声明式贡献（views/menus/commands/slashCommands/configuration）
export async function scanContributions(): Promise<void> {
  console.log('[bootstrap] step 5/5 scanContributions')
  if (!contributionRegistryImpl) {
    console.warn('[bootstrap] scanContributions: registry not injected, skip (setExtensionRegistries)')
    return
  }
  const contributions = contributionRegistryImpl
  const mounts = mountRegistryImpl
  contributions.registerBuiltin()
  // 声明通路（容器扩展点统一 §6.2）：订阅 config.plugins 广播（插件启停/安装/卸载等
  // 7 处触发点均广播），每次到达重跑 loadExternal（幂等，覆盖粒度按 (type, contributionId)
  // 逐项——见 ContributionRegistry.loadExternal）+ routeAll（幂等重算 available）。
  // 非边沿一次性：首帧由连接 initial-state 的 config.plugins 帧覆盖（sendInitialState
  // 推送先于本订阅可达——订阅建立于 bootstrap step5，早于 WS connected，initial-state
  // 帧到达时订阅必已在位），重连后 runtime 重推 initial-state 天然重放。
  if (pluginListSubscribe) {
    pluginListUnobserve?.()
    pluginListUnobserve = pluginListSubscribe((plugins) => {
      contributions.loadExternal(plugins)
      if (mounts) contributions.routeAll(mounts)
    })
  } else {
    console.warn('[bootstrap] scanContributions: plugin list source not injected, external contributions skipped (setPluginListSource)')
  }
  // routeAll 接线（容器扩展点统一 §7.2）：首跑对齐 step4 已注册的挂载点全集；此后每次
  // loadExternal（订阅回调）后重跑，保证新到达声明的 available 反映挂载点注册态。
  if (mounts) contributions.routeAll(mounts)
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
