# Lite — 微内核编辑器原型

Rust + Tauri v2 内核，所有功能都是 `plugins/` 下的插件。禁用全部插件，打开就只剩标题栏（项目切换、窗口控制，属于内核）和一个背景。

## 运行

```bash
cargo run --manifest-path src-tauri/Cargo.toml
```

改了带 `src/` 目录的插件（editor、lang-*）或升级文件图标包（material-icon-theme）之后需要重新构建（只在开发时需要 Node，构建产物已提交，运行时不需要）：

```bash
cd tools && npm install && npm run build
```

## 结构

```
src-tauri/   Rust 内核：发现插件、lite-plugin:// 协议提供插件文件、保存状态、每个窗口绑定一个工作区、
             fs 原语（限定在工作区内）、伪终端 PTY（pty.rs：系统默认 Shell、工作区目录、随窗口关闭）、
             运行 git（工作区目录、不弹窗不提示输入）、用系统浏览器打开 http(s) 链接、
             开新窗口、最小化时让 WebView2 归还内存
tools/       开发期构建（esbuild）：共享模块 + 插件 src/ 打包
  shared/context-menu.js  右键菜单的共享源码：不是插件也不是服务，构建时给每个用到的插件各打一份，
                          运行时各插件自管自己的菜单、互不依赖
ui/          UI 内核：插件加载（依赖排序 + 激活超时）、命令、快捷键、事件、slot、service、权限
  titlebar.js       内核的标题栏：Logo（About）、项目切换菜单（打开/新窗口/关闭/最近）、窗口控制；
                    插件只往里加东西："titlebar.center" slot（命令面板的搜索框）和 ctx.titlebar.addButton
  shell.js          内核自己的 UI：Logo 水印背景（点击打开 About）、About、语言选择
  plugin-manager.js 内置插件管理（不是插件，不能被禁用）：列表（悬停快捷启用/禁用、右键菜单）+ 详情页
                    （启用/禁用、依赖与被依赖、权限说明、贡献的命令/服务/挂载点）、联动确认依赖、加载失败提示；
                    有工作台时列表在侧边栏、详情是编辑器标签页，否则 Ctrl+Shift+, 打开左右两栏的独立面板
                    （内核不提供右键菜单，只负责屏蔽 WebView 自带的那个：Rust 侧 WebView2 设置 + 页面一行拦截）
plugins/
  icons/            图标主题（本地内置，离线可用），提供 `icons` service：界面图标用 Lucide（ISC，v1.69.0）；
                    文件/文件夹图标用 Material Icon Theme（MIT，v5.40.0，按 VS Code 规则匹配文件名/扩展名/文件夹名，
                    file-icons.json + file-icons/*.svg 由 tools/build.mjs 生成），资源管理器、编辑器标签、Git 都在用
  workbench/        布局（顶栏/活动栏/侧栏/主区/底部面板/状态栏），定义 slot 和 `workbench` service；
                    底部面板可拖动调高度（记住高度），showPanel/hidePanel/togglePanel，
                    setPanelMaximized/togglePanelMaximized（面板盖住编辑区，隐藏后再打开仍保持最大化）
  terminal/         集成终端（xterm.js，首次打开才加载）：Ctrl+` 切换、Ctrl+Shift+` 新建，多终端，
                    面板标题栏「最大化面板」按钮（或命令「终端: 切换最大化面板」）让终端盖住整个编辑区，再点还原；
                    Ctrl+C 有选区时复制否则中断、Ctrl+V 粘贴；普通 Ctrl+字母 交给 Shell，其他应用快捷键照常生效
  git/              源代码管理 + 仓库洞察（合并自 git-insight）。侧栏 Ctrl+Shift+G：暂存/取消暂存/放弃（未跟踪文件进回收站）、
                    Ctrl+Enter 提交（没暂存时可一键全部暂存并提交）、分支切换/新建、拉取/推送/同步/发布分支，活动栏角标；
                    状态栏显示分支和同步；点文件打开左右对比的差异标签（@codemirror/merge，首次打开才加载）；
                    「图形」分区：HEAD 及其上游的提交图（分支线、合并、分支/远程/标签徽标），点提交展开改动文件、
                    点文件看该提交的差异，右键复制 ID/消息、从此处建分支；
                    「Git 概览」标签：分支/最近提交/远程（点开浏览器）、KPI、7/28/90 天提交活跃度、语言占比条、
                    语言/最大文件列表（git grep 统计行数，可切换是否遵循 .gitignore）。
                    改动工作区文件的操作（放弃、切换分支、拉取）后发出 file.changed，编辑器重载没有未保存修改的标签
  command-palette/  Ctrl+Shift+P / F1
  explorer/         工作区文件树：右键菜单（新建文件/文件夹、重命名 F2、删除到回收站、复制路径、在系统文件管理器中显示），
                    单击预览（焦点留在树上）、双击/回车进入编辑器；发出 file.open / file.renamed / file.deleted
  editor/           代码编辑器（CodeMirror 6）：多标签（右键菜单、中键关闭）、搜索、多光标、折叠……；
                    提供 `editor` service（语言注册、openPage 打开非文本标签页、viewerExtensions/languageFor
                    给只读查看器用同样的外观和高亮）；保存后发出 file.saved，收到 file.changed 重载未修改的文件；
                    和共享模块 @codemirror/* @lezer/*（vendor/，由 tools/build.mjs 生成）
  lang-javascript/  JS / JSX / TS / TSX      lang-rust/  Rust      lang-python/  Python
  lang-json/        JSON                     lang-css/   CSS       lang-html/    HTML
  lang-markdown/    Markdown（围栏代码块用其他已安装的语言插件高亮）
  keyboard-shortcuts/ 快捷键编辑器（Ctrl+,）：改绑/移除/重置，标出被其他程序占用和内部冲突的快捷键
  theme-editor/     自定义颜色主题：编辑器标签里逐项改颜色（取色器或任意 CSS 值）、实时预览、保存、导出/导入 JSON
  state.json        已禁用插件、最近项目、语言、颜色主题和自定义主题（自动生成，删掉即重置）
```

## 工作区（项目）

- 一个窗口对应一个文件夹。`?folder=<路径>` 打开指定文件夹；不带参数的主窗口会恢复上次打开的项目。
- 切换文件夹会重载窗口，插件不需要处理"工作区变了"的情况。
- `fs` 权限只能访问当前窗口的工作区，由 Rust 侧校验（`..` 穿越、其他窗口的目录都会被拒绝）。

## 标题栏

标题栏属于内核（项目/文件夹本来就是内核的概念）：Logo、项目切换、窗口控制总在，禁用任何插件都不会让它消失或变形。窗口始终无边框，插件全部激活后才显示，不会闪。

插件能做的只有往里加：

- `ctx.slots.contribute("titlebar.center", el => …)`：中间区域（命令面板放搜索框）。
- `ctx.titlebar.addButton({ id, icon, title, command })`：右侧图标按钮，`icon` 是插件自己创建的元素（通常来自 `icons` 服务），提示里自动带上命令当前的快捷键。

## 快捷键

- 插件用 `bind()` 声明默认值；用户在 Keyboard Shortcuts 里改的绑定按命令存进 `state.json` 的 `keybindings`（`[]` 表示解绑），优先于默认值。
- 匹配按物理按键（`e.code`），所以 `Ctrl+Shift+,` 不会变成 `<`。
- Windows 上会检测快捷键是否被其他程序注册成了全局热键（这种按键根本到不了窗口）。只能检测 `RegisterHotKey` 方式注册的，用底层键盘钩子的程序检测不到。
- 默认值避开了 `Ctrl+Alt+字母`：在很多欧洲键盘布局里 Ctrl+Alt 等于 AltGr，用来输入字符。

## 颜色主题

- 内置「深色」「浅色」（`ui/themes/*.json`），另有「自动」跟随系统深浅色；默认深色。从 About（点 Logo）→「更改主题…」或命令「首选项: 颜色主题」打开选择框，上下键实时预览，选中立即生效，不重新加载，其他窗口同步切换。
- 主题是 `{ id, name, type: "dark" | "light", colors: { token: CSS 值 } }`。每个 token 变成 `:root` 上的 CSS 变量：`fg.muted` → `--lite-fg-muted`。可以只写一部分 token，没写的取自同 `type` 的内置主题。完整的 token 列表见 `ui/themes/dark.json`。
- 插件样式里只用变量（`color: var(--lite-fg-muted)`），不写死颜色，切主题自动跟上。需要真实颜色值的代码（例如 xterm 画布）用 `ctx.theme.current().colors` 和 `ctx.theme.onChange(fn)`。
- 插件可以自带主题：manifest 里写 `"themes": ["themes/x.json"]`，内核在插件代码运行前读取。
- 自定义：主题编辑器插件（命令「首选项: 自定义颜色主题」，或主题选择框里的「自定义…」），保存到 `state.json` 的 `customThemes`。
- 文件图标会跟着主题深浅切换 Material Icon Theme 的浅色版本。

## 多语言（en / zh-CN）

- 默认跟随系统语言；在 About（点 Logo）→「更改语言…」或命令「首选项: 配置显示语言」里切换，保存在 `state.json` 的 `locale`，切换后窗口重新加载。
- 内核文案在 `ui/locales/<locale>.json`，每个插件的在 `plugins/<id>/locales/<locale>.json`。英文是兜底：中文包缺的 key 显示英文，都缺就显示 key 本身。
- manifest 里写 `"name": "%name%"`、`"description": "%description%"`，由内核从语言包解析。
- 插件里用 `ctx.t("key", { 参数 })`；`ctx.t.en(...)` 永远返回英文。
- 命令标题写成 `"%cmd.save%"`，内核会同时解析出当前语言和英文两个版本，命令面板和快捷键编辑器用两者匹配：中文界面下输入「保存」或「save」都能找到。
- 加新语言：在 `ui/i18n.js` 的 `LOCALES` 里加一项，再给内核和每个插件各加一个 `<locale>.json`。

## 代码高亮与内存

选型依据（本机实测，12k 行 / 484 KB 的 JS 文件）：

| 方案 | 整文件 | 输入 1 字符后 | 60 行视口 |
|---|---|---|---|
| **CodeMirror 6（Lezer）** | 88–110 ms，分片后台进行 | **0.6–0.9 ms** | 0.3–0.6 ms |
| tree-sitter（WASM） | 56–81 ms，一次性阻塞 | 1.6–1.8 ms | 0.8–1.3 ms |
| tree-sitter（Rust 原生） | 69 ms | 1.56 ms，另加 IPC | 0.39 ms |
| Shiki（TextMate） | 2100–2400 ms | 只能整篇重来 | — |

- 只渲染可见行（12k 行的文件页面上只有约 85 行 DOM），只高亮可见区域。
- 语言插件启动时只注册名字和扩展名；解析器（`lang.js`）第一次打开该类型文件时才加载，用不到的语言不占内存。
- 所有标签页共用一个 `EditorView`，每个标签只保留自己的 `EditorState`（文档、撤销历史、选区）。
- 插件文件通过 `lite-plugin://` 协议按需加载，不再把源码读进 JS 字符串再转 Blob（之前每个插件的代码在内存里多两份）。
- 共享模块：manifest 的 `"modules": { "<包名>": "<文件>" }` 会进入 import map；所有插件 import 同一份 `@codemirror/state` 等（CodeMirror 不允许同时存在两份核心）。
- 窗口最小化时把 WebView2 的 `MemoryUsageTargetLevel` 设为 Low，恢复时设回 Normal。实测：浏览过大文件后 186 MB → 最小化 89 MB → 恢复后 93 MB（比刚启动的 111 MB 还低）。反复打开/滚动/关闭大文件 5 轮，JS 堆稳定在 5.6–6.0 MB，没有泄漏。

## 写一个插件

`plugins/hello/manifest.json`

```json
{ "id": "hello", "name": "%name%", "description": "%description%", "version": "0.1.0",
  "main": "main.js", "dependencies": ["icons"], "permissions": [] }
```

`plugins/hello/locales/en.json`（`zh-CN.json` 同样的 key）

```json
{ "name": "Hello", "description": "Says hi.", "cmd.say": "Hello: Say Hi", "greeting": "Hi, {who}!" }
```

`plugins/hello/main.js`

```js
export async function activate(ctx) {
  const icons = await ctx.services.get("icons");
  ctx.commands.register("hello.say", "%cmd.say%", () => alert(ctx.t("greeting", { who: "Lite" })));
  ctx.keybindings.bind("ctrl+shift+h", "hello.say");
  ctx.slots.contribute("workbench.status.right", (el) => el.append(icons.create("hand")));
  // 标题栏按钮（提示里会自动带上当前快捷键）
  ctx.titlebar.addButton({ id: "hello", icon: icons.create("hand"), title: ctx.t("cmd.say"), command: "hello.say" });
}
```

> 在 `activate` 里 `await` 某个 service 时，必须把提供它的插件写进 `dependencies`，否则会等到 5 秒超时后被判定为加载失败。可选的集成用 `.then()`，不要 `await`。
>
> 右键菜单由每个插件自己负责：插件放进 `src/`，`import { showMenu, attachFieldMenu } from "@lite/context-menu"`，构建时打进插件自己。在 `contextmenu` 里 `e.preventDefault(); showMenu(ctx, e, items)`；item 可以直接写 `{ command, args }`，标签和快捷键自动取，命令不存在时自动置灰。输入框用 `attachFieldMenu(ctx, input, labels)` 得到剪切/复制/粘贴/全选。内核不提供任何右键菜单。

`ctx` 提供的 API：

| API | 作用 |
|---|---|
| `commands.register(id, title, fn)` / `execute(id)` / `list()` | 命令 |
| `keybindings.bind("ctrl+shift+k", commandId)` | 声明默认快捷键（用户覆盖优先） |
| `keybindings.list/isTaken/check/fromEvent/format` | 查询绑定、检测是否被其他程序注册为全局热键 |
| `keybindings.set(commandId, combos)/reset(commandId)` | 需要 `"keybindings"` 权限；写入 `state.json`，立即生效 |
| `events.on(name, fn)` / `emit(name, payload)` | 插件间松耦合通信 |
| `slots.define(name, el)` / `contribute(name, mount)` | UI 挂载点；内核只有 `root`，其它 slot 都由插件定义 |
| `services.provide(name, api)` / `await get(name)` | 插件给插件提供 API（`icons`、`workbench`、`editor`） |
| `assets.readText(file)` / `assets.url(file)` | 读取插件自己目录下的文件；或拿 URL 按需 `import()` |
| `keysFor(commandId)` | 命令当前快捷键的显示文本（如 `Ctrl+W`） |
| `watermark.addHint(commandId, label)` | 在空背景的 Logo 下显示一行提示（快捷键自动取当前绑定） |
| `app.name/version/logo(size)` | 产品信息和 Logo（SVG）；About 用 `commands.execute("app.about")` |
| `t(key, params)` / `t.en(...)` / `locale` | 本插件语言包里的文案；当前语言 |
| `workspace.root/name`、`recent()` | 当前项目 |
| `workspace.pickFolder/open/close/openInNewWindow` | 需要 `"workspace"` 权限 |
| `fs.readDir/readText/writeText` | 需要 `"fs"` 权限，限定在工作区内 |
| `fs.createFile/createDir/rename/trash/reveal` | 同上；不覆盖已存在的文件，删除进回收站，工作区根目录本身不能改名或删除 |
| `pty.spawn({ cols, rows, onData, onExit })` / `write/resize/kill` / `defaultShell()` | 需要 `"terminal"` 权限；系统默认 Shell（Windows 上 pwsh > powershell，其他系统 $SHELL），工作目录固定为工作区；输出按原始字节流式传输 |
| `git.run(args, { stdin })` | 需要 `"git"` 权限；在工作区目录运行系统的 git，返回 `{ code, stdout, stderr }`（不弹控制台、不提示输入凭据） |
| `openExternal(url)` | 用系统默认浏览器打开 http(s) 链接 |
| `titlebar.addButton({ id, icon, title, command })` | 标题栏右侧按钮 |
| `window.minimize/toggleMaximize/close/startDragging` | 需要 `"window"` 权限 |
| `plugins.list/setEnabled/reload` | 需要 `"plugins"` 权限 |
| `theme.current/color/cssVar/onChange/list/get/defaults/preference` | 当前颜色主题和所有主题；`onChange` 在切换或预览时回调 |
| `theme.pick/set/preview/saveCustom/removeCustom` | 需要 `"theme"` 权限 |
| `platform` | `"windows"` / `"macos"` / `"linux"` |

图标名见 <https://lucide.dev/icons>。注意 `lucide-icon-nodes.json` 只有规范名，不含旧别名（例如 `history` 要写成 `rotate-ccw-clock`）。

文件图标：`icons.file("src/main.rs")`、`icons.folder("node_modules", { open })` 返回彩色的 `<img>`（参数同样有 `size`、`className`）。先按完整文件名匹配（`package.json`、`Cargo.toml`），再按最长扩展名（`a.test.ts` → `test.ts` → `ts`），不区分大小写。编辑器的 `openPage` 也接受 `icon: { file: 路径 }`，标签页显示该文件的图标（例如 Git 的差异标签）。

## 原型的局限（下一步）

- 插件逻辑没有沙箱：权限检查在 JS 层，插件和内核共用一个 WebView。只有 fs 的工作区范围是在 Rust 侧强制的。
- macOS 未适配：自绘标题栏应保留系统红绿灯按钮（`titleBarStyle: Overlay`），窗口控制按钮不应画在右侧。目前只在 Windows 上验证过。
- 没有插件卸载和热重载，启用或禁用插件需要重载窗口。
- 编辑器还没有：LSP（跳转/诊断）、大纲、多文件搜索；结构化功能以后可以加 tree-sitter 插件。
