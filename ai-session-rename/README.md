# AI session rename（AI 重命名会话）

为 DeepSeek Harness 的**会话「…」菜单**增加一个「AI重命名」入口（排在「重命名」之后，order 250）。
点击后**不弹任何窗口**：Host 立即根据该会话的对话内容调用一次模型，生成不超过 **12 个汉字**的标题
并直接应用；成功后会话标题随 `session/title` 事件更新。失败时只在屏幕底部显示一条可点击关闭、
6 秒自动消失的提示，不打断操作。

## 交互

1. 会话行「…」菜单 → **AI重命名**（图标为星光）。
2. 点击后菜单关闭，Host 直接生成并重命名；无需确认。
3. 成功：会话标题更新；失败：底部短暂提示失败原因。

## 实现

- **Host 半边**（`index.js` + `lib/title.js`）
  - 两步生成：注册全局命令 `ai-rename` 后，读取当前会话 → 收集 user/assistant 文本 →
    发**第一次辅助请求做会话总结**（路由优先取会话日志中的 `request/header`，否则回退默认模型）→
    再**基于总结内容发第二次辅助请求生成标题** → 规范化标题 → `ctx.sessionTitle.rename()` 落库。
    返回新标题文本给 UI。
  - 注册 Agent 工具 `ai_rename_session`（`action=summarize|generate|apply|set|current`，可选
    `session_id` 指定其它活跃会话），与命令共用 `summarizeConversation()` / `generateTitle()`，
    因此 UI 与模型走同一条操作路径；`summarize` 可直接查看会话总结。
  - 推理模型（带 `reasoningEffort` 的路由）会先用
    `ctx.llm.resolveModelInfo()` 取该路由“最小”的推理档位再发请求，并给 2048 输出预算，
    避免思考占满 token 导致标题为空。
  - 标题规范化：去掉引号/「标题：」/代码围栏/结尾标点，折叠空白，按码点截断到 12 个字符。
- **Client 半边**（`client.js`）
  - `contextMenus.register()` 注册会话菜单项（order 250，权限沿用 `session/rename`），
    `run()` 直接调用 `ctx.remote.commands.execute(sessionId, "/ai-rename")`，无对话框。
  - `contextMenu.icon` 注册本插件图标键 `ai.session-rename`。
  - `shell.overlay` 注册**仅失败时**出现的底部提示条（6 秒自动消失、点击关闭）。
  - `conversation.chat.commandview` 注册 `ai-rename` 的空渲染器，隐藏内部命令回执。

## 数据流

```
会话菜单「AI重命名」
  → ctx.remote.commands.execute(sessionId, "/ai-rename")
  → Host 命令：collectConversation → 第 1 次 llm.stream 生成会话总结
  → 第 2 次 llm.stream 基于总结生成标题 → normalizeTitle(≤12 汉字)
  → ctx.sessionTitle.rename(session, title)
  → session/title 事件 → 会话标题更新；失败时客户端显示短暂提示
```

## 验证

- `node --check index.js client.js lib/title.js` 通过。
- `node --test tests/title.test.mjs tests/generate.test.mjs`：**15/15 通过**
  （规范化、12 字截断、总结提示词、两步调用顺序、路由选择、推理档位、错误分支）。
- Client 接线测试（本地 stub）：菜单项 order/权限/图标、点击直接执行 `/ai-rename`、
  成功无提示、失败产生提示并可关闭、无任何对话框注册；zh/en 字典键集一致。
- 真实环境验证：对推理路由（`reasoningEffort` 较高的模型）调用 `ai_rename_session` 的
  `generate` 能返回有效标题（≤12 汉字）；显式 `set` 保留标题的完整长度。
- **未验证**：真实 UI 点击（无浏览器控制），Client 已由 HMR 加载新模块。

## 安装

在本机 DSH profile 安装：调用 `plugin_manager` 的 `install_bundle`，`target` 指向本目录
的绝对路径。安装结果若提示需要重启，重启 DSH；仅 Client 脚本更新时，刷新一次 Web 页面即可。
