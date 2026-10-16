---
"@zhushanwen/pi-canvas": minor
---

新增 pi-canvas 扩展：注册 canvas_enter / canvas_edit / canvas_read / canvas_review / canvas_export / canvas_list 六个 deferred 画布工具，agent 经 CANVAS_MARKER 通道与 taiji 画布服务桥接，支持在问题解决画布上生长论证图（论据条目可声明素材性 fact/claim；fact 论据创建即未核实，agent 不自证核实，核实经 canvas_edit patch 翻转后该论据才可作为 passed 依据）、接受 must-fix 审查回推并导出需求卡；仅在 taiji GUI 宿主（rpc 模式）下启用。
