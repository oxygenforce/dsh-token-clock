# dsh-token-usage-badge

每条回答的下方，一行淡色读数：**本轮 Token** · **回答耗时** · **本会话累计 Token**。

![预览](assets/preview.png)

```
[复制] [赞/踩] [分支] [↗]    20:10   1.1M tok · 1分02秒 · 共 26.9M tok
```

从左到右每一段：

| 片段 | 含义 |
| --- | --- |
| `20:10` | 官方结束时间（宿主自带，非本插件） |
| `1.1M tok` | 本轮 Token：这一次提问→回答的消耗 |
| `1分02秒` | 回答耗时：提问→回答落盘的墙钟时间 |
| `共 26.9M tok` | 本会话累计 Token |


- **数据来源**：本轮读数取自宿主的 `turn-tail` 节点，与官方「用量」弹窗同一口径；会话累计读 `tokenUsage` 投影，实时更新。
- **常驻可见**：官方动作行只在最后一条回答上常显，历史回答要悬停才出现；本插件仅对含读数的行解除该限制。
- **生成姿态**：回答的第一行一出现，视图就停在这一行，正文继续在下方生成、不再带着读者往下滚；读者自己滚轮 / 触摸 / 键盘滚动就把控制权交还，本轮内不再抢。回合结束后继续钉 2 秒，吸收完成时的过程折叠再放手。
- **精确分解**：鼠标悬停读数，可看到未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 其中推理的精确数字。

## 安装

**方式一：插件市场（推荐）**

插件收录到 DSH 插件市场后，在 Harness 里打开「插件市场」搜索 `dsh-token-usage-badge` 即可一键安装。

**方式二：本地目录 / Release 包**

1. 下载 [v1.0.0 的 tarball](https://github.com/oxygenforce/dsh-token-usage-badge/releases/download/v1.0.0/dsh-token-usage-badge-1.0.0.tgz) 并解压（内部是 `package/` 目录）；
2. 在 Harness 的插件管理页选择「从本地目录安装」，指向解压出来的 `package/` 目录；
3. 安装后刷新一次 Web 页面，读数即刻出现，不需要重启 `dsh web`。

> 本包同时带有 `dsh.bundle.patch` 与 `cordis.patch.yml`，两条安装路径都会按 bundle 正常启用。

## 兼容性

- 面向 `@deepseek-ai/dsh-client-ui-chat` / `dsh-client-ui-conversation` 的 `0.2.1-rc.2` 客户端契约（`conversation.chat.turnTail` 槽位、`turn-tail` 节点数据）。
- 纯客户端插件：Host 半边只做日志占位，不注册任何服务、不读写文件、不发网络请求。
- 所有样式都走 `--dsw-alias-*` 主题令牌，深浅色自动跟随；仅注入一个 `<style>` 标签与一个槽位条目。

## 实现要点

| 关注点 | 做法 |
| --- | --- |
| 放置位置 | 注册到 `conversation.chat.turnTail`（`order: -10`），用 `react-dom` portal 把读数接在官方动作行的结束时间之后；取不到动作行时原地降级渲染 |
| 分隔线定位 | `centerRule()` 在 portal 完成后实测“正文底边 → 线 → 动作行顶边”，用 `transform: translateY()` 视觉位移（不动 margin，避免流式渲染时触发滚动锚定跳动） |
| 跟随补底 | 宿主按“撑高后”的内容高度发起平滑滚动，元素塌陷后目标失效会把视图留在半空；插件只在流式期间（`[data-chat-running]` 存在）、塌陷前贴底、且不是读者主动滚动时补一次贴底（视图被钉在回答第一行时让路） |
| 生成姿态 | 回答块（`[data-chat-group-part="response"]`，且属于最大 `data-chat-turn` 那一轮）出现后，每帧把它的顶端对齐到 `[data-conversation-scroll]` 顶部（`PIN_PAD` 16px）；宿主每来一点内容贴一次底，我们写回一次，约 500ms 后宿主把这次写入判成读者移动、自己停止跟随 |
| 交还控制 | `document` capture 监听 wheel / touchstart / pointerdown / 滚动键（排除输入框），命中即本轮 `released`，不再对齐；新回合开始时重新接管 |
| 收尾 | `[data-chat-running]` 消失后再钉 `PIN_SETTLE_MS`（2s）吸收完成时的过程折叠动画，然后停掉 rAF 循环，空闲时零开销 |
| 短回答 | 目标位置超过可滚动上限时由浏览器钳到底部，等价于“本来就没动”，无需长度阈值 |
| 失败策略 | 组件内部 `try/catch`，任何异常都返回 `null`，绝不连累对话界面 |

## 许可

MIT
