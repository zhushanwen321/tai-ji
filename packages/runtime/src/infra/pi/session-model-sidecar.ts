/**
 * Session model binding sidecar（`<sessionFile>.model.json`）家族。
 *
 * 从 session-file-utils.ts 提取（行数合规）：三函数与字段声明随迁，函数体逐字节不变。
 * persistBindingSidecar / readBindingSidecar 公共骨架已下沉 './session-binding-sidecar-io.ts'
 * 叶子模块（preset/project/agent/model 四家族共用；原「本文件从 session-file-utils import
 * 骨架」构成两模块函数级循环引用，被 PR fallow audit 拦截后下沉消除）。
 *
 * [缓存治理批 3 U7] 读侧数据源切换：readModelBinding 改为反向读 session JSONL 真源
 * （extractLatestModelFromJsonl，见 session-file-utils.ts），sidecar 文件不再是模型
 * 绑定的读取来源（写点 persistModelBinding 本单元原样保留，U8 退役——先换读实现、
 * 后删写点，中途态「旧 sidecar 还在写但没人读」无害）。U8 删本模块时：
 * ① file-utils 对 readModelBinding 的 import 改为直接消费本模块导出的
 * extractLatestModelFromJsonl（第七读同模块直调）；② 本条 import 形成的
 * sidecar → file-utils 函数级循环边随之自然消失（两侧均纯函数声明，循环仅过渡态存在）。
 *
 * 与 preset/project/agent sidecar 家族并列独立：写点族（switchModel / setThinkingLevel /
 * create / fork / restore 播种，U8 退役）写生效值，scanner scanSessionMeta 第七读
 * 经 readModelBinding 提取进 ScannedSessionMeta（U7 起读侧 = session JSONL 反向读真源）。
 */
import { persistBindingSidecar } from './session-binding-sidecar-io.js'
// 过渡态循环边（U7 引入、U8 拆除，见头部注释）：readModelBinding 的反向读实现锚定在
// session-file-utils（U8 后 scanSessionMeta 第七读的同模块直调终态位置）。
import { extractLatestModelFromJsonl } from './session-file-utils.js'

/**
 * model binding 的扫描字段声明（ScannedSessionMeta extends 收编）。
 *
 * 字段 SSOT 与 model sidecar IO 同文件归属（随本家族自 session-file-utils.ts 迁出，
 * 行数合规）；session-binding-fields.ts 的 BindingFieldKey 经
 * OptionalKeys<ScannedSessionMeta> 派生，对 extends 收编的字段照常生效，注册表无需改动。
 */
export interface ModelBindingFields {
  /**
   * 该 session 生效的模型 id。[U7 起] 反向读 session JSONL（model_change / assistant
   * entry 最近一条，JSONL 真源），'provider/modelId' 格式。undefined 表示无模型信息
   * （历史 session path 上无任何模型 entry / 文件不存在）。
   */
  modelId?: string
  /**
   * 该 session 生效的思考等级。[U7 起] 反向读 session JSONL（thinking_level_change
   * 最近一条）；无 entry 时为 pi 默认 'off'。undefined 表示无模型信息（随 modelId）。
   */
  thinkingLevel?: string
}

/**
 * 计算 session model binding sidecar 路径。
 * `<sessionFile>.model.json`：session 的模型与思考等级绑定信息（与 preset/project/agent sidecar 并列独立）。
 */
export function modelSidecarPath(filePath: string): string {
  return filePath + '.model.json'
}

/**
 * 将 session 模型绑定持久化到 sidecar `.model.json`（model binding）。
 *
 * switchModel / setThinkingLevel 生效后调用，记录 session 当前绑定的 modelId 与 thinkingLevel。
 * 与 preset/project/agent sidecar 并列独立。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**：pi 延迟写入窗口内
 * existsSync=false → 静默跳过。
 *
 * @param filePath session JSONL 绝对路径（sidecar = modelSidecarPath(filePath)）
 * @param modelId 模型 id（'provider/modelId' 格式）
 * @param thinkingLevel 思考等级
 */
export function persistModelBinding(filePath: string, modelId: string, thinkingLevel: string): void {
  if (!filePath || !modelId) return
  persistBindingSidecar(
    filePath,
    modelSidecarPath,
    { modelId, thinkingLevel, version: 1 as const },
    'model',
  )
}

/**
 * 读取 session 生效的模型绑定。[U7 起] 反向读 session JSONL 真源（extractLatestModelFromJsonl）：
 * 与 pi 恢复读路径（getSessionContextSettings）同源，pi 侧切换 / taiji 侧切换都在下一次
 * 扫描可见，无 sidecar 二手快照的失真面（G3）。
 *
 * scanSessionMeta 第七读：与 agent/project/preset 同批次提取，结果合并进
 * ScannedSessionMeta.modelId / thinkingLevel，享受 sessionMetaCache 缓存（键 = JSONL
 * (mtimeMs, size)，pi append 后必 miss 重扫——反向读成本只在文件变化时发生一次）。
 *
 * 函数签名与返回形态不变（调用方零改动）；sidecar 文件不再被本函数读取（`.model.json`
 * 存在与否不影响返回值）。写点 persistModelBinding 本单元原样保留（U8 退役）。
 *
 * @returns { modelId, thinkingLevel }；JSONL 无模型信息/文件不存在/损坏 → undefined
 *          （thinkingLevel 无 entry 时为 pi 默认 'off'，非 undefined）
 */
export function readModelBinding(filePath: string): { modelId: string; thinkingLevel: string } | undefined {
  return extractLatestModelFromJsonl(filePath)
}
