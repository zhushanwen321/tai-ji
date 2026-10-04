/**
 * PiExtensionSettings — IExtensionSettings port 的 infra 实现。
 *
 * 实现 settings.json packages[]（经 pi-settings-store 统一读写层）+
 * disabled-packages.json（taiji 自己的文件，独立原子读写）。
 *
 * 🔒 settings.json 的 RMW 经 pi-settings-store.updateSettingsFields（跨进程锁 +
 * 字段域 merge，D1a/D1b），与 model 域（pi-provider-store）共享同一读写层与锁，
 * 杜绝跨域竞态（D17）。
 *
 * P0-1：disabled-packages.json 的读写收敛到 JsonStore（shouldDeleteWhen 实现空则删）。
 */

import { join } from 'node:path'
import { JsonStore } from '../../utils/json-store.js'
import type { IExtensionSettings } from '../../services/ports/extension-settings.js'
import { updateSettingsFields, readSettings } from './pi-settings-store.js'
import { getPiAgentDir } from './pi-paths.js'

const DISABLED_FILE = 'disabled-packages.json'
const AUTO_UPGRADE_FILE = 'auto-upgrade-packages.json'

type DisabledRecord = { disabled: string[] }
type AutoUpgradeRecord = { autoUpgrade: string[] }

/**
 * disabled-packages.json 存储：read-through（ENOENT 容错）+ atomicWrite。
 * 空数组时删文件（shouldDeleteWhen），与原 writeDisabledArray 行为一致。
 */
function createDisabledStore(path: string): JsonStore<DisabledRecord> {
  return new JsonStore<DisabledRecord>(path, { disabled: [] }, {
    shouldDeleteWhen: (v) => v.disabled.length === 0,
  })
}

function createAutoUpgradeStore(path: string): JsonStore<AutoUpgradeRecord> {
  return new JsonStore<AutoUpgradeRecord>(path, { autoUpgrade: [] }, {
    shouldDeleteWhen: (v) => v.autoUpgrade.length === 0,
  })
}

/**
 * IExtensionSettings 实现。
 * @param settingsDir pi agent 配置目录（<dataDir>/agent），disabled-packages.json /
 *                    auto-upgrade-packages.json 所在地（实例自有 store 的根）。
 *                    生产默认 getPiAgentDir()；测试注入临时目录。
 *
 * [RT-3#12 去全局化] settings.json 域经 pi-settings-store 模块级单一所有者（D17），
 * 本构造函数**不再**调用 setSettingsPath——模块级写入目标被最后构造者决定是机械缺陷
 * （生产实参与 getSettingsPath() 同值，调用本是 no-op；副作用只在测试互相干扰）。
 * 需要重定向 settings.json 的测试/组合根显式调用 setSettingsPath（全仓测试已是此惯例）。
 * disabled/autoUpgrade 读取走实例字段 JsonStore（不再每次读新建 store，恢复指纹缓存语义）。
 */
export class PiExtensionSettings implements IExtensionSettings {
  private readonly settingsDir: string
  private readonly disabledStore: JsonStore<DisabledRecord>

  private readonly autoUpgradeStore: JsonStore<AutoUpgradeRecord>

  constructor(settingsDir: string = getPiAgentDir()) {
    this.settingsDir = settingsDir
    this.disabledStore = createDisabledStore(join(settingsDir, DISABLED_FILE))
    this.autoUpgradeStore = createAutoUpgradeStore(join(settingsDir, AUTO_UPGRADE_FILE))
  }

  // ── settings.json packages[] ──

  getPackages(): string[] {
    // 经 pi-settings-store 读（JsonStore 指纹缓存：外部写方含 pi 子进程，任何改动在
    // 下一次 read 的 stat 指纹失配中立即可见——RT-3#12 移除读前 invalidateSettingsCache，
    // 该全局失效会绕空指纹缓存让每次读全量触盘，与缓存设计相悖且无正确性收益）。
    const settings = readSettings()
    return settings.packages ?? []
  }

  async addPackage(source: string): Promise<void> {
    // 锁内 sync RMW + extension 域 merge（Node 单线程 + sync IO 进程内不交错；
    // 跨进程与 pi 互斥靠 pi-settings-store 的 proper-lockfile 锁）。
    // 签名保持 async 守 IExtensionSettings port 契约。
    updateSettingsFields('extension', s => {
      const packages = s.packages ?? []
      if (!packages.includes(source)) {
        packages.push(source)
        s.packages = packages
      }
    })
  }

  async removePackage(source: string): Promise<void> {
    updateSettingsFields('extension', s => {
      const packages = (s.packages ?? []).filter(p => p !== source)
      s.packages = packages
    })
  }

  // ── disabled-packages.json ──

  getDisabled(): string[] {
    // RT-3#12：走实例字段 store（read-through + 指纹缓存）——不再每次读新建 JsonStore
    //（新建即无缓存，读侧指纹失效机制被绕空）。
    return this.disabledStore.read().disabled
  }

  async setEnabled(source: string, enabled: boolean): Promise<void> {
    const current = this.disabledStore.read().disabled
    let next: string[]
    if (enabled) {
      next = current.filter(d => d !== source)
    } else {
      next = current.includes(source) ? current : [...current, source]
    }
    this.disabledStore.write({ disabled: next })
  }

  // ── auto-upgrade-packages.json ──

  getAutoUpgrade(): string[] {
    return this.autoUpgradeStore.read().autoUpgrade
  }

  async setAutoUpgrade(source: string, autoUpgrade: boolean): Promise<void> {
    const current = this.autoUpgradeStore.read().autoUpgrade
    let next: string[]
    if (autoUpgrade) {
      next = current.includes(source) ? current : [...current, source]
    } else {
      next = current.filter(d => d !== source)
    }
    this.autoUpgradeStore.write({ autoUpgrade: next })
  }
}
