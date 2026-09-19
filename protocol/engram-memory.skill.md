---
name: engram-memory
description: >-
  engram 持久记忆的完整流程：保存格式、topic_key、候选裁决、检索、会话收尾、排查。
  用户说「记住 / 回忆 / 查一下之前」时、写完 bug 修复或做出决定后、结束会话前加载。
  常驻的触发条件是插件自带的一段系统提示词。
version: 3
---

# Engram 记忆协议（流程）

常驻层（插件自带的一段系统提示词）只写「什么时候必须做」；本文件写**那些时机的具体做法**。
工具名是 `mcp__engram__mem_*`。

## 1. 项目与会话：不要传 `project` / `session_id`

桥在 `agent/session-start` 把 dsh 会话绑到 engram 会话，并对每个声明了 `project` /
`session_id` 的 engram 工具注入二者（`directory` = 会话工作区，只用于 `mem_session_start`）。

- **不要传 `project` / `session_id`**。仅在**故意**过滤别的项目时才显式传
  （例：`mem_bridge_recall(project: "<其它项目名>")`）——显式参数优先于注入。
- 注入优先级：显式参数 > `projectOverrides[<绝对工作区路径>]` > engram 自己按会话目录解析出的
  项目 > `ENGRAM_PROJECT` > 不注入。`projectOverrides` 配在 `~/.dsh/cordis.patch.yml` 的
  `engram-bridge` 条目下（放需要钉死的例外：某个工作区路径 → 某个固定项目名）。
- 桥**不会**退化成 `basename(dir)`；engram 对没有根据的项目名硬失败（`unknown_project`）。
- `mem_current_project` 报的是 engram 服务进程的**全局 cwd 检测**（与会话无关，常是 $HOME 下
  某个仓库），**不可信**——以注入的会话项目为准。
- 子进程 cwd 就是会话工作区，所以靠 cwd 解析的调用（如 `mem_session_end`）也落在对的项目。
- 会话标识或项目注入被关掉、又没显式传值时，保存会被**明确拒绝**（不会静默写一条没有归属的
  记忆）。两条出路：显式传那个值，或打开对应的注入开关。

## 2. 保存：`mem_bridge_save`

`mem_bridge_save` 是桥自己的保存入口（engram 原本的保存工具**刻意不注册**，不可调用）。
参数与原来同形：

- **title**：动词 + 对象，短、可检索（"Fixed N+1 query in UserList"、"Chose Zustand over Redux"）。
- **type**：`bugfix` | `decision` | `architecture` | `discovery` | `pattern` | `config` | `preference`；
  省略时是后端的默认值 `manual`。
- **scope**：`project`（默认）| `personal`。
- **topic_key**：可选，演进中的主题建议给——见 §3。
- **content**：

  ```
  **What**: 一句话——做了什么
  **Why**: 动机（用户要求、bug、性能……）
  **Where**: 涉及的文件 / 路径
  **Learned**: 坑、边界、意外之处（没有就省略）
  ```

桥**刻意不注册**三组 engram 工具：被动捕获类、重复提示词写入类（`mem_save_prompt`）、
以及被上面这个入口取代的原始保存工具（`mem_save`，不可调用）。工具清单里找不到它们不是故障。

保存结果里总有**本次保存的标识**；同一项目里有相似条目时，还会附上候选与机械证据——见 §4。

## 3. topic_key：演进不覆盖

- 不同主题不得互相覆盖（architecture vs bugfix）。
- 演进中的主题**复用同一个 `topic_key`** 去更新，而不是新建观察。
- 键名拿不准时先 `mem_suggest_topic_key`，再复用。
- 有确切 observation id 要更正时用 `mem_update`。

## 4. 候选：只在那一次保存的回合里有效

保存结果里出现候选时（每条带条目标识与机械证据：共享了哪些稀有词、是否同主题键、语义名次……）：

1. **候选不会重发**。它只属于那一次保存的回合：插件不落库、不重发、不补发，下一次保存按当时的
   内容重新算。要跨回合使用，只能在对话里引用已经出现过的编号——而那几乎总是错过窗口，
   所以裁决要在**同一次回复内**做完。
2. **先读全文再判**。短标签只够让你决定要不要读：用 `mem_get_observation` 按 id 取未截断正文。
3. **用 `mem_compare` 对两个条目下判，顺序是写死的**：
   - `memory_id_a` = **本次保存的那一条**（结果里「已保存 #id」）
   - `memory_id_b` = **候选那一条**（结果里「候选 #id」）
   于是 `supersedes` 读作「本次这条取代那条」。两个标识在结果里分开写明，方向不要靠时间先后猜。
   证据里若写着「本次将更新它」，那说明本次保存的标识与那条候选**是同一个**——这一对不构成
   可写的关系，不要拿它去下判。
4. **判「无关」是空结果**：`not_conflict` 不写任何行、也不改写既有行，而且**不返回新的关系标识**。
   它恰恰是最常见的结果，不是失败——不要为了"留痕"去造一条关系。
   `compatible` / `related` / `scoped` 则是关系，照常下判。
5. **同一次回复内可撤销**：`mem_compare` 的返回值里带着刚写下那条关系的标识（`sync_id`），
   拿它调 `mem_judge`（`relation: not_conflict`）即可撤回。**旧的**关系（别处写下的、不在本次
   回复里的）没有列出来的入口，不要假装能撤。
6. **问使用者**：confidence < 0.7，或关系会是 `supersedes` / `conflicts_with` 且 type 是
   architecture / policy / decision 时——在**本次回复里**问，并把**两个标识都写进问题**
   （本次保存的那条与候选那条）。等下一回合再问就是错过窗口；错过只意味着"这一次不记"，
   下次保存近似内容时同一条还会再出现。

## 5. 检索

用户说「记住 / 回忆 / 查一下之前 / 之前怎么解决的」，或开工可能与过去重叠：

1. `mem_context` —— 最近的会话与观察（快、便宜）。
2. 不够再 `mem_bridge_recall` —— 本地派生索引的混合检索（CJK bigram 词法 + 语义向量）；
   省略 `scope` 时 project 与 personal 两种范围都可能出现。
3. 命中后 `mem_get_observation` —— 按 id 取未截断全文。

- **跨项目**：显式传 `project`。
- **索引积压**：若检索明确告知待处理量超出自动上限，用 `mem_bridge_recall_sync` 追索引
  （可能数分钟）。调用前先告诉用户要等，完成后**重新发起原来那次检索**。细则见该工具自身描述。

## 6. 交付保证

记忆操作是**内部账务**，不是给用户的回答：

- 先把该做的记忆工作做完，再用**完整回答**收尾；此后不再调用任何工具。
- 记忆工作失败或还需跟进时，**仍然给出回答**——不要让用户为了记忆而等不到回复，也不要把
  记忆操作的失败当成回答的一部分。

## 7. 会话收尾

结束会话或说「完成」之前，`mem_session_summary`：

```
## Goal
## Instructions      （发现的用户偏好 / 约束，没有就省略）
## Discoveries       （技术发现、坑、非显然之处）
## Accomplished      （完成项与关键细节）
## Next Steps
## Relevant Files    （路径 —— 做什么 / 改了什么）
```

不写，下个会话就是瞎的。
