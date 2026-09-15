/**
 * Extension 配置域 ports —— settings.json 的 packages[] + disabled-packages.json。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/pi-extension-settings.ts 实现（经
 * pi-settings-store 统一读写层访问 settings.json）。
 *
 * 为什么单独一个 port（不塞进 IConfigStore）：
 * settings.json 同时被 model 域（defaultModel/skills/...）和 extension 域（packages[]）读写。
 * 两个域管的是同一文件的不同字段——物理同文件、逻辑分区。给每个域一个窄 port，
 * 各 port 的实现都经 pi-settings-store（唯一读写层 + 跨进程锁 + 字段域 merge），
 * 杜绝跨域 RMW 竞态（D17）。
 *
 * disabled-packages.json 是 taiji 自己的文件（pi 不读），与 settings.json 分离，
 * 仍归本域管理（toggle/disable 语义），但不经 settings.json 的互斥——它没有跨域竞争。
 */

/**
 * Extension 配置 port —— pi settings.json 的 packages[] + disabled-packages.json。
 *
 * 读操作同步（settings.json 经 pi-settings-store 的 3s 缓存，高频读不触盘）；
 * 写操作异步（经 pi-settings-store.updateSettingsFields 的锁内 RMW + extension 字段域
 * merge——跨进程与 pi 互斥靠 proper-lockfile；签名保持 async 守 port 契约）。
 */
export interface IExtensionSettings {
  // ── settings.json packages[]（extension 安装清单）──
  /** 读取已记录的 packages[]（形如 'npm:pi-foo'）。 */
  getPackages(): string[]
  /** 追加一个 package source 到 packages[]（去重，已存在则 no-op）。 */
  addPackage(source: string): Promise<void>
  /** 从 packages[] 移除指定 source（不存在则 no-op）。 */
  removePackage(source: string): Promise<void>

  // ── disabled-packages.json（启用/禁用状态，taiji 自己的文件）──
  /** 读取被禁用的 source 集合。 */
  getDisabled(): string[]
  /** 设置某个 source 的启用状态（enabled=false 加入禁用，enabled=true 移除）。 */
  setEnabled(source: string, enabled: boolean): Promise<void>

  // ── auto-upgrade-packages.json（自动升级配置，taiji 自己的文件）──
  /** 读取启用自动升级的 source 集合。 */
  getAutoUpgrade(): string[]
  /** 设置某个 source 的自动升级状态（autoUpgrade=true 加入，false 移除）。 */
  setAutoUpgrade(source: string, autoUpgrade: boolean): Promise<void>
}
