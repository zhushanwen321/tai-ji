---
"@zhushanwen/zcode-subagent-cli": patch
---

fix(zcode-engine): mirror resolved reasoningLevel into create thoughtLevel — sole effective reasoning channel on zcode CLI 3.15.x

zcode CLI 的 session/create 处理器把 model 经 formatProtocolModelSelection 转 "provider/modelId" 字符串时丢弃 model.options（schema 声明并接收、handler 不透传），reasoning 档位实际只由独立 thoughtLevel → app.setThoughtLevel 应用。引擎此前只发 model.options.reasoningLevel：thinkingLevel 缺席（子代理派发默认形态）与 thinkingLevel=off/minimal（CLI 值域无 off 档被跳过）两个形态的会话推理档位为空，turn 阶段被拒 reasoning-level-missing（"Reasoning level is required"）。修复：解析出的 reasoningLevel 镜像为 create 帧 thoughtLevel（reasoningLevelFor 已把缺席/off 族/非命中档归一到值域内，镜像值即意图档位）；options 保留兼容旧 CLI 代际；无值域模型维持 thinkingLevel 透传现状。同批同步 RX2-F1 非常见档位提示措辞（透传 → 解析后下发）。
