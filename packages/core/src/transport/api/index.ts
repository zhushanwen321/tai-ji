/**
 * transport/api 入口 —— 自 renderer 壳下沉的 RPC 中间件 barrel（tc-transport-consolidation M0）。
 *
 * 聚合三模块：pending（RPC 结算注册表）/ events（ServerMessage 三通道分发）/
 * request（command 类型化 RPC 原语，出站直连 ../ws-client.send）。
 * domains 子树（M1）与 mock（M2）随后续单元迁入，经各自子路径 exports 消费。
 */
export * from './pending'
export * from './events'
export * from './request'
