# dsh-review

[`@earendil-works/pi-review`](https://github.com/earendil-works/pi-review) 的 DeepSeek Harness 移植版。
`pi-review` 是 Pi coding agent 的 `/review` 与 `/end-review` 代码审查工作流扩展；本插件把它搬到 DSH 上。

**审查标准完全一致。** 审查准则（rubric）、五种审查目标的提示词、总结提示词与修复提示词，都从
上游逐字移植（有测试逐字校验）。改变的只是外围机制——因为 Pi 的扩展 API 与 DSH 的 Cordis 插件体系
完全不同。

English: a port of pi-review's `/review` and `/end-review` workflow to DeepSeek Harness.

## 功能

- 审查**未提交改动**（已暂存、未暂存、未跟踪文件）
- 审查相对**基线分支**的改动（PR 风格比较）
- 审查**单个提交**
- 审查 **GitHub Pull Request**（通过 `gh` 在本地检出）
- 审查一个或多个**目录/文件**（快照审查，不是 diff）
- 产出带优先级、可执行的审查结论，并给出明确判定
- 区分「给 agent 的反馈」与「给人类审查者的提醒」
- 支持 `REVIEW_GUIDELINES.md` 项目级自定义审查准则

## 安装

```sh
dsh plugin --profile web add github:iceloon/dsh-review
dsh web
```

重启 profile 后生效。本地开发时用 link：

```sh
dsh plugin --profile web add link:/path/to/dsh-review
```

## 使用

```bash
/review                                  # 打开交互式选择器
/review uncommitted                      # 审查未提交改动
/review branch main                      # 相对 main 分支审查
/review commit abc123                    # 审查某个提交
/review pr 123                           # 审查 PR #123（本地检出）
/review pr https://github.com/owner/repo/pull/123
/review folder src docs                  # 快照审查这些路径
/review branch main --extra "重点看性能和错误处理"
```

审查进行中时，用 `/end-review` 结束：

```bash
/end-review
```

随后可选择：**仅返回**、**返回并总结**、**返回并修复**。

## 与 pi-review 的差异

移植时遇到的真正约束是**会话分叉**。Pi 可以把当前对话导航回更早的节点；DSH 的会话日志是只追加的
（append-only），而且「当前显示哪个会话」是**浏览器端状态**，宿主插件无法直接切换。

因此本插件保留了 Pi 的形态——在分支里审查，结束时返回——但用 DSH 已有的能力实现：

| pi-review | dsh-review |
|---|---|
| `pi.exec(argv)` | `ctx.shell.run()`，走会话的沙箱策略 |
| `pi.registerCommand` | `ctx.commands.register` |
| `ctx.ui.select` / `ctx.ui.editor` | `ctx.userQuestions.ask`（Web GUI 原生弹窗） |
| `pi.sendUserMessage` | `agent.followup()` |
| `pi.appendEntry` 持久化会话内状态 | 进程内状态表，按会话 id 隔离 |
| `ctx.navigateTree` 回到锚点 | 分叉一个审查会话，浏览器端跟随切换 |

工作方式：

1. `/review` 在宿主侧**分叉**出一个审查会话（`ctx.sessionController.fork`），从最后一个完整轮次
   的边界切开。
2. 插件把一个「聚焦指令」发布到同源路由 `/dsh-review/status`。
3. 浏览器半边轮询该路由，并用客户端已有的 `ctx.sessions.open(id)` 切换过去——这正是内置聊天视图
   分叉对话时用的同一个调用。
4. `/end-review` 把浏览器切回原会话。审查会话仍留在历史里，可随时回去查看。

如果某个 profile 没有浏览器（headless）或没有会话控制器，插件会**就地审查**而不是报错，并在结果里
说明当前是哪种模式。可用 `branchReview: false` 强制始终就地审查。

另外修复了上游一个解析 bug：`/review folder src docs` 原本会被当成单个路径 `"src docs"`，现在正确
识别为两个路径（有回归测试覆盖）。

## 配置

设置 → 插件 → dsh-review：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `customInstructions` | 空 | 追加到每次审查的共享指令（对应 pi-review 的 custom review instructions） |
| `branchReview` | `true` | 是否分叉审查会话；关闭则就地审查 |

## 项目级审查准则

在项目根的 `.dsh/` 或 `.pi/` 目录**旁边**放一个 `REVIEW_GUIDELINES.md`：

```
my-project/
├── .dsh/                    ← 标记目录（存在即可）
├── REVIEW_GUIDELINES.md     ← 内容会追加到审查提示词
└── src/
```

插件会从当前工作目录向上查找第一个包含标记目录的目录，并读取该目录下的 `REVIEW_GUIDELINES.md`。
这些准则在提示词里排在最后，因此按 rubric 自己的约定，它们**覆盖**通用规则。

## 开发

```bash
npm install
npm run typecheck    # 宿主半边 + 浏览器半边
npm test             # 51 个测试
npm run build        # 产出 lib/
```

### 结构

| 文件 | 作用 |
|---|---|
| `src/prompts.ts` | 逐字移植的 rubric 与全部提示词 |
| `src/targets.ts` | 五种审查目标与提示词组装 |
| `src/git.ts` | git / gh 调用（经 `ctx.shell`）与参数引用 |
| `src/resolve.ts` | 把用户请求解析为具体审查目标 |
| `src/guidelines.ts` | 参数解析与 `REVIEW_GUIDELINES.md` 加载 |
| `src/branch.ts` | 分叉边界的计算（与宿主同一套规则） |
| `src/web.ts` | 同源状态路由（宿主→浏览器） |
| `src/client/index.ts` | 浏览器半边：跟随聚焦指令切换会话 |
| `src/index.ts` | 插件本体：注册两个命令 |

## 已知限制

- 仅支持 POSIX shell（命令引用使用单引号转义）；Windows 未验证。
- 分叉发生在**完整轮次**边界，这是 DSH 的硬性要求。如果会话还没有完整轮次，会退化为就地审查。
- `/end-review` 的「返回」依赖浏览器半边；若在 headless 下使用，审查会话仍可访问，但不会自动切换。

## 许可

MIT。本包是 `@earendil-works/pi-review`（Copyright (c) 2026 Earendil Inc.）的移植版，其 rubric 与
提示词文本逐字保留。详见 `LICENSE`。
