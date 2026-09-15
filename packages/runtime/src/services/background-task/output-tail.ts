/**
 * 后台任务输出文件 tail 读取（D7：按需尾部预览 + running 跟随刷新）——runtime 侧
 * 产品口径层。tail 算法自 ext-simplify-13 起下沉 protocol（`readOutputTail`，跨端
 * 单一实现——此前与 bte 侧两份逐行同构副本靠注释对齐，参数序与返回字段名已实际
 * 漂移），本文件不再持有算法实现，只保留：runtime 侧默认口径常量（32KB 字节上界
 * 是 D3 `backgroundTask.output` RPC 默认上界，非 bash_output 的 50KB——UI 尾部
 * 预览不需要 AI 上下文预算口径；两个默认值都留在各自调用方，不进 protocol）+
 * protocol 实现的 re-export（消费方 background-task-service 经本文件 import，路径
 * 单点）。
 *
 * 文件不存在/不可读时 protocol readOutputTail 返回 undefined——调用方（u-runtime-rpc
 * 的 output RPC handler）据此降级为 lost 语义（§3.1 失败路径「输出不可用（文件已
 * 清理）」），不崩溃。
 */

export {
  readOutputTail,
  type OutputTailLogFn,
  type OutputTailOptions,
  type OutputTailResult,
} from '../../utils/protocol-background-task.js'

/** 默认字节窗口上界（D3：默认 32KB = 32_768 字节；调用方实参，protocol 不设默认值）。 */
export const OUTPUT_TAIL_DEFAULT_MAX_BYTES = 32_768
/** 行数上限（UI 预览场景 2000 行足够；调用方实参）。 */
export const OUTPUT_TAIL_MAX_LINES = 2000
