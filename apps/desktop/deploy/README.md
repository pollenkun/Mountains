# Mac 手动安装，Windows 下载后可重启更新

Mac 目前不使用付费 Developer ID。应用会检查和下载 DMG，用户打开后手动替换应用。系统仍可能要求用户确认开发者来源。
Windows 使用 NSIS 和 electron-updater。运行中或正在等审批的任务会阻止安装。应用正常退出时也不会偷偷安装。

## Mac 下载后手动替换，首次打开可能需要确认

退出 Mountains，打开下载的 DMG，将 Mountains 拖入“应用程序”并确认替换，再重新打开。替换应用不会删除原有聊天和设置；不要删除用户目录中的 `.mountains` 数据文件夹。

本版没有 Apple Developer ID 公证。若系统提示无法验证开发者，先确认文件来自项目官方发布地址，再按 Apple 的[打开未公证应用说明](https://support.apple.com/zh-cn/102445)，进入“系统设置 → 隐私与安全性”，选择这次 Mountains 的“仍要打开”。若提示包含恶意软件或应用已损坏，先停止安装并重新核对下载文件。不要为安装本软件关闭整个系统的安全检查。

## 两个下载地址保存同一批文件

- CDN：`https://updates.cnsai.top/desktop/`
- GitHub：`https://github.com/pollenkun/Mountains/releases/download/desktop-preview/`，正式版使用 `desktop-stable`。

设置可选自动、CDN、GitHub。自动模式先 CDN，失败后换 GitHub。下载过程中换源前，必须确认备用源的版本、文件名、大小、SHA-512 全部一致。损坏或未下载完的文件不能安装。
首次启动后会检查，之后每四小时检查。只有打开“自动下载更新”才会后台下载。没有发布清单会显示“还没有发布更新”，网络错误不会显示“已是最新版本”。

## 每次发布先改真实版本号，再打包

`apps/desktop/package.json` 是桌面版本的唯一来源。Preview 2 首包是 `0.2.0-preview.2`；同属 Preview 2 的后续修订可用 `0.2.1-preview.2`。正式版用没有后缀的版本。
同一个文件名不允许对应不同内容。重新打包后要提升版本号，避免客户端下载到一半混入不同文件。

在仓库根目录运行：

```sh
npm run release:mac -w apps/desktop
node apps/desktop/scripts/release-feed.ts darwin arm64 apps/desktop/release/Mountains-0.2.0-preview.2-mac-arm64.dmg apps/desktop/release-feed apps/desktop/deploy/release-notes.md
node apps/desktop/scripts/verify-release.ts apps/desktop/release-feed apps/desktop/release
```

Windows ARM 对应 `release:windows`；Windows x64 对应 `release:windows:x64`。清单使用 `win32` 和 `.exe`。工作流 `.github/workflows/desktop-release.yml` 可分别在原生 ARM Mac、Windows ARM 和 Windows x64 上生成安装包及清单，只上传到 Actions 的构建附件，不会公开发布。

生成清单前更新 `release-notes.md`。发布检查会比较待发布目录与当前构建目录中的安装包，也会核对 Windows 的 JSON 和 YML。旧目录即使自己的校验值正确，只要与当前构建不一致，也不能作为本次发布文件。

## 公开发布时先上传安装包，最后替换清单

1. 在 GitHub 上创建预览发布 `desktop-preview` 或正式发布 `desktop-stable`。先上传安装包，再上传同目录的 JSON 和 YML。客户端读取的是这些固定发布标签下的清单。
2. 将同一批文件同步到 CDN：

```sh
node apps/desktop/scripts/publish-mirror.ts apps/desktop/release-feed
```

脚本通过现有 SSH 别名 `mindone-vps` 上传到不对外开放的暂存目录。服务器核对安装包字节后，先放安装包，再放 YML，最后替换 JSON。无需把 SSH 密钥交给客户端或写进仓库。
保持旧安装包，供尚未完成下载的客户端使用。新清单发布后再清理旧包，不要覆盖同名文件。

代理下载若提前中断，可在设置中选择另一下载地址后重试。发布前必须用同一批文件验证两个公开地址；只测本地换源逻辑，不能当成线上下载成功。不要为了更新永久改变用户的代理规则。

Mac 和 Windows 安装包按 8 MiB 分段请求，当前段失败最多尝试三次；已完成段不重下。每段核对 Content-Range 和长度，最终仍核对整包 SHA-512。服务器不支持分段时退回整包流式下载。原生更新器继续负责缓存、签名检查和安装。下载适配使用已固定版本 electron-updater 6.8.12 的运行时 httpExecutor；升级该依赖后必须重新验证实际 Windows 下载和重启安装。

## CDN 服务器只提供静态下载

网站配置在本目录。服务器根目录为 `/srv/mountains-updates`；暂存目录为 `/srv/mountains-updates-staging`，不会通过网站开放。HTTPS 证书由现有 certbot 自动续期，续期后重载 nginx。
下载并发和速度有限制，避免占满共享 VPS。流量消耗需在 VPS 服务商面板核对；本项目没有购买新的服务器或付费服务。

## 发给用户前仍要验证真实安装

测试能确认版本比较、换源、校验、运行任务时拒绝安装。它不代替 Windows 实际重启安装，也不代替另一台 Mac 的首次安装确认。
没有安装更新系统的旧包，不能靠旧界面的“检查更新”自动获得这一能力；首次迁移需手动安装本版。
