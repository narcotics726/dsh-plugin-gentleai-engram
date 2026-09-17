## MODIFIED Requirements

### Requirement: 压缩恢复开关
`compactionRecovery` 为 false 时，插件 SHALL NOT 写入摘要、SHALL NOT 注入上下文，且插件自带的协议文本 SHALL NOT 要求模型自己完成这两件事——关闭即完全关闭，本行为只有这一个所有者。

#### Scenario: 关闭压缩恢复
- **WHEN** `compactionRecovery` 为 false 且发生压缩
- **THEN** engram 中该会话 summary 不变，模型侧无注入

#### Scenario: 关闭时模型侧的文本也不兜底
- **WHEN** `compactionRecovery` 为 false，读取插件自带的两份协议文本（常驻触发段与按需加载的流程技能）
- **THEN** 两份文本里都没有要求模型在压缩后自行补写摘要或恢复上下文的义务
