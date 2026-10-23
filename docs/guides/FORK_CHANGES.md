# 本 fork 的改动（`local` 分支）

> 基线：`main` = 上游 `v0.2.1-r1`（DSH 0.2.1-rc.2 适配）。本分支在它之上做了一组**行为层**改动，
> 不改变桥接与 DSH 的协议，也不改 QQ 侧权限边界（见 `RULES.md`）。
> 合并上游时，先 `git merge origin/main`，冲突处优先取上游；本文件列出的开关与文案是本 fork 自己的。

## 加进来的东西

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 三态唤醒（活跃 / 过渡 / 静默） | 桥接内置 | `mode: active` 在上游是**无限期**的，没有"活跃几分钟自动收回"。这里用 `burstUntil / transitionUntil` 时间戳做滑动窗口：被 @ / 叫名字 / 关键词 / 提问 → 活跃 3 分钟（30% 接话）→ 过渡 30 分钟（10%）→ 静默（普通消息不醒）。窗口随会话状态持久化，对方说"晚安/下了/拜拜"时立刻清零。 |
| 按会话配置 | 控制台「按会话配置」 | `config.socialV2.conversations.<key>` 覆盖全局的 `burst / contextGuard / send / wake / ownerPing / peakPolicy`；section 整体覆盖、section 内再合并。写盘走 `atomicWriteJson`。 |
| 定时调度器 | `scripts/scheduler.mjs`（`start.bat` 拉起） | 独立进程，不碰桥接内部状态，只用控制台 API。① 峰谷切人格（高峰用短人格卡）；② 每天在空闲时段抽点「搬屎」；③ 每天抽点主动开口（按概率，没掷中不产生任何回合）；④ 上下文守护（超阈值重置 DSH 会话）。用 3199 端口做单实例锁，日志 `scheduler.log`。 |
| 只读 B站 MCP | `src/mcp-bili.js`（`setup-dsh.mjs` 挂载） | `bili_popular / bili_video / bili_danmaku / bili_cover`。弹幕接口是 deflate，`web_fetch` 解不了，所以单独一个 MCP；出站全部走 `safe-fetch`，封面只允许 `hdslb.com`。 |
| 关注词 @ 管理员 | `socialV2.ownerPing` | 纯字符串匹配、零 token。只在关键词所在句子是**问句/质疑**时才 @（`requireQuestion`），有冷却，发送走和模型同一条管线（限频 + 记录），不是裸 fetch。 |
| 管理员跨群委托 | `socialV2.ownerDelegate` | 让 owner 私聊的会话令牌可以发到白名单群（令牌本身是绑定单会话的）。**默认关闭**。 |
| 关闭 replyCheck | `socialV2.autoReplyCheckMs <= 0` | 每说一句就无条件唤醒一次的定时器，和三态窗口重复；置 0 即不再安排。 |

## 两个行为开关（默认值与上游不同）

```jsonc
"socialV2": {
  "wake": {
    // false = 收尾不强制"沉睡前观察"：模型直接 mark_read / set_wake_config，靠桥接唤醒。
    // 关掉时桥接的 mark_read/set_wake_config 闸门、唤醒提示词、MCP 工具描述会一起改口。
    "preSleepWaitEnabled": false,
    "preSleepWaitMs": 10000
  },
  "ownerDelegate": { "enabled": true }   // 只在需要"私聊指挥它去群里说话"时开
}
```

`preSleepWaitEnabled: false` 是本 fork 的默认：上游要求模型在潜水前用
`qq_wait_for_messages(timeoutMs=300000)` 守满 5 分钟，在活跃群里会表现为"半天不回、回来一串"。
关掉后由三态窗口控制接话节奏，等待工具只保留"首答前短确认"这一种用法（≤8 秒）。

## 与上游契约的偏离点（合并时注意）

1. **preset 的收尾文案**：`dsh/agent-presets/qq-chat-v2` 里【等、回与收尾】一段是本 fork 重写的，
   没有 5 分钟观察；`scripts/test-qq-preset-contract.mjs` 已同步改断言。上游再改这段会冲突。
2. **工具结果裁剪**：`tool-result-pruner` 从 `50000/45000/2000` 调到 `8000/6000/1000`
   （QQ 会话里 `bili_*` / `qq_get_*` 的大段 JSON 会被每步重发）。
3. **`{{cwd}}`**：persona 的 `suffix` 整条删除（上游 v0.2.1-r1 的同一处修复），不要再加回来。
4. **新增 MCP**：`setup-dsh.mjs` 的 `MANAGED_MCP_IDS` 含 `mcp-bili`；该区块会被整体重写，
   手工加在企业微信 profile 里的条目会被覆盖。
5. **高峰时段策略是软约束**：只在群聊唤醒提示词里加一段"别用外部工具"，桥接不拦工具调用；
   控制台标注为"提示"。要硬拦截请在 `qq-tool-restrict.mjs` 或 MCP 挂载层做。

## 回归测试

```powershell
npm run test:token      # 预设契约 + 等待/令牌经济
npm run test:bili       # bili-core 的离线单测（不联网）
npm run test:setup-idempotent   # 四个 MCP 条目各写一次
```

## 运维备忘

- 调度器：`stop-scheduler.bat` 按 3199 端口停（精确匹配 `:3199 `，不会误杀 `:31990`）；
  `scheduler.log` 在仓库根目录；改配置后**下一轮心跳（≤60 秒）**生效，不需要重启桥接。
- 上下文守护会**静默重置 DSH 会话**（默认 5 万 token）：重要信息要靠 `qq_memory_append` 存，
  重置只影响对话上下文，不影响 `state/social-v2.json` 里的唤醒配置与记忆。
- 桥接重启后 `config.json` 的 `ownerDelegate` 等新键才生效（配置在启动时读入）。
