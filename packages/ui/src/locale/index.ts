/**
 * ui locale 模块双侧聚合入口。消费方（桌面 renderer 聚合改址、移动壳 vue-i18n 装配）
 * 组装 vue-i18n messages 时按 locale 键装配：
 *
 *   messages: { 'zh-CN': zhCN, 'en-US': enUS }
 *
 * 单侧聚合对象形态镜像 renderer 壳聚合（default export 顶层域键 → 嵌套文案树）。
 * 桌面 renderer 的聚合文件只改 import 地址消费本模块的域文件，panel 命名空间的
 * tray 子树展开合并仍在 renderer 侧完成（tray 文案留守 renderer 壳）。
 */
import zhCN from './zh-CN'
import enUS from './en-US'

export { zhCN, enUS }
