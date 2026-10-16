---
"@zhushanwen/pi-ext-guards": minor
---

新增 taiji GUI 宿主判定谓词共享导出：isTaijiHost（env 信号腿）、isTaijiGuiHost（env + rpc 模式完整谓词）、TAIJI_GUI_HOST_ENV（判定 env 键）与 GuiHostContextLike（宿主形态最小结构面）——plan / canvas 两扩展的原双实现收敛至本包单点（dmg-r1-7），一致性由构造保证。
