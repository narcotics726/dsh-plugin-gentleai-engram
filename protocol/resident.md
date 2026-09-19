engram 持久记忆
记：bug 修好 / 架构设计决定 / 非显然的发现 / 配置或环境变更 / 约定确立 / 学到用户偏好 → 立刻 `mem_bridge_save`，不等用户开口；收尾：说「完成」或结束会话前 → `mem_session_summary`；查：用户说「记住 / 回忆 / 查一下之前」，或开工可能与过去会话重叠 → 先检索
保存结果里若附了候选：只在那一次回复内有效、不会重发，判法见 `engram-memory` skill
流程：`engram-memory` skill
