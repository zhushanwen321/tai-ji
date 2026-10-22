# workflow_run 保留键通道解释误判嵌套 required 同名键

状态：未解决（2026-10-23 登记；dev-merge-gates 分支横切审查残余，severity minor——错误的附加解释文案，不影响校验行为本身）

## 现状

`extensions/universal/subagent-workflow/src/interface/tool/tool-workflow.ts` 的保留键双通道解释链路：

- `missingRequiredKeysOf`（:599）从 ajv 错误数组提取缺失 required 键时只读 `params.missingProperty`，**不检查 `instancePath`**——ajv 对嵌套对象内部的 required 缺失同样产生 `missingProperty`，此时 `instancePath` 才指向真实位置（如 `/args/tasks/0`）。
- `reservedKeyChannelError`（:574）把提取出的键与 `RESERVED_OVERRIDE_KEYS` 相交，相交即在原错误后附加「该键是 run 级覆盖、脚本参数要放进 args、正确形状是 …」的通道解释。

误判场景：脚本 `args` 内嵌套 schema 存在与保留键同名的 required 键（如嵌套对象里的 `name`）且调用方缺传该嵌套键时，`missingProperty` 命中保留键集合，错误文案被附加上一条不成立的「顶层键是 run 级覆盖」解释，误导排障方向。

## 影响

仅错误信息质量：原始 ajv message 仍在（校验拒绝行为正确），附加的解释与实际缺参位置不符，agent / 用户按解释修正参数会修错地方。

## 修复方向（待裁决）

`missingRequiredKeysOf` 提取时过滤 `instancePath`：仅收集 `instancePath === ""`（顶层 required）的缺失键；嵌套缺失归入「普通缺参」走原样透出分支。改动单点、无行为面变化。

## 证据

dev-merge-gates run dmg-0c8ddeaf7 round-1 审查残余（aggregated.md 编号 dmg-r1-1）；机制链路经源码核实（2026-10-23，函数行号见现状节）。
