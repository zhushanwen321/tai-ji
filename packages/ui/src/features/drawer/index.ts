/**
 * @taiji/ui features/drawer barrel（W3 · p3-strangler-domains::drawer）。
 *
 * 导出跨端共享 drawer 容器 DrawerPanel（tab 栏 + 钉住/关闭 + 空态 + 内容面板 slot）。
 * [P4 s5 drawer-widget-removal] widget 内容区 + status footer 已删（旧 widget 通道由
 * PluginViewContainer 承接，DrawerStatusEntry 类型随删）。
 * 消费方（renderer 壳 PanelContainer，W4）经 '@taiji/ui/features/drawer'
 * 子路径 import（对齐 ./features/settings / ./features/composer 子路径范式）。
 *
 * 桌面独占内容面板经默认 slot 挂载（D5 硬编码占位）。类型对齐 IF2 契约。
 */
export { default as DrawerPanel } from './DrawerPanel.vue'
