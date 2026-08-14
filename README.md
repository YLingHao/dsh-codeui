# Code UI (codeui)

> VSCode 风格的代码变更查看器，把 DeepSeek Harness 变成「编辑器 + 对话助手」的工作台。
> A VSCode-style code-change viewer that turns DeepSeek Harness into an IDE-like workbench.

[中文文档](#中文) · [English](#english)

---

<a id="中文"></a>
## 中文

### 简介

Code UI 是一个 DeepSeek Harness 的 **Cordis 动态插件**，把界面改造成 VSCode 式三栏工作台：

| 位置 | 内容 |
| --- | --- |
| 最左侧 | 可点击切换、弹出/隐藏的 **资源管理器**（当前工作区的文件夹/文件树） |
| 中间 | **标签式代码编辑器**：显示智能体编辑过的文件差异，**绿色 = 新增行，红色 = 删除行，灰色/黑色 = 未变更行** |
| 右侧 | **对话窗口**（右移，就像 VSCode 靠右的对话助手），左边界可拖动调整宽度 |

### 功能特性

- **资源管理器**（左侧抽屉）：浏览当前工作目录，点击文件夹展开、点击文件在中间打开为新标签页。
- **连续全文件差异**：中间面板渲染一份连续的文件视图（行号不重排），对比基准为「上一回合修改后的完整代码」——第一次新建文件时全文标绿；后续修改只把改动的行标绿/标红，其余保持灰色上下文。
- **横向标签栏**：所有打开的文件以标签横排于顶部，点击切换、点 `×` 关闭单个文件；被智能体修改的文件自动加入标签页。
- **执行中自动跳转**：任务运行期间，中间面板优先跳到「正在编辑」的文件并实时显示差异。
- **对话窗口可调宽度**：右移后的对话窗口左边界可拖动（300–520px），输入框下方状态文字自动换行为两行，权限/模型选择框在窄列下自动分行不重叠。
- **设置页**：`设置 → Code UI` 提供三个开关（显示资源管理器 / 显示代码变更面板 / 对话右移·代码居中）。
- **插件管理**：作为 Cordis 动态插件，自动出现在 `设置 → 插件` 列表中，可停用 / 更新 / 删除。

### 安装（动态插件）

在 DeepSeek Harness 中使用 `cordis_define` 新建插件：

1. `kind: "new"`，`idPrefix: "codeui"`（Host 会分配最终 id，如 `codeui-1`）。
2. `code.host` 填入 `host.js` 的内容，`code.client` 填入 `client.js` 的内容。
3. 在界面批准运行（单勾 = 本次版本，双勾 = 未来版本自动放行）。

运行后：左下角出现 📁 按钮切换资源管理器；开始会话后中间自动打开代码变更面板，对话窗口移动到最右。

### 文件结构

```
codeui/
├── package.json   # npm 元数据
├── index.js       # 包清单（说明 host/client 两半的对应关系）
├── host.js        # Host 半边：文件系统 RPC（listDir / readFile / workspaceRoot）
├── client.js      # Client 半边：资源管理器、标签式 diff 编辑器、对话右移、设置页
├── LICENSE        # MIT
└── README.md
```

`host.js` 与 `client.js` 都是纯 JavaScript 的 **Cordis "function body"** 源码（顶层 `return { ... }` 即函数体），零依赖、无 import/require/JSX/TypeScript。

### 架构说明

| 关注点 | 位置 | 依赖的接口 |
| --- | --- | --- |
| 目录列举 / 读文件 / 工作区根 | `host.js` | `fs` 服务、`sandboxPolicy.workspaceRoot`、`harness.handle` |
| diff 数据来源 | `client.js` | 会话日志中 `edit`/`write` 的调用参数（`content` / `old_string` / `new_string`），按回合重建完整文件内容后对比 |
| 资源管理器 | `client.js` | `shell.overlay`（左侧抽屉）+ `sidebar.footer.action`（切换按钮）+ `useWorkspaces` |
| 代码变更面板 | `client.js` | `details` 槽（右列，`ctx.layout.openDetails()` 自动打开）+ `useSession` |
| 对话右移 / 宽度可调 | `client.js` | CSS `order` 重排 + 保留框架自带拖拽手柄 |
| 设置页 | `client.js` | `settings.section` 槽（`id: 'codeui'`） |

### 设计取舍

- **不替换 `sidebar` 槽**：该槽内含设置面板与插件列表，替换会破坏「在设置里管理插件」的能力。资源管理器因此用 `shell.overlay` 做成加法式左侧抽屉。
- **对话右移的范围**：CSS 重排用 `:not([data-details-collapsed])` 限定，仅在「代码面板已打开（有会话）」时生效；无会话时对话保持在中间，避免空白列。
- **类名依赖**：`REORDER_CSS` 使用了当前构建 `ui-layout` 的带哈希类名（`pI_x6G_*`），这是布局重排的唯一耦合点，已隔离在 `REORDER_CSS` 常量中并可通过设置一键关闭。

### 移植为正式 Web 插件

若要脱离动态插件机制、作为常驻 Web 插件打包：把 `host.js`/`client.js` 的两个函数体分别接入 Host 与 Client 的 `apply(ctx)`，并按 `dsh.client` 的扫描/打包规则注册模块。核心逻辑（diff 重建、资源管理器、CSS 重排）无需改动。

---

<a id="english"></a>
## English

### Introduction

Code UI is a **Cordis dynamic plugin** for DeepSeek Harness that reshapes the UI into a VSCode-style three-column workbench:

| Area | Content |
| --- | --- |
| Far left | Toggleable **file explorer** (folder/file tree of the current workspace) |
| Middle | **Tabbed code editor**: shows diffs of the files the agent edited — **green = added, red = deleted, gray/black = unchanged** |
| Right | **Chat panel** (moved to the right, like VSCode's right-side assistant), with a draggable left edge |

### Features

- **File explorer** (left drawer): browse the working directory, expand folders, click a file to open it as a new tab in the middle.
- **Continuous full-file diff**: the middle panel renders ONE continuous file view (line numbers never restart). The reference is the full content after the *previous turn* — a newly created file shows all green; later edits mark only the changed lines green/red with the rest as neutral context.
- **Horizontal tab bar**: all open files are tabs at the top; click to switch, `×` to close. Files the agent edits are added automatically.
- **Auto-focus while running**: during a task the middle panel jumps to the file currently being edited and shows its diff live.
- **Resizable chat panel**: drag the chat's left edge (300–520px); the status line below the input wraps to two lines; the access-mode and model selects wrap onto separate rows so they never overlap.
- **Settings page**: `Settings → Code UI` offers three toggles (show explorer / show diff panel / move chat right).
- **Plugin management**: as a Cordis dynamic plugin it appears in `Settings → Plugins` where it can be stopped, updated, or removed.

### Installation (dynamic plugin)

In DeepSeek Harness, use `cordis_define` to create the plugin:

1. `kind: "new"` with `idPrefix: "codeui"` (the Host allocates the final id, e.g. `codeui-1`).
2. Put the contents of `host.js` into `code.host` and the contents of `client.js` into `code.client`.
3. Approve the run in the UI (single check = this version, double check = future versions auto-approved).

After activation: the 📁 button at the bottom-left toggles the explorer; starting a session opens the code panel in the middle and moves the chat to the right.

### Project structure

```
codeui/
├── package.json   # npm metadata
├── index.js       # package manifest (maps host/client halves)
├── host.js        # Host half: filesystem RPC (listDir / readFile / workspaceRoot)
├── client.js      # Client half: explorer, tabbed diff editor, chat reorder, settings
├── LICENSE        # MIT
└── README.md
```

`host.js` and `client.js` are plain-JavaScript **Cordis "function body"** sources (the top-level `return { ... }` is the function body), with zero dependencies and no import/require/JSX/TypeScript.

### Architecture

| Concern | Where | Interfaces used |
| --- | --- | --- |
| Directory listing / file read / workspace root | `host.js` | `fs` service, `sandboxPolicy.workspaceRoot`, `harness.handle` |
| Diff data | `client.js` | `edit`/`write` call arguments from the session log (`content` / `old_string` / `new_string`), replayed per turn to reconstruct full file contents |
| File explorer | `client.js` | `shell.overlay` (left drawer) + `sidebar.footer.action` (toggle) + `useWorkspaces` |
| Code-diff panel | `client.js` | `details` slot (right column, auto-opened via `ctx.layout.openDetails()`) + `useSession` |
| Chat right / resizable | `client.js` | CSS `order` reorder + the frame's built-in drag handle |
| Settings page | `client.js` | `settings.section` slot (`id: 'codeui'`) |

### Design notes

- **The `sidebar` slot is deliberately NOT replaced**: it hosts the Settings panel and the plugin list; replacing it would break plugin management. The explorer is therefore an additive left drawer via `shell.overlay`.
- **Reorder scope**: the CSS reorder is gated on `:not([data-details-collapsed])`, so it applies only when the code panel is open (a session exists); without a session the chat stays centered.
- **Hashed class dependency**: `REORDER_CSS` targets the current build's hashed `ui-layout` classes (`pI_x6G_*`) — the single coupling point of the reorder, isolated in the `REORDER_CSS` constant and disableable from Settings.

### Porting to a permanent web plugin

To ship as a permanent web plugin instead of a dynamic one, wire the two function bodies into Host and Client `apply(ctx)` and register the module following the `dsh.client` scan/bundling rules. The core logic (diff reconstruction, explorer, CSS reorder) needs no changes.

---

## License

MIT
