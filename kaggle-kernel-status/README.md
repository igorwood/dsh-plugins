# Kaggle kernel status（Kaggle 内核状态）

DeepSeek Harness 插件：当智能体在本会话里调用 Kaggle 内核（`kaggle_mcp.py call kernel_*`、
`kaggle kernels ...`、`make kaggle-status` / `make kaggle-output`）时，在输入框下方的
composer dock 里显示对应内核的实时状态。

## 效果

- 位置：`conversation.composer.dock`（class `JZLxKW_dock` 容器内），注册 id
  `kaggle-kernel`、order `5`，排在既有 `activity` / `usage` 条目之后。
- 样式与同 dock 的兄弟条目一致：借用 `dsh-client-ui-chat` 里 dock 统计 pill 的
  `StatsPills` 样式（14px 图标 + 13px 次级文字、1px 8px 内边距、`--dsw-radius-sm`、
  hover/展开时 `--dsw-alias-interactive-bg-hover` 背景）与 `stat-dialog` 面板样式
  （`--dsw-specific-menu` 背景、`--dsw-radius-lg`、`--dsw-elevation-prominent` 阴影、
  16px 内边距、12px/18px 正文），无自定义卡片、无边框、无最右侧三角。
- 内容：药丸显示「Kaggle 内核 · 调用中/运行中/已完成…」；点击整枚药丸弹出详情面板
  （锚定在药丸上方、视口内夹取、点击外部或 Esc 关闭），面板内含内核标识、状态、最近操作、
  最近检查时间与新鲜度、输出文件数、失败消息、跟踪中的内核列表与数据来源提示。
- **只在调用时显示**：仅在 Kaggle 内核调用进行中（会话日志里存在未结算的 `tool/call`）时
  出现；调用返回后保留约 4 秒闪现结果，然后自动隐藏，不在 composer 里常驻占位。详情面板
  打开期间保持显示，关闭后若调用已结束则隐藏。无内核调用的会话完全不渲染。若某次调用没有
  结算（例如工具运行被中断），超过 30 分钟的 pending 记录不再让它停留。
- 读取方式不变：`useProjection('kaggleKernel')`，无内核调用时不渲染。

## 实现

- **Host 半边**（`index.js`）：注册一个纯 session projection `kaggleKernel`
  （`ctx.sessionProjections.register`），从会话事件日志里同步折叠
  `tool/call` / `tool/result` 事件。它是纯函数、不读文件/网络，对无关事件返回同一 state
  引用，state 是 `structuredClone` 安全的纯 JSON。识别命令时按 shell 段落的「命令词」判定，
  因此 `grep`/`echo`/`cat` 里出现的字符串不会被误判。状态只来自日志，可随 fork/回放重建。
- **Client 半边**（`client.js`）：在 `conversation.composer.dock` 注册 React 组件，用
  slot 标准 prop `useProjection('kaggleKernel')` 读取投影的 wire view；字典通过
  `ctx.locale.register` 注册（zh + en），样式只使用 `--dsw-alias-*` 主题 token，
  不导入任何 Harness Client 包。

## 数据流

```
bash 工具调用（kaggle_mcp.py / kaggle CLI / make）
  → 会话事件 tool/call、tool/result
  → Host projection kaggleKernel（纯折叠）
  → wire view（每会话）
  → composer dock 里的状态条（useProjection）
```

## 验证

- `node --check index.js`、`node --check client.js` 通过。
- `node --test tests/fold.test.mjs`：15/15 通过（Node v26 不接受裸目录参数，需指定文件或 glob）。
- 真实会话事件折叠：用录制的会话日志回放验证折叠结果（内核标识、`phase` 等字段），
  并与 Host 持久化投影缓存（`$DSH_HOME/storages/session_projcache`）中的
  `kaggleKernel` 行一致。
- 已安装后：`conversation.composer.dock` 占用者包含 `kaggle-kernel`（active，order 5）。
- 未验证：实际像素/浅色主题外观（当前环境没有浏览器控制），需在页面上目视确认。

## 安装

在本机 DSH profile 安装：调用 `plugin_manager` 的 `install_bundle`，`target` 指向本目录
的绝对路径。安装结果若提示需要重启，重启 DSH；仅 Client 脚本更新时，刷新一次 Web 页面即可。
