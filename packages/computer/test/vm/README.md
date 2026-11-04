# 在 macOS 虚拟机里跑真机检查（Lume），以及 cua-bench

目的：真机检查不再碰你的桌面、你的 iCloud，也不受锁屏影响，可以整晚跑。
状态（2026-10-22）：Lume 和测试虚拟机已经建立，macOS 26、15、14、13 均有运行记录。下面的安装步骤保留作重建说明，不要因此重复下载。cua-bench 仍未执行，且不在本轮范围内。

macOS 14 的原生七项与 Chrome 检查已通过，但 Electron 未执行，整轮不能记为全通过。macOS 13 的单元测试已运行；xa11y 0.15.2 因引用 macOS 14 才有的类而无法加载，所以桌面专项测试没有开始。画布坐标修复仍待旧系统复测。

当前先迁移测试磁盘到 P40。迁移、校验和旧盘弹出完成后，才能从新盘继续启动测试。一次只开一台虚拟机，Windows 也计入。

## 要下载和安装的东西

| 东西 | 来源 | 大小（约） | 说明 |
|---|---|---|---|
| Lume | trycua/cua（MIT），官方安装脚本 `curl -fsSL https://cua.ai/lume/install.sh` | 几十 MB | 用 Apple 自带的虚拟化框架跑 macOS 虚拟机；需要约 8 GB 空闲内存 |
| macOS 恢复镜像（IPSW） | Apple 官方 | 15–20 GB | 建虚拟机用一次，之后可删 |
| 虚拟机磁盘 | 本机 | 官方要求约 50 GB，建议留 60 GB | 放系统、Xcode 命令行工具、Chrome、Mountains |

Lume 默认开启匿名使用统计，安装后先运行 `lume config telemetry disable`。

## 步骤

1. 安装 Lume，关掉使用统计。
2. 下载与本机同版本的 IPSW，建虚拟机：
   `lume create mountains-beta1 --ipsw latest --unattended tahoe`（`latest` 会自动下载；已有镜像就传它的路径）
   （tahoe 预设会建 `lume` 用户、打开 SSH、自动登录、关闭睡眠和锁屏。）
3. `lume run mountains-beta1`，在虚拟机窗口里：
   - 给"终端"打开辅助功能和屏幕录制权限（虚拟机自己的系统设置，不是你的）；
   - 装 Xcode 命令行工具、Node 22、Google Chrome。
4. 把这个工作区复制进虚拟机（`scp -r` 或共享文件夹），运行：
   `MOUNTAINS_BETA1_LIVE=1 node packages/computer/test/beta1-live.ts`
5. 备忘录、日历、提醒事项那几项：虚拟机里没有登录 iCloud，数据只在本地，跑完整个虚拟机可以丢掉。

## cua-bench

cua-bench 的任务在它自己的沙箱里跑，给 Agent 用的是 cua-driver 的工具，不是 Mountains 的。
要用它测 Mountains，需要让 Mountains 跑在它的 macOS 沙箱里，而那个沙箱就是 Lume 虚拟机。
所以顺序是：先完成上面的虚拟机，再在虚拟机里装 cua-bench（Python 包），把 Mountains 作为
"coding-agent harness" 接进去（cua-bench 的 `--agent harness` 支持 Claude Code、Codex 这类命令行 Agent）。
