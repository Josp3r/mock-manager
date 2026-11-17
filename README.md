# Whistle Mock Manager

围绕本机 Whistle 的个人桌面 Mock 管理器。业务继续请求正式域名，由本地 Whistle 代理使用你选择的 JSON 响应。

## 打开应用

解压 `Whistle-Mock-Manager-mac-arm64.zip`，双击其中的 `Whistle Mock Manager.app`。也可以将它拖入“应用程序”。这是带本地 ad-hoc 签名的构建，未进行 Apple 开发者签名和公证；如果 macOS 阻止首次打开，可在 Finder 中按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”中允许打开。无需关闭系统安全设置。

需要 macOS Apple Silicon、已安装的 Whistle ≥ 2.10.7（命令 `w2`）。应用会检测 PATH、Homebrew、nvm 和常见安装目录；Finder 启动时找不到 w2，可在“连接设置”选择 w2 文件。

## 第一次使用

1. 在“连接设置”检测或启动 Whistle。按提示启用多选规则，以便和原有规则共存。
2. 在浏览器或系统中设置 Whistle 本地代理（通常为 `127.0.0.1:8899`）。HTTPS 接口需要在 Whistle 中开启 HTTPS 解密并安装、信任它的根证书。应用本身不更改系统代理和证书。
3. 新建项目和接口，填写真实请求 URL、HTTP 方法。默认按完整协议、域名、端口和路径精确匹配；查询参数只有配置为条件后才参与匹配。URL 中填写的查询参数会转换为条件。
4. 编辑“成功”“空数据”“报错”等响应场景，选择需要的场景并启用接口。
5. 点击“应用到 Whistle”，刷新目标页面。

界面的“已同步”表示专属规则已写入且通过读回验证，实际流量仍需经过正确代理，且可能受已有规则的优先级影响。初始示例使用 `api.example.test`，所有接口默认关闭。

## 日常管理

- **草稿与应用**：编辑自动保存为本地草稿；点击“应用到 Whistle”才改变代理响应。无效 JSON 草稿可保留，但启用该响应时应用会拒绝它。
- **项目预设**：保存一个项目内所有接口的启停和场景选择；载入预设后点击应用。
- **停止 Mock**：应用内总开关只停用自己的规则文件，不会停用其他 Whistle 规则。删除或禁用单接口后需点击应用。
- **关闭窗口**：已经应用的 Mock 继续由 Whistle 提供。退出桌面应用前如需恢复正式接口，请先停用 Mock。
- **规则冲突**：不要直接手改应用的 `MockManager-…` 规则文件。检测到外部修改会停止覆盖；可在 Whistle 中撤销外部修改，或删除该专属规则文件后重新应用。“恢复上次应用”用于修复应用自身中断的操作和恢复上次成功快照。
- **数据备份**：“连接设置 → 数据与备份”导出或导入 JSON。导入创建新项目、重新分配 ID，接口默认关闭；本机 w2 路径和应用状态不进入备份。
- **数据目录**：默认 `~/Library/Application Support/Whistle Mock Manager/`，包含 `data.json`、恢复副本和独立 JSON fixtures。“打开数据目录”可定位。请勿手动修改已应用的响应文件。

支持 HTTP 状态码 200–599、0–60,000 ms 延迟、JSON 响应体、自定义响应头，以及 Query/Header 等值条件。多个条件必须全部满足。第一版面向个人本地使用，不包含脚本执行、请求体匹配和云端同步。

## 从源码运行

推荐 Node.js 22.12+：

```sh
npm ci --legacy-peer-deps
npm run dev
```

`--legacy-peer-deps` 绕过 npm 10 处理测试工具可选 peer 依赖时的错误；依赖版本由 package-lock 固定。开发窗口和打包窗口共用相同的 preload / 主进程业务代码。

```sh
npm test
npm run typecheck
npm run build
npm run test:integration
npm run test:desktop
npm run package:mac
```

真实代理集成测试使用独立临时 Whistle 配置和本地假后端，不访问正式接口、不改用户当前实例；桌面测试也使用隔离数据目录。源码运行时，`MOCK_MANAGER_DATA_DIR=/absolute/path` 可指定独立的应用数据目录用于测试。打包应用忽略该测试变量。

技术：Electron、React、TypeScript、Vite。所有文件和 Whistle 操作在主进程完成，页面通过有限的 preload API 通信。Whistle 官方接口见 https://wproxy.org/docs/extensions/api.html。
