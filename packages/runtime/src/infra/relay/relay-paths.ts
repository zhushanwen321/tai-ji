/**
 * relay 基建路径解析。
 *
 * 为什么独立模块：socket / pid 文件 / staged 代理脚本三类路径被 relay-server（listen）、
 * relay-registry（spawn 兜底扫描）、relay-env（主 pi env 注入）三方消费，统一从
 * getDataDir() 动态推导（排查规则：路径白名单禁止写死绝对路径）。dataDir 经参数注入
 * 缺省走 SSOT——测试需要隔离目录（同进程多实例不能共用 pid 命名的 socket）。
 */
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { isPackaged } from '../../utils/runtime-env.js'

/** relay 子进程 pid 文件目录名（<dataDir>/run/relay-children/）。 */
export const RELAY_CHILDREN_DIR_NAME = 'relay-children'

/** relay socket 父目录（<dataDir>/run/）。 */
export function getRelayRunDir(dataDir: string = getDataDir()): string {
  return join(dataDir, 'run')
}

/** relay 子进程 pid 文件目录。 */
export function getRelayChildrenDir(dataDir: string = getDataDir()): string {
  return join(getRelayRunDir(dataDir), RELAY_CHILDREN_DIR_NAME)
}

/**
 * relay socket 监听路径：per-runtime-instance 唯一（路径含 pid——多 app 实例共存互不
 * 串扰，崩溃残留可识别归属）。win32 用 named pipe（node:net 同 API 形态传 pipe 名，
 * 无文件系统残留，故启动探活跳过）；其余平台 unix domain socket。
 */
export function getRelaySocketPath(dataDir: string = getDataDir()): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\taiji-relay-${process.pid}`
  }
  return join(getRelayRunDir(dataDir), `relay-${process.pid}.sock`)
}

/**
 * pid 文件路径：<dataDir>/run/relay-children/<recordId>.pid（设计 §4.2）。
 * recordId 即虚拟分区第三段（subagentVirtualId 的 subagentId），extension 注入、
 * 握手帧携带，runtime 不生成。
 */
export function getRelayPidFilePath(recordId: string, dataDir: string = getDataDir()): string {
  return join(getRelayChildrenDir(dataDir), `${recordId}.pid`)
}

/**
 * staged relay.mjs 路径（dev 与打包双形态，与 findPiExecutable 的 pi 二进制定位同款
 * cwd 约定）：打包 = Resources/extensions/...（process.cwd() = Resources，runtime-manager
 * 设定）；dev = apps/electron/resources/extensions/...（projectRoot = apps/electron）。
 *
 * staged 布局 SSOT = scripts/bundle-extensions.mjs（@zhushanwen/pi-subagent-workflow 的
 * relay/ 资产拷到 staged 包目录下）。路径不存在不是错误——调用方降级为 relay 整体
 * 不激活（E-TUI 兼容语义：回落现状直连 spawn），不报错。
 */
export function getRelayScriptPath(projectRoot: string): string {
  const stagedRel = join('extensions', '@zhushanwen', 'pi-subagent-workflow', 'relay', 'relay.mjs')
  return isPackaged() ? join(process.cwd(), stagedRel) : join(projectRoot, 'resources', stagedRel)
}
