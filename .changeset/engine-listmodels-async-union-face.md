---
"@zhushanwen/subagent-core": minor
---

EnginePort.listModels 改为 union 门面：manifest 静态快照可枚举时同步返回快照（不发帧），无静态枚举（省略 / null / dynamic:true 空清单）时经协议 listModels RPC 取引擎活清单（10s 控制域超时）。engineDefaults 偏好层成员校验（resolveEngineModelWithTranslation）随之异步化：远程引擎的失效偏好模型引用在派发前被拦截（原先只在引擎侧以 model_not_available 失败）；RPC 失败放行并按引擎一次性 warn，引擎侧 validateModel/run prepare 防线保留。
