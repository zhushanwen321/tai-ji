/**
 * pi thinking levels 查询门面（pi1-disposition-chat-flow U3③，D5④ 下沉）。
 *
 * pi 系包（@earendil-works/*）的运行时 import 只允许出现在 infra/pi（pi 词汇合法持有点
 * 清单，D5①——import 项机器检查按此口径）。services 层（model-capability.ts）经本门面
 * 消费 pi 同源能力计算，services 零 pi 系 import。
 *
 * 反转正当性与版本纪律（pi-ai 精确 pin / tsup noExternal / D6 四包一致性门禁）登记在
 * model-capability.ts 文件头——本门面只做 import 通路，不复制论述。
 */
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

/**
 * pi 同源「模型支持哪些思考档位」计算（pi-ai 唯一实现副本，taiji 零影子推断）。
 * 签名与 pi-ai 原函数同形（services 侧经 Parameters<typeof 本函数> 派生入参类型，
 * 不在 services 引入 pi-ai 符号）。
 */
export function getPiSupportedThinkingLevels(model: Parameters<typeof getSupportedThinkingLevels>[0]): ReturnType<typeof getSupportedThinkingLevels> {
  return getSupportedThinkingLevels(model)
}
