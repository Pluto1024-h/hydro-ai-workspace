# Hydro 智能管理平台插件

## 概要

管理员在 Hydro 后台对话框下自然指令，AI 通过受限工具查询/分析，高危操作必须确认后执行。本阶段只开放只读工具，先验证工具调用链与低配服务器稳定性。
（目前包括查询用户，分析用户代码生成总结，分析题目难度，打标签，修改题库题目（增删改查），自动根据生成题目数据等进入题库）。

## 环境要求

- Node v24.14.0 / hydrooj 5.0.0-beta.18 / @hydrooj/ui-default 4.58.0-beta.21
- DeepSeek API Key（官方当前模型：`deepseek-flash`）

##  安装 / 更新

```bash
mkdir -p /root/.hydro/addons
cd /root/.hydro/addons
unzip -o hydro-ai-workspace-v0.7.2.zip

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

## 首次配置

1. 打开 `/manage/ai-workspace/settings`，完成 sudo。
2. 勾选「启用 AI 对话」。
3. 对话模型默认 `deepseek-flash`；二次校验别名为 `deepseek_pro`，映射到真实模型 `deepseek-flash`（官方没有 `deepseek_pro` 这个模型名，映射在插件内部完成）。
4. 填写 API Key 并保存。Key 不回显，刷新后只显示 `sk-****abcd`。

## 可用工具

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

##  安全说明

- 全部路由要求 `PRIV.PRIV_EDIT_SYSTEM`；管理页带 `@requireSudo`。
- JSON 接口独立检查 `session.sudo` 时间戳，防止绕过页面直调接口。
- 本版本**不改 Hydro 核心数据**（题目/用户/比赛）；AI 没有对核心数据的执行权。写操作仅限插件自有的会话、审计、配置与用户分析档案集合。
- 用户档案只保存统计聚合与简短样本，不含完整提交代码；查看单条代码仍需单独调用 `get_submission` 且需有效 sudo。
- 高危操作（删题/删比赛/封禁/改密/批量修改）尚未开放，规划在后续阶段以「先确认再执行 + 审计」方式提供。
- 审计记录每次工具调用与对话，可在右面板查看最近 20 条。

## 许可

AGPL-3.0-or-later，详见 `LICENSE` 与 `NOTICE`。
