---
id: engram-bridge-recall
title: Engram Bridge Recall
type: technical.contract
status: draft
triggers:
  keywords:
    - mem_bridge_recall
    - 读层
    - 检索质量
    - 截断
  read_when:
    - 实现或评审桥自有的记忆检索入口
    - 排查检索结果不符合预期或记忆检索不可用
scope:
  projects: [dsh-plugin-gentleai-engram]
anchors:
  files:
    - src/recall-tool.ts
    - src/index.ts
    - src/tools.ts
  config_keys:
    - searchEnabled
    - searchW
    - searchTopK
    - searchCoverage
related:
  specs:
    - engram-bridge-runtime
    - engram-context-injection
---

## MODIFIED Requirements

### Requirement: 运行时或模型缺失时响亮失败
当判定发现检索所需的运行时或模型**不可用**——文件缺失，或内容与本项目声明的期望身份不符——时，检索 SHALL 以明确的错误失败，SHALL NOT 用该内容作答。判定 SHALL 依据**本项目声明的期望身份**，SHALL NOT 只依据「文件是否存在」，也 SHALL NOT 依据安装过程自己写下的记录（那是"实际装了什么"，不是"应该是哪一份"）。判定 SHALL 发生在该次检索**实际读取**该运行时或模型之前；判定 SHALL NOT 使每次检索都读取全部内容（一次检索若不需要重新读取，就不重新判定）。该失败 SHALL 限于该次检索：宿主进程 SHALL NOT 因此退出，同一会话的后续回合 SHALL 仍可正常进行，且该失败 SHALL 在会话日志里可读。派生数据自身的缺失或损坏 SHALL NOT 走这条路径，而 SHALL 由重建处理。两者同时不满足时，报运行时或模型缺失。

#### Scenario: 运行时缺失
- **WHEN** 检索所需的运行时或模型文件缺失，而派生数据完好
- **THEN** 该次检索返回明确错误，同一会话的后续回合仍可正常进行

#### Scenario: 内容与声明的期望身份不符
- **WHEN** 判定发现某个文件存在，但内容与本项目声明的期望身份不符
- **THEN** 该次检索返回明确错误，且错误里指名不符的文件

#### Scenario: 失败限于该次检索
- **WHEN** 上述任一种失败发生
- **THEN** 宿主进程未退出（pid 不变），同一会话的后续回合与其它工具仍可正常进行，工具面不变

#### Scenario: 恢复后无需重启
- **WHEN** 使内容不符的原因被消除（文件恢复成声明的那一份）
- **THEN** 紧接着的下一次检索恢复正常，不需要重启宿主

#### Scenario: 派生数据损坏
- **WHEN** 派生数据存在但已损坏或不可读，而运行时与模型可用
- **THEN** 检索通过重建它来恢复，而不是返回运行时缺失那类错误

#### Scenario: 两者同时不满足
- **WHEN** 派生数据缺失且运行时或模型也不可用
- **THEN** 返回的是运行时或模型缺失那类错误

## ADDED Requirements

### Requirement: 派生索引与当前声明的模型同代
当派生索引里的向量**不是由当前声明的模型算出的**时，检索 SHALL 重建索引，SHALL NOT 用其它模型算出的向量作答——否则新模型算出的查询向量会与旧模型算出的文档向量比较，静默地给出另一个空间里的结果；若只重算变化过的文档，还会得到同一个索引里混着两套向量空间。

#### Scenario: 声明的模型换成另一份之后
- **WHEN** 插件升级到声明了另一份模型的版本、并按新声明重装模型，而盘上的派生索引仍由先前那份生成
- **THEN** 紧接着的检索重建索引，而不是用先前的向量作答

#### Scenario: 索引没有记录它由哪一份模型生成
- **WHEN** 盘上的派生索引由更早的版本生成，因而无从判断它属于当前声明的哪一份模型
- **THEN** 该索引被视为需要重建
