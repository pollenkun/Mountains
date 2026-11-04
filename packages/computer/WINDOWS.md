# Computer-use Windows 版：设计

2026-10-22 晚更新：第 3 步的见证应用、离线构建脚本和桌面验收脚本已经补齐，尚未在 Windows 桌面执行。测试会独立读取应用状态、记录前台变化，并检查拒绝的按键没有发送。准备完成不等于语义操作已实测通过；第 4–6 步仍未完成。

目标：Windows 上的 `screen_read` / `screen_look` / `screen_act` 和网页工具，用起来和 Mac 版一样——默认在后台操作，不抢前台，删除、发送、付款之类由模型先问用户。
测试环境：外接盘上的 Windows 11 ARM 虚拟机（UTM）。还要在 x64 Windows 上补测一次，ARM 版 Windows 跑 x64 程序靠转译。

## 架构：只换 `Desktop` 实现

- `src/tools.ts`、`src/snapshot.ts`、`src/state.ts`、协调器、密码、操作记录都和平台无关，不改。
- Mac 的平台代码都在 `Desktop` 接口后面（`src/backend.ts` 的 `xa11yDesktop`，加上 `native/*.swift` 的辅助程序）。Windows 新写一个 `windowsDesktop()`，实现同一个接口。
- 读控件树：继续用 xa11y。它在 Windows 上走 UI Automation，发布了 win32-x64 和 win32-arm64 的预编译包，接口和 Mac 上一样（读树、按下、切换、展开、设值、输入、事件订阅）。
  **第一步先验证它在 Windows 上的角色名、动作名、窗口编号，是否和 Mac 上一致。**
- xa11y 覆盖不到的部分写成一个辅助程序 `native/windows-helper/Program.cs`：
  - 用 C# 写，目标框架 .NET Framework 4.8；Windows 11 自带这个运行时，ARM64 版也有。
  - 编译成 AnyCPU 的单个 exe，在 Mac 上用 dotnet SDK 加 `Microsoft.NETFramework.ReferenceAssemblies` 预编译。
  - 和 Mac 一样：运行时核对源码和程序的校验值，通信用每行一个 JSON。
  - 不用运行时 `Add-Type` 编译，那样每次启动要多花几秒，还要 PowerShell。

## Mac 做法对应到 Windows

| 能力 | Mac 现在的做法 | Windows 做法 | 后台、不抢前台？ |
|---|---|---|---|
| 读窗口和控件 | xa11y（AX） | xa11y（UIA） | 是 |
| 按下、勾选、展开、选中 | AX 动作 | UIA 的 Invoke / Toggle / ExpandCollapse / SelectionItem 模式 | 是。这是 Windows 的优势，大部分控件不需要焦点 |
| 填文字 | AX 设值；不行再发键盘事件 | 普通输入框用 ValuePattern.SetValue；富文本和终端向焦点子窗口 PostMessage(WM_CHAR) | 设值：是。WM_CHAR：多数 Win32 应用可以，结果一律读回确认 |
| 按键 | 焦点记录加 CGEventPostToPid | 向目标窗口 PostMessage(WM_KEYDOWN/UP)；SendInput 只在用户授权前台操作时用 | PostMessage 对部分应用无效（UWP、某些 Chromium 版本），读不回效果就报"未确认" |
| 指针点击 | CGEventPostToPid | 优先用 UIA Invoke；没有的话向子窗口 PostMessage(WM_LBUTTONDOWN/UP)，坐标是窗口内坐标 | 和 Mac 一样，无效就明确报错 |
| 被挡住的窗口截图 | WindowServer 硬件截图，退回录屏流 | Windows.Graphics.Capture 单窗口截图（Win11 能关掉黄框）；退回 PrintWindow(PW_RENDERFULLCONTENT) | 是 |
| 应用菜单 | AX 菜单栏 | UIA 的 MenuBar / MenuItem（Win32 菜单和功能区都暴露给 UIA） | 是 |
| 系统下拉框 | 窗口服务打开菜单后归还键盘 | UIA 的 ExpandCollapse 加 SelectionItem | 大多是 |
| 状态栏图标 | AXExtrasMenuBar | 通知区域（任务栏 UIA 树和溢出面板） | 优先级低，放最后 |
| 最小化窗口、恢复 | AX 加窗口服务 | `ShowWindowAsync(SW_SHOWNOACTIVATE)` | 是 |
| 别的虚拟桌面 | 只能看，不能操作 | 用 IVirtualDesktopManager 判断窗口在哪个桌面；UIA 通常仍能读和操作 | 要实测 |
| 启动应用不抢前台 | `launch-app`（NSWorkspace 不激活，加还回前台） | CreateProcess 加 `STARTUPINFO.wShowWindow = SW_SHOWNOACTIVATE`。Windows 的前台锁本来就拦后台进程抢前台，再加一样的观察和还回 | 要实测，应用自己可能调用 SetForegroundWindow |
| 前台被抢的检测 | 焦点监视和见证应用 | 辅助程序里用 SetWinEventHook 监听 EVENT_SYSTEM_FOREGROUND 和 EVENT_OBJECT_FOCUS；用户输入看 GetLastInputInfo | — |
| 剪贴板 | NSPasteboard，用完恢复 | OpenClipboard / SetClipboardData，含 HTML Format，用完恢复 | 是 |
| 文件对话框 | 窗口服务填文件名；完整路径拒绝 | 通用文件对话框是进程内 UIA：文件名框（AutomationId 1148）可以直接填完整路径，"保存"按钮是 AutomationId 1 | 是。比 Mac 简单 |
| 保存的密码 | 钥匙串 | Windows 凭据管理器（CredRead），目标名 `Mountains secret:<名字>` | — |
| 网页工具 | 自己的 Chrome，CDP | 一样。再加 Windows 的 Chrome 和 Edge 路径、配置目录，启动参数 `--no-startup-window` | 要实测 |
| 光标提示 | 置顶透明窗口 | 置顶分层窗口，加 WS_EX_TRANSPARENT 和 WS_EX_NOACTIVATE | 是 |
| 权限 | 辅助功能、屏幕录制（TCC） | 不需要授权。但 UIPI 不让普通进程操作管理员权限的窗口，遇到要明确报"对方是管理员窗口" | — |

## 分步（每步交给 Codex，Claude 审查）

1. **环境和测试**（进行中）：搭 Windows 11 ARM 虚拟机，开 SSH，跑 Mac 上跳过的 8 项 Windows 测试和完整检查。见外接盘上的 `给Codex的交接-3-Windows.md`。
2. **只读**：`windowsDesktop()` 实现 apps、windows、读树、窗口截图。`screen_read` 和 `screen_look` 在记事本、设置、文件资源管理器上能用。核对 xa11y 的角色和动作名。用假桌面写单元测试。
3. **语义操作**（已写完，只有单元测试，见文末）：UIA 模式的按下、勾选、展开、选中、设值；前台和焦点监视；不激活启动。见证应用用 WinForms 写在 `test/fixtures/` 里，和 Mac 的 `beta1-apps.swift` 对应。
4. **键盘和指针**：PostMessage 路径，结果如实报告；剪贴板；文件对话框；菜单和下拉框。
5. **网页和 Electron**：Windows 版 Chrome/Edge 的网页工具；VS Code 之类的 Electron 应用；凭据管理器里的密码。
6. **真机验收**：写 `test/windows-live.ts`，对标 `beta1-live.ts`，量读取速度、截图速度、前台被抢次数、各项操作的结果。

## 先要弄清的未知

- xa11y 的 Windows 版有多成熟：角色和动作的对应、大窗口的读取速度、窗口编号能否对上 HWND。第 2 步开头就验证。
- Chromium 和 Electron 窗口在后台收不收 PostMessage 发的鼠标和键盘消息；Mac 上 Chrome 155 就会丢弃后台的第一次鼠标按下。
- UWP 和 WinUI 应用（设置、计算器等）对 UIA 模式的支持程度。
- 应用启动时自己调 SetForegroundWindow 抢前台，在前台锁之下会不会成功。
- ARM64 虚拟机和 x64 真机行为是否一致，特别是辅助程序跑在转译下的情况。

## 取样结果（2026-10-22，Windows 11 ARM 虚拟机，xa11y 0.15.2，在用户桌面会话里跑）

SSH 跑在服务会话（会话 0），看不到桌面窗口。取样要用"交互式登录"的计划任务放进用户会话（这里是会话 3）里执行。以后的真机验收也要这样跑。

**读取（xa11y / UIA）**
- 角色名和动作名和 Mac 上一致（press、set_value、expand、collapse、toggle、select、focus 等），snapshot.ts 的规则可以直接用。
- 窗口编号就是真实 HWND，放在 stableId 里，格式是 `hwnd:0x10548`，不用猜。
- 速度：记事本 66 个元素读 71 ms，文件资源管理器 235 个元素读 243 ms。
- 新版记事本的正文是 UIA 的 Document 类型，xa11y 叫它 `web_area`。Windows 适配层要把非浏览器应用里的它改叫 `text_area`，否则会被当成网页。
- **"设置""计算器"这类 UWP 应用**：应用列表里只有外框进程 `ApplicationFrameHost`，读到的只有标题栏按钮。原因不在读取方法：这台虚拟机里两者都一直停在启动画面（屏幕上只有图标），重开也一样，没有内容可读。UWP 能不能读，要到能正常打开它们的 x64 Windows 上再测。

**截图（PrintWindow，带 PW_RENDERFULLCONTENT）**
- 文件资源管理器、设置：内容完整，窗口被别的窗口盖住时也完整，每张 0.2–0.4 s。
- 新版记事本：只拍到标题栏按钮和空白的正文区；标签栏和菜单栏这些新式合成渲染的部分拍不到。
- 结论：Windows.Graphics.Capture 要做主截图方式，PrintWindow 只当后备。不能用整屏截图冒充单窗口截图。

## 第 2 步（只读）完成情况（2026-10-22，同一台虚拟机，在用户桌面会话里跑真实工具）

- `windowsDesktop()`（`src/backend-windows.ts`）：应用和控件树用 xa11y；窗口编号取 stableId 里的 HWND；进程启动时间、窗口归属和位置、单窗口截图走辅助程序。`src/platform.ts` 按平台选 Mac 或 Windows 版，`screen_read`、`screen_look` 不用改。
- 辅助程序 `native/windows-helper/`（C#，.NET Framework 4.8，AnyCPU）：`npm run build:computer:windows` 在 Mac 上编译，两次编译逐字节相同；产物 `native/win-anycpu/mountains-windows-helper.exe`（17 KB，单个文件）和校验清单。运行时核对源码、项目文件和程序的校验值，对不上就拒绝启动。
- 只读：`Desktop.readOnly`（第 3 步起换成 `Desktop.inputs`，见下）。`screen_act` 一律返回 `not_executed`，什么都不发；不启动应用；读菜单报"Windows 上暂不支持"。
- 记事本的正文（UIA Document，xa11y 叫 `web_area`）能设值时改叫 `text_area`；网页里的只读 Document 仍是 `web_area`。
- 坐标：辅助程序用物理像素，xa11y 用 Node 进程拿到的坐标；用窗口宽度算出比例换算，Node 不感知 DPI、屏幕缩放不是 100% 时也对得上（单元测试覆盖 150%）。截图对应窗口的可见边框（不含看不见的缩放边）。
- 实测：
  - 记事本：读出 47 个编号元素，正文 `text_area` 带文件内容（含中文）；读 100 ms，再读一次只报变化 84 ms；截图 750×515，0.45–0.54 s。
  - 记事本被"设置"窗口完全盖住时截图仍完整，编号框和控件对齐（对比了整屏截图）。
  - 文件资源管理器：三个进程的窗口都能读，220–270 ms；截图 1024×720，0.45–0.74 s。
  - 前台窗口前后不变；`screen_act` 返回 `not_executed`。
  - 第一次列应用约 1–2.4 s（加载 xa11y、启动辅助程序），之后约 0.1 s 量级。
- 没做和没验证：UWP（见上）；多显示器和非 100% 缩放没在真机上试；x64 Windows 没测；应用名还是进程名（`explorer` 有几个进程时要用 pid 选）；不列已安装应用。

## 第 3 步（语义操作）完成情况（2026-10-22，只有单元测试，还没在真机上试）

`screen_act` 在 Windows 上只做 UIA 模式的操作：不要键盘、不要鼠标、不动前台。其余一律在发出任何东西之前拒绝。

- 能做：
  - press（Invoke）、toggle、expand、collapse、select（SelectionItem）、set_value（ValuePattern）、increment 和 decrement（RangeValue）、scroll_to_visible（ScrollItem）。
  - click 只在元素有 press 时可用，等于 press。
  - 按文字选下拉框，只在下拉框本身有 press 时可用。
- 拒绝（返回 `not_executed`、`dispatched: false`，什么都不发，也不弹审批；消息里写明哪些能用）：
  - 鼠标：双击、右键、悬停、拖动、滚动，带坐标、带修饰键或指定 pointer 的 click，以及没有 press 的元素上的 click。不会退回成鼠标事件。
  - 键盘和剪贴板：key、type、paste（包括 `text`、`typeAtFocus`）。
  - 前台和窗口：bring_to_front、focus（UIA SetFocus 可能激活窗口）、unminimize、启动应用。
  - 其他：菜单（pressMenu）、菜单栏图标、文件框、select_text、perform。
  - 一批 `steps` 里只要有一步在此列，整批不执行，前面的步骤也不跑。
- 能力开关：`Desktop.readOnly` 去掉，换成 `Desktop.inputs`。Windows 是 `"semantic"`，不写就是全部，Mac 的行为不变。拒绝放在 `screen_act` 入口（`semanticRefusal`），指针、下拉框和 `set_value` 的深处还各有一道，不会退回到鼠标或键盘。
- 前台检查：`beginInput` 和 `endInput` 用辅助程序新增的两个只读操作。
  - `foreground`：前台窗口的句柄和进程。`last_input`：GetLastInputInfo 的 tick。
  - 前台窗口变了：`frontChanged`，带原因。用户输入的 tick 变了而且目标应用是前台（动作开始或结束时）：`byUser`，原因是 `userInterventionReason`。其余：`unchanged: true`。
  - 用户在别的应用里用键盘鼠标不算打断，和 Mac 一样。tick 每 49 天回绕，只比相等。读不到前台就让动作失败，不当作没变。
  - 辅助程序仍然不发输入、不激活任何窗口；重新编译，两次编译逐字节相同。
- xa11y 的 Windows 动作：看了它的 GitHub 源码（不是 0.15.2 的二进制，Mac 上装不了）。press 依次试 Invoke、Toggle、SelectionItem、ExpandCollapse；set_value 是 ValuePattern.SetValue；increment 和 decrement 是 RangeValue 读当前值再加减一步；scroll_to_visible 是 ScrollItem。动作路径里没有 SendInput、PostMessage、剪贴板。
- 还没验证（真机上要测）：
  - Invoke 打开模态对话框时，UIA 调用可能一直不返回。
  - press 在没有 Invoke 时会退而 Toggle、Select 或 Expand，可能做出和"按下"不完全一样的事。
  - 用户输入检测的灵敏度：鼠标只是移动也算输入，目标应用在前台时会让动作报"用户改了它"。
  - 前台检测只比较前台窗口，不看窗口里的键盘焦点（`focusChanged` 恒为 false）。
  - UWP（见上）。
