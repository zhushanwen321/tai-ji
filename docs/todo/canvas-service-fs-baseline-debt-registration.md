# canvas-service.ts 直用 node:fs/node:path 未登记 runtime-layering 基线债清单

状态：未解决（2026-10-16 dev-merge branch-review 第 3 轮登记，dmg-r3-2，minor）

## 现状

`packages/runtime/src/services/canvas/canvas-service.ts:25-26` value import `node:fs`（existsSync/mkdirSync/appendFileSync/readFileSync/readdirSync/writeFileSync）+ `node:path`，为 services 层持久化 IO（非 logger 横切、非 kernel 纯函数，不满足 `docs/architecture/runtime-layering.md` §3 受控例外两类）。

runtime-layering.md §3 ④「node:fs 直用——基线债登记（非合规例外）」制度在册且逐批登记同分支新增文件（含 2026-10-12 批「本分支新增文件三个」先例），清单内无任何 canvas 文件——canvas-service.ts 漏登记。

## 修复指引

在 docs/architecture/runtime-layering.md §3 ④ 基线债清单按既有批次格式增补 canvas-service.ts 条目：fs 面（events.jsonl appendFileSync / canvas.json writeFileSync+atomicWrite / exports writeFileSync / 启动扫描 readdirSync / 目录 mkdirSync）+ 同族形态（对齐 gen-stats-store 存储落盘族）+ 收编路线（「随 ports 收编统一迁移」），登记与修复同 commit 提交。
