/**
 * runtime 自登记文件契约（runtime 写、Electron supervisor 读的唯一共享形状）。
 *
 * 单一权威在 shared：runtime 侧 single-instance-guard 写入、supervisor 侧
 * port-discoverer 收割判定读取——两侧各自重声明文件名/字段形状会漂移（漂移后果 =
 * supervisor 判「无残留」跳过收割、残留 runtime 占端口），故上收一处。
 */

/** runtime 自登记文件名（single-instance-guard 写入，位于数据目录根，0600）。 */
export const RUNTIME_INSTANCE_FILE = 'runtime-instance.json'

/** runtime-instance.json 内容（registerRuntimeInstance 写入）。 */
export interface RuntimeInstanceRecord { // oe-exempt:20261001:framework:runtime-instance.json 文件形状契约——runtime 写 / supervisor 读的跨进程数据契约（自 guard 上收 shared 消双源），非投机抽象
  pid: number
  port: number
  startedAt: string
}
