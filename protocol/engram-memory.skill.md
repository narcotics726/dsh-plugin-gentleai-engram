---
name: engram-memory
description: >-
  engram 持久记忆的完整流程：保存格式、topic_key、冲突判决、检索、会话收尾、排查。
  用户说「记住 / 回忆 / 查一下之前」时、写完 bug 修复或做出决定后、结束会话前加载。
  常驻的触发条件是插件自带的一段系统提示词。
version: 2
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

## 2. 保存

`mem_save`：

- **title**：动词 + 对象，短、可检索（"Fixed N+1 query in UserList"、"Chose Zustand over Redux"）。
- **type**：`bugfix` | `decision` | `architecture` | `discovery` | `pattern` | `config` | `preference`。
- **scope**：`project`（默认）| `personal`。
- **topic_key**：可选，演进中的主题建议给——见 §3。
- **content**：

  ```
  **What**: 一句话——做了什么
  **Why**: 动机（用户要求、bug、性能……）
  **Where**: 涉及的文件 / 路径
  **Learned**: 坑、边界、意外之处（没有就省略）
  ```

桥**刻意不注册**两组 engram 工具：被动捕获类，以及重复提示词写入类（`mem_save_prompt`）。
工具清单里找不到它们不是故障。

## 3. topic_key：演进不覆盖

- 不同主题不得互相覆盖（architecture vs bugfix）。
- 演进中的主题**复用同一个 `topic_key`** 去更新，而不是新建观察。
- 键名拿不准时先 `mem_suggest_topic_key`，再复用。
- 有确切 observation id 要更正时用 `mem_update`。

## 4. 冲突面：`mem_save` 返回候选时

每次 `mem_save` 后看响应里有没有 `judgment_required`。候选是**免费**给出的——照看标题，
疑似相关再去读全文。但下判时：

- **判「无冲突」时不调 `mem_judge`**。`not_conflict` 断言的是「两者无关」——否定**不是关系**。
  把「没找到关系」当成一条关系存下来，会让 `judged` 这个口径失去意义——它会退化成「默认值」，
  而不是「判过的关系」。生成器没有阈值、多数候选是噪声，所以这是常态。
  注意：`compatible` / `related` / `scoped` 同样**不产生任何注解行**，但它们是关系，照常要记——
  判据是「这是不是关系」，不是「会不会出注解」。
- **只有真关系才下判**：`related` | `compatible` | `scoped` | `supersedes` | `conflicts_with`，
  用**每个候选自己的 `judgment_id`** 各调一次 `mem_judge`。
- **问用户**：confidence < 0.7，或关系会是 `supersedes` / `conflicts_with` 且 type 是
  architecture / policy / decision。

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

