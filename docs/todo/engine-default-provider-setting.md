# TODO：settings 页面支持配置各引擎的默认 provider/model

## 要做什么

settings 页面新增「subagent 引擎默认模型」配置：读取所有已安装引擎适配包自带的 provider 清单，让用户为每个引擎选择默认 model（含「谁是默认引擎」）。

## 现状（本 TODO 之前的替代形态）

- pi 引擎：零配置——taiji 与 pi 引擎是同一个 pi，provider 配置共享（`~/.pi/agent/` 一份）。
- zcode 引擎：适配包内硬编码缺省 `builtin:bigmodel-coding-plan/GLM-5.3`（`packages/zcode-subagent-cli` 的 `constants.ts` `ZCODE_FALLBACK_DEFAULT_MODEL`，与 `appserver-launcher.ts` 内嵌 wrapper 双源同步——改缺省值两处一起改）。
- 新引擎接入：各自适配包内显式指定缺省（契约 = pi-workflow-run 资源模型设计文档决策 3）。

## 背景与裁决

引擎缺省模型/provider 的归属裁决（2026-09-27）：pi 引擎可用缺省（同一 pi 同一 provider），其他引擎的 provider 与 pi 不同，须在各自适配包指定缺省；settings 页面化是长期形态，本期不做，登记本 TODO 承接。

## 实现要点（届时从这起步）

- 配置读取源：引擎适配包 manifest 的 provider 声明（与 pi-workflow-run 设计的 manifest 契约面同位）。
- 缺省值的消费链：zcode 缺省模型当前在 wrapper 内嵌字符串（appserver-launcher.ts）——页面化后改为注入式（env/manifest 传递），消双源。
- 页面落点：settings 视图（settingsStore.currentView）新增区块；配置持久化进引擎数据目录。
