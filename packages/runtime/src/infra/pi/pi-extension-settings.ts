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
import { updateSettingsFields, readSettings, invalidateSettingsCache, setSettingsPath } from './pi-settings-store.js'
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
 * F6: disabled-packages.json 的单一读取入口（模块私有）。
 *
 * [HISTORICAL] 引入时 extension-resolver 也直接 readFileSync + JSON.parse 读同一文件，
 * 同进程两读路径有 split-brain 风险，故收敛到此处共享 JsonStore 的 ENOENT 容错 + 解析逻辑。
 * 现 resolver 已是纯发现层（不读 disabled），本函数仅本模块内部（PiExtensionSettings 的
 * getDisabled / setEnabled 等读取）使用。
 *
 * @param settingsDir pi agent 配置目录（disabled-packages.json 所在地）
 * @returns 禁用的 source 字符串数组（文件缺失/解析失败时返回 []）
 */
function readDisabledPackages(settingsDir: string): string[] {
  return createDisabledStore(join(settingsDir, DISABLED_FILE)).read().disabled
}

/**
 * auto-upgrade-packages.json 的单一读取入口（模块私有，仅本模块内部使用）。
 *
 * @param settingsDir pi agent 配置目录
 * @returns 启用自动升级的 source 字符串数组（文件缺失/解析失败时返回 []）
 */
function readAutoUpgradePackages(settingsDir: string): string[] {
  return createAutoUpgradeStore(join(settingsDir, AUTO_UPGRADE_FILE)).read().autoUpgrade
}

/**
 * IExtensionSettings 实现。
 * @param settingsDir pi agent 配置目录（<dataDir>/agent），settings.json + disabled-packages.json 所在地。
 *                    测试可注入临时目录；生产默认 getPiAgentDir()。
 */
export class PiExtensionSettings implements IExtensionSettings {
  private readonly settingsDir: string
  private readonly disabledStore: JsonStore<DisabledRecord>

  private readonly autoUpgradeStore: JsonStore<AutoUpgradeRecord>

  constructor(settingsDir: string = getPiAgentDir()) {
    this.settingsDir = settingsDir
    this.disabledStore = createDisabledStore(join(settingsDir, DISABLED_FILE))
    this.autoUpgradeStore = createAutoUpgradeStore(join(settingsDir, AUTO_UPGRADE_FILE))
    // 让 pi-settings-store 指向同一 settingsDir 的 settings.json，保证 model 域与
    // extension 域在测试（注入临时目录）和生产（getPiAgentDir）都读写同一文件（D17 单一所有者）。
    setSettingsPath(join(settingsDir, 'settings.json'))
  }

  // ── settings.json packages[] ──

  getPackages(): string[] {
    // 经 pi-settings-store 读（带缓存）。注意：读的是 settings.json，不是 disabled。
    // readSettings 来自 pi-settings-store，路径固定为 getSettingsPath()——测试需把 settingsDir
    // 的 settings.json 放到对应位置（与原 ExtensionService 行为一致，原代码也读 getPiAgentDir()）。
    invalidateSettingsCache()
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
    // F6: 经共享单一读取入口（本模块私有函数，杜绝分散直读文件）。
    return readDisabledPackages(this.settingsDir)
  }

  async setEnabled(source: string, enabled: boolean): Promise<void> {
    const current = readDisabledPackages(this.settingsDir)
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
    return readAutoUpgradePackages(this.settingsDir)
  }

  async setAutoUpgrade(source: string, autoUpgrade: boolean): Promise<void> {
    const current = readAutoUpgradePackages(this.settingsDir)
    let next: string[]
    if (autoUpgrade) {
      next = current.includes(source) ? current : [...current, source]
    } else {
      next = current.filter(d => d !== source)
    }
    this.autoUpgradeStore.write({ autoUpgrade: next })
  }
}
