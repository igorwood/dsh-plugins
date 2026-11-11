# dsh-plugins

DeepSeek Harness 本地插件集合，每个子目录是一个独立的 bundle（未发布到 npm，通过插件管理器
从本地目录安装）：

| 插件 | 作用 |
| --- | --- |
| [kaggle-kernel-status](./kaggle-kernel-status) | 调用 Kaggle 内核时，在 composer dock 里显示内核状态；只在调用期间出现，返回后闪现结果即隐藏。 |
| [ai-session-rename](./ai-session-rename) | 会话「…」菜单新增「AI重命名」：按对话内容用模型生成不超过 12 个汉字的标题并直接改名，无弹窗。 |

## 安装

1. 在 Harness 中调用 `plugin_manager` 的 `install_bundle`，`target` 填某个子目录的**绝对路径**，
   例如 `/path/to/dsh-plugins/kaggle-kernel-status`；两个插件分别安装一次。
2. 安装结果若提示需要重启，重启 DeepSeek Harness；仅 Client 脚本更新时，刷新一次 Web 页面
   即可加载新模块。
3. 安装后可在 Plugins 设置中看到各插件的中英文标题与图标。

每个子目录都有自己的 `README.md`，包含功能、实现、数据流与验证细节。

## 兼容性

在 DeepSeek Harness `0.2.2-rc.1`（desktop profile）上开发与验证。插件只使用公开的 Cordis
插件机制、Host Service 与 Web Client slot 接口；Harness 升级后如有接口变化可能需要适配。

## 隐私

仓库中的示例已脱敏：Kaggle 用户名、内核名、本机路径与模型输出均替换为示例值
（`example-user`、`example-kernel`、`/home/user/...`）。插件本身不包含任何凭据或令牌。

## 许可证

仓库未附带许可证；如需对外复用，请自行添加（例如 MIT）。
