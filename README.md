# dsh-ding-card

> 钉钉 AI 卡片交互插件 · 正式版本 v2026.10.29（版本号采用年月日管理）

把 DeepSeek Harness（DSH）的人机交互变成**钉钉互动卡片**：当 Agent 需要提问、审批或展示结构化信息时，插件自动投放一张带推荐选项的卡片；用户点击按钮后，答案直接回到正在流式运行的会话里。Web 界面与钉钉卡片同时可用，先答者生效。

插件复用 [dsh-im](https://github.com/xmanrui/dsh-im) 已经配置好的钉钉机器人与 Stream 连接，**不再新建连接、不复制密钥**。安装后左侧边栏会出现「钉卡片」，在里面设计卡片、绑定模板，并让 Agent 在对话中按场景选择卡片。

## 功能特性

### 卡片库
- **添加 / 编辑卡片**：选择类型（消息卡片 / 吊顶卡片），设计标题、正文、字段、图片、按钮，实时预览，填写卡片说明。
- **按钮体系**：每个选项有**显示标签**与**回传值**；按钮垂直排列。
  - **成组卡片**（按钮 + 旁文本回传区，如答题卡 `btnsA ↔ btnsAvalue`）：按钮显示短标签，旁文本显示完整内容，回传值自动去序号前缀（`A. 中国神话中的神` → 按钮 `A`、回传 `中国神话中的神`）。
  - **非成组卡片**（只有按钮，如消息卡 `option1..N`、审批同意/拒绝）：按钮文案即回传值，完整显示。
- **JSON 导入 / 导出**：按钉钉卡片搭建器格式导出模板 JSON，导入后保持设计一致。
- **发送测试**：选择会话、模糊查询会话、自定义参数（含模板变量）后直接投放测试。
- **卡片类型 / 名称模糊筛选**：卡片库支持按类型多选 + 关键词筛选。

### 变量集
- **模板变量 + 自定义变量**：模板变量随钉钉侧模板变动，自定义变量为插件扩展。
- **类型体系**：普通文本、长文本、数字、链接、图片、音乐音频、封面图、日期等；按类型生成录入控件与 Mock。
- **重复检测**：变量名与类型相同不能重复添加，导入 JSON 自动跳过重复。
- **筛选与统计**：支持按变量类型多选筛选、按名称/描述模糊搜索；顶部显示变量总数。

### 交互与回调
- **提问卡片**：`ask_user_question` 自动转为带选项的钉钉卡片。
- **审批卡片**：工具调用需要确认时自动转为「允许 / 拒绝」按钮。
- **吊顶卡片**：固定会话顶部的音乐播放器等卡片（仅单聊，一张回复最多一张）。
- **回调持久化**：DSH 重启后，重启前的消息卡片回调仍可回收与记录。
- **回调日志**：记录每个按钮点击的回传值详情。
- **AI 流式填充**：AI 卡片逐 key 流式渲染，失败自动重试并落盘 `stream_failures.json` 明细。

### AI 自主使用（Agent 工具）
插件向 Agent 提供三个工具，使其能**自己判断用哪张卡、怎么传参**：

| 工具 | 作用 |
|---|---|
| `ding_card_list` | 卡片清单：每卡返回 `description`（功能说明）、`sendVariables`（实际可配变量：类型/角色/paired/Mock/required）、`maxOptions`（按钮上限）、`usedAs`（question/approval/ceiling 场景）、`interactive`（是否等待回应） |
| `ding_var_list` | 全量变量集：模板 + 自定义变量，含类型、Mock 示例与绑定 |
| `ding_card_send` | 按卡片名发送：title/content/options/fields/variables，支持等待点击回传 |

Agent 读取卡片说明 → 分析功能 → 核对变量与按钮 → 判断场景与是否等待 → 自动发送并传参。

### 音乐播放器组件
- 发送测试预览中识别钉钉音乐播放器组件并渲染（封面、歌名、歌手、进度、播放/暂停）。
- 支持将左侧变量（音频地址 / 封面 / 标题 / 歌手）**拖拽绑定到播放器槽位**，持久化保存；卡片删除/更新 JSON 时绑定自动清理。

## 安装与配置

### 方式一：通过 DSH 自定义地址从 GitHub 源码安装（无需 npm / Release）

DSH 的「添加插件」输入框支持三种形式：**包名、GitHub 仓库地址、本地目录路径**。从 GitHub 地址安装时，DSH 底层用 pnpm 拉取源码并在本地完成安装，**不要求发布 npm、不要求 GitHub Release**。

1. 打开 DSH → 插件 → **添加插件**
2. 输入框填写仓库地址（二选一）：
   - `github:Jydsh/dsh-ding-card`
   - `https://github.com/Jydsh/dsh-ding-card`
3. **安装源**保持默认（npm 官方源 / 中国大陆镜像源均可，仅影响依赖下载，不影响 GitHub 安装）
4. 点「安装」，完成后**重启 DSH**，左侧边栏出现「钉卡片」即成功

命令行方式（`--profile <profile>` 指定 DSH 环境名，不同机器 / 场景可分别安装到对应环境）：

```bash
# 桌面端（desktop）环境
dsh plugin --profile desktop add github:Jydsh/dsh-ding-card

# Web（web）环境
dsh plugin --profile web add github:Jydsh/dsh-ding-card

# 其他自定义环境：把 <profile> 换成实际环境名即可
dsh plugin --profile <profile> add github:Jydsh/dsh-ding-card
```

指定版本安装（配合 GitHub Release tag）：

```bash
dsh plugin --profile desktop add github:Jydsh/dsh-ding-card#v2026.10.29
```

> **关于 `<profile>` 环境名**：
> - 用 `dsh plugin --help` 或 DSH 设置页查看当前机器可用的环境名（常见：`desktop` / `web`，也可能是自定义名称）。
> - 若执行报错 `profile "xxx" is managed exclusively by the Electron application`，说明该环境正被 DSH 应用（Electron）独占：**先退出 DSH 再执行命令行安装**，或直接改用上面的 DSH 界面「添加插件」方式安装。
> - 安装到哪个 profile，插件就只在该环境的 DSH 实例中生效。

> 本插件为**纯 JavaScript、无构建步骤**，GitHub 源码安装时无需执行任何构建脚本，**不需要配置 pnpm 构建白名单（allowBuilds）**，安装即用。

> **前提**：执行安装的 DSH 服务器需能访问 GitHub（源码拉取需要网络）。无法访问时，可将本地 `npm pack` 生成的 `.tgz` 包拷入服务器，改用「本地目录路径 / 本地文件」方式安装。

### 方式二：发布到 npm 后按包名安装（可选）

`dsh plugin add dsh-ding-card`（官方源或中国大陆镜像源均可）。本仓库未自动发布，需要时按需发布。

### 手动安装（本地开发）

1. 安装 [dsh-im](https://github.com/xmanrui/dsh-im) 并配置好钉钉机器人（插件复用其连接，不复制密钥）。
2. 安装本插件到 DSH 的 `integrations/dsh-ding-card`。
3. 重启 DSH，左侧边栏出现「钉卡片」入口。
4. 在「卡片库」添加卡片 → 导出模板 JSON → 在钉钉后台导入并绑定模板 ID。
5. 在「变量集」维护变量与 Mock，在「发送测试」验证效果。

## 开发与测试

```bash
node --test "D:\dsh\dsh-ding-card\test\*.test.mjs"   # 42/42
node --check lib/export.js lib/tools.js              # 语法检查
```

- 生效规则：`tools.js` / `export.js` / `cards.js` 改动需重启 DSH；`client.js` 改动重开管理页即可。

## 目录结构

```
lib/
  index.js        插件入口与安装
  tools.js        Agent 工具（ding_card_list / ding_var_list / ding_card_send）
  cards.js        卡片生命周期（发送/回调/回收/持久化）
  export.js       卡片数据构建与模板导出
  import.js       钉钉模板 JSON 导入
  store.js        配置与变量集
  interactions.js 提问/审批卡片接入
  stream-bridge.js 钉钉 Stream 回调
  dshim.js        dsh-im 集成
  rpc.js          管理页 RPC
  client.js       管理界面（卡片库/变量集/发送测试/日志）
docs/             架构与模板文档
test/             单元测试
```

## License

MIT
