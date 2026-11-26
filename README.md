# Hydro 智能管理平台插件

> **v0.7.2 修复（"缺少必填参数 title"）**：根因是 `max_tokens` 被写死 **2048**——生成整个题包（题面+参考程序+14 组测试数据）的 JSON 远超此上限被**截断**，字段丢失；而参数解析器又把解析失败的 JSON **静默变成 `{}`**，于是错误显示成"缺少 title"，完全误导。修复：`max_tokens` 默认提高到 **8192**（可配置，上限 8192）；截断/损坏的 JSON 现在会**明确报错**并说明"很可能输出超限"，不再伪装成缺字段；缺参数提示会列出"本次实际收到哪些字段"；系统提示要求大数据一律用 generator、题面长时 testData 先给 6–8 个关键数据，宁可少而全。超时也从 30s 提到 60s（长题包生成更慢）。
>
> **v0.7.1 修复（题面读不到）**：`get_problem_detail` / `get_problem_full` 之前把题面正文只放进工具的 `data`（仅界面卡片可见），而模型**只能读 `summary`**——所以 AI 会如实说"只返回了摘要，拿不到题面原文"。更糟的是 `get_problem_full` 的摘要还写着"完整题面已在摘要中"，属于谎报。现在两个工具的摘要都会**直接嵌入题面正文**（detail 前 6000 字 / full 前 12000 字），并明确标注 `pid=` 与 `docId=`；`search_problems`/`browse_problems` 列表也会在编号不同时显示 `P2(docId=2)`，避免"这个编号到底是不是 pid"的困惑。新增回归测试第 29 项锁死"题面必须出现在摘要里"。
>
> **v0.7.0 新增（在原题上写数据，不重复建题）**：`add_problem_draft` 支持 `targetPid`——给题库**已有**题目补/换测试数据时，直接写进那道原题，**不再新建重复题**（这正是此前「清单生成了、原题测试数据却没变」的原因：旧版只会新建，数据写到了另一道新题上）。
> - 安全顺序：**先写新测试数据，成功后才清理多余的旧文件**；中途失败绝不删除原题，只回滚本次新写入的文件。清单页会明确显示「将写入已有题目 B4579，现有 N 个测试文件将被替换」，按钮文案也变为「写入原题测试数据」。
> - 目标题目不存在时直接报错并提示先用 `browse_problems` 查编号，不会退化成新建。
> - 执行完成后清单页显示「已写入原题 B4579（docId 777），测试文件 15 组，清理旧文件 1 个」，便于你直接在题目页核对。
>
> **v0.6.0 新增（测试数据按类别成体系）**：`testData` 不再是随意几个输入，而是**按类别结构化**并强制覆盖：
> - `boundary` 边界（n 最小/最大、临界相等）· `extreme` 极限（题面允许的最大规模，压时限内存）· `tricky` 易错（全相同/已有序/逆序/负数/0/溢出/重复/无解/多解）· `normal` 普通（典型中等规模）· `special` 特殊（题目特有情形）。
> - **校验是硬性的**：五类各至少 1 个、总数至少 6 个（建议 12–20），缺任何一类直接拒绝生成清单并明确告诉你缺哪类；每条都必须写 `purpose`（这条数据测什么）。
> - **必须填写 `constraints`**（题面数据范围原文），作为数据设计的硬边界。
> - **大数据用生成器**：n=10⁵ 这类输入不可能让 AI 逐字输出，改为 AI 写 Python 生成器脚本，确认时服务器运行脚本产出真实输入，再跑题解算出输出。已实测 10 万规模生成+计算通过。
> - 入库后每个测试点的类别与用途记录在清单里，可在清单页逐条核对；最终测试点上限 30 个、总生成预算 45 秒，超出会提示只生成了部分。
>
> **v0.5.1 新增（网页抓取）**：`fetch_url` 直接抓取一个网页并提取正文，**无需搜索 API Key**。用户给出洛谷、真题页、博客等链接时，AI 应先抓取再整理题包，而不是一上来让你贴题面。安全上做了 SSRF 防护：只允许 http/https，拒绝回环/内网/`169.254.169.254` 云元数据地址（字面 IP 与 DNS 解析结果都查），手动跟随重定向并逐跳校验，响应上限 2MB、超时 12s。**已知限制**：洛谷（无 Cookie 会重定向回自身）、Codeforces（Cloudflare TLS 指纹 403）、部分 OJ 的 PoW 验证页（如 Cerberus/Anubis）**纯 HTTP 抓不到**，需要 headless 浏览器（2G 服务器不适合）；这类站点插件会给出明确提示，并识别出验证页以免把"验证您是真人"当成题面。普通博客、文档站、无防护 OJ 可正常抓取。
>
> **v0.5.0 新增（S4 自动出题入库）**：`add_problem_draft` 生成结构化标准题包（题面 Markdown / 数据范围 / 标签 / 时限 / 内存 / 满分 / 测评方式 / Python3 参考程序 / 题面样例 / 分类测试数据）。**关键原则：AI 只写，不编答案**——确认入库时服务器在受限子进程里真实运行参考程序计算 `.out`，并先用题面样例校验题解正确性；题解对不上样例就拒绝生成自动测试点、只保留题面样例并强警告。入库走 `ProblemModel.add`（默认隐藏）→ `addTestdata` 写 `N.in/N.out` + `config.yaml` → `edit` 回填 config；写入失败自动回滚删掉半成品题。清单页可展开查看题面原文、参考程序、样例与分类测试数据（HTML 已转义）。
>
> **运行环境要求**：自动计算测试输出需要服务器有 `python3`（判题机通常自带）。受限执行：隔离模式 `-I -S`、CPU 2s / 内存 256MB / 输出 64KB / 每点 4s 超时、最多 12 个测试点、串行执行、临时目录自动清理；可用环境变量 `HYDRO_AI_DISABLE_SOLUTION_RUN=1` 完全关闭代码执行（此时仅入库题面样例）。**仍建议你核对题面与样例是否与权威来源一致**——服务器只保证输出由题解真实计算，不保证题面本身正确。
>
> **v0.4.3 新增**：修改清单支持**逐项勾选**——默认全选，可取消不想做的项、支持全选/反选与实时计数，确认时只执行勾选的项目。勾选粒度按「操作单元」（删除重复题以「组」为单位，取消勾选即整组不动），避免出现"一组只删一半"。服务端二次校验索引合法性、拒绝空选择、审计记录已执行/跳过项；清单列表页对部分执行显示「跳过 N 项」标记。
>
> **v0.4.2 修复**：查重/标签分析上限从 500 提到 **5000**（默认 2000），并把 O(n²) 两两比对换成 MinHash+LSH 近线性候选筛选——原来 `20000` 次比对上限导致 1000 题时只比前 ~200 题，后面的题根本没参与查重。实测 3000 题全库扫描 74ms、450 组重复零漏检。摘要会显示"已扫描 X/Y 题（全库/未覆盖全库）"。
>
> **v0.4.1 修复**：清单列表页/详情页原先在模板里调用 `String()`，Nunjucks 不支持导致整页渲染失败（表现为清单页样式/内容缺失）。日期格式化已移到服务端，模板只渲染纯字符串。
>
> **v0.4.0 新增**：
> - 题库浏览 `/manage/ai-workspace/problems`（分页）+ `browse_problems` / `get_problem_full`（完整题面回喂模型）。
> - 查重 `find_duplicate_problems`：题面正文归一化后比对相似度（非仅标题），输出重复组与判定依据。
> - 标签优化 `suggest_problem_tags`：识别 GESP 级别（2026年3月GESP一级→GESP一级）与知识点（for 循环、旗帜法、贪心、二分、动态规划、数论等），输出"原标签→建议标签"。
> - 清单闭环：`propose_delete_duplicates` / `propose_update_tags` / `add_problem_draft` 只生成清单；清单页展示改动与风险警示，确认后才调用 ProblemModel.del/edit。
> - 联网搜索 `search_web`：配置页可切 博查/Tavily/Serper，Key 单独存且不回显；无 Key 时可让你贴原文让 AI 生成题目草稿。
> - 会话持久化：输入框草稿自动存本地（刷新不丢），历史会话列表可点击恢复。
>
> **v0.3.5 新增**：`list_recent_submitters(days)` 直接从提交记录反查"最近谁有提交"及提交数/AC 数/最近提交时间，AI 不必再逐个猜 UID；`list_users(offset,limit)` 实时分页列出全站普通用户 UID 与近期提交数。系统提示已要求优先用前者，禁止盲目枚举。模拟测试 24 项。
>
> **v0.3.4 修复**：打通「提交 → 源码级分析」链路。此前 `query_user_submissions` 的 24 位提交 ID（rid）和 `get_submission` 的源码都只放在前端卡片 `data` 里，而模型只能看到 `summary`，导致 AI 拿不到 rid、即使调用工具也看不到代码，只能回复"需管理员提供 rid"。现在提交明细摘要直接列出 rid，看代码工具的摘要包含源码正文与编译/评测输出；系统提示明确要求 AI 直接用 rid 做 CE/WA 分析。模拟测试扩到 22 项。
>
> **v0.3.3 修复**：AI 回答现在渲染 Markdown（表格、标题、列表、代码块、加粗、行内代码），不再是一堆纯文本；工具调用 chip 与结果卡片收进默认折叠的「工具调用过程」，不再刷屏；渲染前统一 HTML 转义，防止注入。模拟测试扩到 21 项。
>
> **v0.3.2 修复**：新增离线模拟测试（19 项常用场景，全绿）；修复 `get_user_profile` 工具重名导致"查用户资料"被分析档案静默覆盖的 bug（资料工具改名 `get_user_info`，注册表加防重名保护）；用户检索与分析摘要补齐 UID、题号。
>
> **v0.3.1 修复**：工具摘要现在直接列出题目编号（pid）与标题、比赛 ID，AI 和用户都能拿到编号逐题查题面；`get_problem_detail` 同时接受纯数字 docId 与字符串 pid。
>
> **v0.3.0 新增**：`get_contest_problems`（比赛题目+难度）、`query_user_submissions`（提交对应题目/难度/失败原因）、`refresh_user_profile` / `get_user_profile` / `list_user_profiles` / `update_profile_notes`（档案建立与个性化结论），档案页 `/manage/ai-workspace/profiles`。修复了多轮对话的 `tool` 消息回放错误（DeepSeek 400）。
>
> **v0.2.1 修复**：① 配置页 `model["system"]["get"]` 渲染错误——表单字段 `model` 覆盖了 Hydro 模板全局的 `model` 对象，已改名为 `chatModel`；② 工作区/配置页样式改为模板内联 CSS。

## 1. 目标形态

管理员在 Hydro 后台对话框下指令，AI 通过受限工具查询/分析，高危操作必须确认后执行。本阶段只开放只读工具，先验证工具调用链与低配服务器稳定性。

完整计划：`C:\Users\16833\.workbuddy\plans\cosmic-forging-einstein-k_pV7KY_.md`

## 2. 环境要求

- Node v24.14.0 / hydrooj 5.0.0-beta.18 / @hydrooj/ui-default 4.58.0-beta.21
- 2 核 2G，Hydro + MongoDB + 判题同机，后台按单人使用设计
- DeepSeek API Key（官方当前模型：`deepseek-flash`、`deepseek-v4-pro`）

## 3. 安装 / 更新

```bash
mkdir -p /root/.hydro/addons
cd /root/.hydro/addons
unzip -o /path/to/hydro-ai-workspace-v0.7.2.zip

# 首次安装
hydrooj addon add /root/.hydro/addons/hydro-ai-workspace

# 更新直接重启
pm2 restart hydrooj
```

`hydrooj addon add` 后面必须是直接包含 `package.json` 的目录；zip 根目录固定为小写 `hydro-ai-workspace`。

回滚：

```bash
hydrooj addon remove hydro-ai-workspace
pm2 restart hydrooj
```

## 4. 首次配置

1. 打开 `/manage/ai-workspace/settings`，完成 sudo。
2. 勾选「启用 AI 对话」。
3. 对话模型默认 `deepseek-flash`；二次校验别名为 `deepseek_pro`，映射到真实模型 `deepseek-flash`（官方没有 `deepseek_pro` 这个模型名，映射在插件内部完成）。
4. 填写 API Key 并保存。Key 不回显，刷新后只显示 `sk-****abcd`。
5. 也可在服务器上设置环境变量 `HYDRO_AI_DEEPSEEK_KEY`，优先级高于页面填写。

> Key 若存数据库，Hydro 配置界面会掩码，但**入库并非加密**；环境变量方式更安全。

## 5. 可用工具

查询类（只读）：

| 工具 | 能力 |
|---|---|
| `search_problems` / `get_problem_detail` / `list_tags` | 题目检索、题面与测试数据清单、标签词表 |
| `list_contests` / `get_contest_detail` | 比赛与作业查询（`kind=homework` 即作业） |
| `get_contest_problems` | **某场比赛/作业的题目清单、标题、标签、难度、通过率** |
| `list_recent_submitters` | **按天数从提交记录反查提交者 UID、提交数、AC 数、最近提交时间（动态查询）** |
| `list_users` | **分页列出全站普通用户 UID 与近 N 天提交数（动态查询，offset 翻页）** |
| `search_users` / `get_user_info` | 用户检索与资料摘要，自动排除系统账号和管理员，不含邮箱/哈希 |
| `query_site_stats` | 全站用户/题/赛/提交数、30 天趋势、AC 率、热门标签 |
| `analyze_user` | 单用户题目类型分布、AC 率、语言与代码长度趋势 |
| `query_user_submissions` | **用户每条提交是哪道题、难度、结果状态、失败原因、时间** |
| `get_submission` | 按 ID 看单条提交代码，需有效 sudo，代码最多 4000 字 |
| `browse_problems` / `get_problem_full` | 分页浏览题库、读取完整题面（最多 12000 字） |
| `find_duplicate_problems` | **按题面正文相似度查重（非仅标题），输出重复组与判定依据** |
| `suggest_problem_tags` | **识别 GESP 级别与知识点，输出"原标签→建议标签"** |
| `search_web` | 联网搜索（需在配置页填搜索 API Key） |
| `fetch_url` | 抓取单个网页正文（无需 Key；有 SSRF 防护与反爬页识别） |

清单类

| 工具 | 能力 |
|---|---|
| `propose_delete_duplicates` | 生成删除重复题清单（每组保留第一题） |
| `propose_update_tags` | 生成标签优化清单 |
| `add_problem_draft` | 生成标准题包清单（题面/数据范围/标签/时限内存/分数/参考程序/样例/分类测试数据）；确认后建题并生成测试数据，**传 targetPid 则直接写入已有题目** |

档案类

| 工具 | 能力 |
|---|---|
| `refresh_user_profile` | 根据最近提交重新计算用户档案（统计聚合，不写入提交代码） |
| `get_user_profile`（档案） | 读取档案：刷题清单、活跃时段、失败原因、代码习惯、实力评估、AI 结论 |
| `list_user_profiles` | 列出已建档用户及实力等级 |
| `update_profile_notes` | 把 AI 的个性化分析结论写入档案 |

**档案包含**：刷过哪些题（含难度/标签/通过情况）、什么时段刷题、提交失败原因分布（WA/TLE/CE 等）、代码常犯问题与习惯特征、实力等级与依据、优势/薄弱标签，以及 AI 用中文写的个性化结论。可在 `/manage/ai-workspace/profiles` 直接查看。

典型对话：
- 「检查题库里有没有重复题，特别要对比题面」→ AI 调 find_duplicate_problems → propose_delete_duplicates → 你去清单页核对确认
- 「把所有 GESP 题的级别和知识点标签补上」→ AI 调 suggest_problem_tags → propose_update_tags → 你去清单页确认
- 「搜索 2026 年 3 月 GESP 二级真题，整理成标准题包并加进题库」→ AI 调 search_web → add_problem_draft → 你在清单页展开核对题面/参考程序/样例 → 确认后服务器运行题解生成测试点并自动建题（默认隐藏）
- 「把这个链接的题目加进题库 https://…」→ AI 先调 fetch_url 抓正文（不用 Key）→ add_problem_draft → 确认入库；若站点反爬（洛谷/CF/真人验证）会提示你直接粘贴题面
- 「这道题按边界/极限/易错造数据」→ AI 生成 5 类 testData（含 n=10⁵ 的生成器脚本）→ 清单页逐条显示「类别 + 测什么」→ 确认后服务器跑生成器+题解产出真实测试点
- 「给 B4579 补测试数据，题面我已经有了」→ AI 先查 pid 确认存在 → add_problem_draft 传 targetPid=B4579 → 确认后**直接写进原题**、替换其测试数据（不新建）
- 「最近 7 天全站哪些学生交了题，把他们的代码给我」→ AI 依次调 list_recent_submitters → query_user_submissions → get_submission
- 「列出比赛 X 的题目和难度」（先用 `list_contests` 找 ID）
- 「查用户 42 最近失败的提交都是哪道题、什么原因」
- 「分析用户 42 并建立档案」→ AI 自动依次调用 analyze_user → refresh_user_profile → 读档案 → 写个性化结论

`simulate.js` 会用内存假数据库跑真实工具函数，覆盖：比赛 ID → 比赛题目难度 → 数字/字符串 pid 查题面 → 搜题 → 搜用户 → **按提交反查提交者 UID** → **全站 UID 分页清单** → 提交明细（含 rid） → 用户分析 → 建档 → 写结论 → sudo 校验 → 参数校验 → 工具重名 → 摘要长度 → 模板变量冲突 → 对话历史回放 → Markdown 表格渲染 → HTML 转义 → 源码与编译错误回喂 → GESP/知识点识别 → 题面级查重归一化 → 清单令牌五项校验 → 只读分析不改题库，共 30 项。任何一项失败都会打印具体原因并以非零码退出，**不要打包未全绿的版本**。

## 6. 对话体验说明

- AI 回答按 Markdown 渲染（表格、标题、列表、代码块、加粗、行内代码），渲染前统一转义 HTML；工具调用 chip 与结果卡片默认收进「工具调用过程（N）」折叠区，需要追溯时点开即可，工具失败提示仍直接显示。
- 服务端完成整个"模型 → 工具 → 模型"循环后返回事件数组，前端按顺序动画渲染；效果接近流式，但**不是 SSE**。原因：5.0.0-beta.18 的 Handler 没有稳定的普通 POST 流式输出路径，SSE 走 ConnectionHandler 且更适合 GET/WS。这样换取稳定性和低内存。
- sudo 有效期 1 小时（Hydro 官方实现）。过期后 JSON 接口返回 `sudo_required`，前端显示"重新验证"按钮，点击回工作区页触发原生 sudo。
- 连续提问串行排队，不会并发打爆 DeepSeek 或 MongoDB。
- 429 / 500 / 503 / 504 最多重试 2 次；超时 30 秒可配置。


## 9. 安全说明

- 全部路由要求 `PRIV.PRIV_EDIT_SYSTEM`；管理页带 `@requireSudo`。
- JSON 接口独立检查 `session.sudo` 时间戳，防止绕过页面直调接口。
- 本版本**不改 Hydro 核心数据**（题目/用户/比赛）；AI 没有对核心数据的执行权。写操作仅限插件自有的会话、审计、配置与用户分析档案集合。
- 用户档案只保存统计聚合与简短样本，不含完整提交代码；查看单条代码仍需单独调用 `get_submission` 且需有效 sudo。
- 高危操作（删题/删比赛/封禁/改密/批量修改）尚未开放，规划在后续阶段以「先确认再执行 + 审计」方式提供。
- 审计记录每次工具调用与对话，可在右面板查看最近 20 条。

## 10. 许可

AGPL-3.0-or-later，详见 `LICENSE` 与 `NOTICE`。
