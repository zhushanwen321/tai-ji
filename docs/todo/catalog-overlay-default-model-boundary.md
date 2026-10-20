# 目录投喂模型的默认模型可见性边界（已接受，provider-catalog-sync D4）

状态：已接受边界（2026-10-20 D3 端到端验收实证登记；不立项一阶段修法）

关联：与 [catalog-overlay-models-json-boundary.md](catalog-overlay-models-json-boundary.md)
同族（目录投喂通道与既有配置/校验层的边界族）；D1 验收对同一边界的 environment 归档见
`provider-catalog-sync.acceptance/summary.md` V1 行。

## 边界内容

runtime 的默认模型有效性校验（`packages/runtime/src/infra/pi/pi-provider-store.ts` 的
`findValidDefaultModel`）基准 = `agent/models.json` 文件 + catalog-only 裁决，**不含目录
投喂注入集合**——目录投喂进 pi 的 overlay-only 模型（如 `xiaomi-token-plan-cn/MiniMax-M3.1-Flash`）
**不可设为持久默认模型**：写入 `agent/settings.json` 的 defaultProvider/defaultModel 后，
runtime 下一次 `getDefaultModel()` 读取即判无效并 auto-fix 回退到 models.json 内的可用模型。

附带边界：UI 模型选择器的可选项 = `enabledModels`（用户策展清单），投喂模型不在其中——
用户在界面上没有「把投喂模型设为默认/当前」的操作对象。

## 判定方法

spawn 命令行的 `--model` 与 settings 期望不一致，且 runtime 日志出现
`[provider-store] auto-fixed defaultModel: <provider/model>` 行。

## 为什么接受（有替代通道 × 校验基准并入注入集有语义代价）

- **投喂模型的实际使用通道不受阻**：会话级 `set_model` 可切到投喂模型（A6 场景实证
  runtime-set-model 成功）；pi CLI/子代理派发的显式 `--model` 直接命中投喂模型（A2 场景
  实证 direct-hit 无回退）。默认模型只是三条指定通道之一。
- **校验基准并入注入集有真实代价**：注入集合是运行中动态态（缓存刷新 + tick 检出），
  校验基准若并入则 `findValidDefaultModel` 需要读注入快照（跨进程时序依赖），且 auto-fix
  的「回退到确定可用」安全语义被稀释——把「确定可用」的判定从磁盘文件扩到运行时快照。
- **真实需求未出现**：真机数据中不存在把投喂模型设默认的用户路径（D1 归档 + D3 复核）。

## 复审/立项条件

若用户反馈「想把投喂的 overlay-only 模型设为默认」：立项 = `findValidDefaultModel` 的
校验基准并入注入集合（读注入后快照，含跨进程时序评估）；或 UI 模型选择器数据源并入投喂
集合（enabledModels 之外增补）。两者择一前先对「默认模型」的三条指定通道（默认 / 会话级
set_model / 显式 --model）做需求归并。
