# Social Media Agent + 官方 Postiz：安装与运行

本方案只维护这个 **Social Media Agent Fork**。内容 worker 在本仓库运行
LangGraphJS，负责读取来源、结合品牌资料生成内容、检查并提交草稿；官方 Postiz
镜像负责社交账号连接、编辑日历、排期和平台发布。两者通过 Public API 通信。

这一入口不要求 Agent Server、LangGraph Platform、Arcade、Supabase 或 Slack。
原仓库的旧入口仍可存在，但不要运行它们来启动本 worker。

## 1. 部署结构与版本

| 部分          | 本方案                                                               |
| ------------- | -------------------------------------------------------------------- |
| 内容 worker   | Node `24.21.0`，Yarn `1.22.22`，本仓库 `Dockerfile.postiz`           |
| Postiz        | 官方 `v2.24.0` 镜像，固定多架构 manifest digest                      |
| 官方 Compose  | 固定 `dd4969e5e694cd009619a0d53cff14c21104580b`，完整 checkout       |
| 运行依赖      | 官方 PostgreSQL、Redis、Temporal、Temporal PostgreSQL、Elasticsearch |
| 可选工具      | `debug` profile 的 Temporal UI；`admin` profile 的 Temporal 管理工具 |
| 持久化        | 官方数据库、配置、上传文件卷，以及独立的 worker `content-data` 卷    |
| 业务资料      | 宿主 `deploy/postiz/private/content/`，只读挂载到 `/app/content`     |
| worker 数据库 | 容器 `/data/content.sqlite`；仅运行一个 worker 实例                  |

镜像出处、上游配置路径和升级边界见 [UPSTREAM.md](../deploy/postiz/UPSTREAM.md)。
官方特别要求完整取得 Compose 目录及其 `dynamicconfig`，不能只下载一个 YAML。
本项目的 bootstrap 会完整拉取，并保留官方 LICENSE。
来源：[官方安装文档](https://docs.postiz.com/self-host/installation/docker-compose)。

以下命令在仓库根目录的 **Linux / WSL Bash** 执行。需要 Git、Docker Engine、
Docker Compose **2.24.4 或更高**及能拉取 GitHub、GHCR、Docker Hub、npm 包的网络。
Compose 的版本要求来自替换公开端口所使用的 `!override`。
来源：[Docker Compose 合并规则](https://docs.docker.com/reference/compose-file/merge/)。

## 2. 准备本地配置

```bash
cp .env.postiz.example .env.postiz
chmod 600 .env.postiz
mkdir -p deploy/postiz/private/content
cp config/postiz/brand.example.json deploy/postiz/private/content/brand.json
cp config/postiz/input.example.json deploy/postiz/private/content/input.json
cp config/postiz/sources.example.json deploy/postiz/private/content/sources.json
```

编辑 `.env.postiz`，先完成以下设置：

| 设置                                       | 填写方法                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `POSTIZ_PUBLIC_URL`                        | 本地试跑可用 `http://localhost:4007`；持续部署使用自己的固定 HTTPS 域名，末尾不加 `/` |
| `POSTIZ_JWT_SECRET`                        | 独立随机值                                                                            |
| `POSTIZ_DB_PASSWORD`                       | 独立随机值，建议十六进制以适配数据库 URL                                              |
| `POSTIZ_REDIS_PASSWORD`                    | 独立随机值，建议十六进制以适配 Redis URL                                              |
| `TEMPORAL_DB_PASSWORD`                     | 独立随机值                                                                            |
| `POSTIZ_X_API_KEY` / `POSTIZ_X_API_SECRET` | 自己的 X 应用 Consumer Key / Secret，配置给 Postiz                                    |

可分别运行四次以下命令，得到四个不同的随机值，再填入对应变量：

```bash
openssl rand -hex 32
```

`.env.postiz`、`deploy/postiz/private/`、下载的 `upstream/` 和备份目录均忽略提交。
不要把真实密钥填入 `.example` 文件。品牌资料只在运行时挂载，Docker 构建使用
专用允许清单，既不复制 `.env`，也不把整个仓库或本地业务资料发送进构建上下文。

`brand.json` 是编辑背景，不能把其中的营销描述直接当作证据。
请填写真实受众、语言、内容规则和自己的写作样例；`verifiedFacts` 仅放入能追溯到
资料 URL 的产品事实。默认示例没有价格、性能、功能支持等未经核实的声明。

## 3. 启动官方 Postiz

```bash
bash deploy/postiz/bootstrap.sh
bash deploy/postiz/compose.sh config --quiet
bash deploy/postiz/compose.sh up -d postiz
bash deploy/postiz/compose.sh ps
```

`bootstrap.sh` 校验固定 commit 和完整文件，不会覆盖已修改的上游目录。
所有 Compose 操作使用本项目的 `compose.sh`，不要直接进入 `upstream/` 运行官方
示例，否则本项目的密码、端口、镜像固定和 worker 配置不会生效。

默认仅将 Postiz 映射到宿主 `127.0.0.1:4007`。本地试跑时，配置 `POSTIZ_PUBLIC_URL=http://localhost:4007`，直接用这台电脑的浏览器访问即可。

如果部署到持续运行的服务器，再将自己的 HTTPS 反向代理指向该地址。
例如宿主 Caddy 的站点段为：

```caddyfile
postiz.example.com {
    reverse_proxy 127.0.0.1:4007
}
```

域名要替换成自己的，并与 `POSTIZ_PUBLIC_URL` 完全一致。如果反向代理也运行在
Docker 容器，不能用它自身的 `127.0.0.1:4007`；将代理接入同一 Postiz 网络并指向
`postiz:5000`，或使用自己的宿主访问方案。这里不额外部署另一套代理。

数据库、Redis、Elasticsearch 和 Temporal gRPC 不映射宿主端口。Temporal UI 仅在
主动启用时绑定宿主回环地址：

```bash
bash deploy/postiz/compose.sh --profile debug up -d temporal-ui
```

本配置启用 `DISABLE_REGISTRATION=true`。固定版本允许创建第一个组织，之后关闭
新的本地注册；首次打开自己的域名完成注册即可。
来源：[v2.24.0 注册条件](https://github.com/gitroomhq/postiz-app/blob/v2.24.0/apps/backend/src/services/auth/auth.service.ts)。

## 4. 连接 X 与内容 worker

1. 按 [Postiz 的 X 配置说明](https://docs.postiz.com/self-host/providers/x-twitter)
   配置自己的 X 开发者应用和回调地址，并在 Postiz 页面连接目标账号。
   回调地址使用浏览器实际访问的 Postiz 地址，并与 X 应用设置一致；不能填 worker 内部地址。
2. 在自己的 Postiz 实例取得 Public API key，填入 `.env.postiz` 的 `POSTIZ_API_KEY`。
3. 填写 `CONTENT_MODEL_PROVIDER`、`CONTENT_MODEL`、`CONTENT_MODEL_API_KEY`。
   允许 `openai` 或 `anthropic`。示例 `gpt-4.1-mini` 来自
   [OpenAI 模型列表](https://developers.openai.com/api/docs/models/all)；
   使用兼容服务时，改为该服务实际支持的模型，并按需填写 `CONTENT_MODEL_BASE_URL`。
4. 构建 worker 并查询账号列表，找到目标账号对应的 integration ID：

```bash
bash deploy/postiz/compose.sh build content-worker
bash deploy/postiz/compose.sh run --rm content-worker integrations
```

将结果中的目标账号 ID 填入 `POSTIZ_INTEGRATION_ID`。这是 Postiz 的 integration ID，
不是 X 用户名，也不是 X 用户 ID。
首次入队或运行会在 SQLite 中固定该品牌与 X integration 的关系。后续切换环境变量
不能把历史候选或任务改送到另一个账号；遇到不匹配会在采集、模型或提交请求前停止。
本期一个品牌只服务一个 X 账号。确需经营另一个账号时，使用独立品牌 ID 或独立数据库，
原库继续保留用于原账号的回执同步。升级时也会检查已有任务中的账号身份。
旧版仅有候选、尚无内容任务的数据库没有保存账号身份；升级前须核对原来的
`POSTIZ_INTEGRATION_ID`，程序无法从这些旧候选反推出原账号。
API 认证是 `Authorization: API_KEY`，不额外加 `Bearer`；客户端已处理。
来源：[Postiz Public API](https://docs.postiz.com/public-api/introduction)。

| 访问者             | 使用的地址                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| 用户浏览器         | `POSTIZ_PUBLIC_URL`                                                            |
| 本机原生 CLI       | `.env.postiz` 中 `POSTIZ_BASE_URL`，默认 `http://127.0.0.1:4007/api/public/v1` |
| Docker 中的 worker | Compose 强制使用 `http://postiz:5000/api/public/v1`                            |

这些地址不能混用。官方镜像内部 Nginx 监听 5000，并将 `/api/` 代理到后端 3000。
来源：[固定版本的 Nginx 配置](https://github.com/gitroomhq/postiz-app/blob/v2.24.0/var/docker/nginx.conf)。

X 应用密钥只传给 Postiz；模型密钥、可选 Firecrawl/GetXAPI 密钥只传给 worker。
Postiz API key 允许 worker 操作其组织数据，应按实际账号范围妥善保管。

## 5. 首次处理：先生成并提交草稿

将本地 `input.json` 示例替换为真实来源正文与 URL。若只想验证模型输出、尚未配置
Postiz key / integration，可先执行 `preview`：它不提交到 Postiz，但会使用真实模型、
消耗当天生成额度，并在 SQLite 中持久化相关记录；它不是不落盘的免费预览。
Docker 方式仍需要上面的基础服务配置；完全不运行 Postiz 时使用第 7 节原生 CLI。

```bash
bash deploy/postiz/compose.sh run --rm content-worker preview --input-json /app/content/input.json
```

`enqueue` 先持久化候选，不立即创建内容任务或调用模型/Postiz，但入队前必须填写
`POSTIZ_INTEGRATION_ID`。这个目标账号标识不是 API 密钥；真实账号归属按前面的
`integrations` 步骤核对。候选 ID 与后续内容任务 ID 是不同对象。让 worker 选择候选，
先只生成并保存本地结果：

```bash
bash deploy/postiz/compose.sh run --rm content-worker enqueue --input-json /app/content/input.json
bash deploy/postiz/compose.sh run --rm content-worker candidates
bash deploy/postiz/compose.sh run --rm content-worker work --once --no-submit
```

也可传入一个可抓取的网页 URL：

```bash
bash deploy/postiz/compose.sh run --rm content-worker enqueue --url "https://example.com/replace-with-real-source"
```

上面的 URL 需要替换。普通网页没有配置 Firecrawl 时使用直接正文提取；配置了
`FIRECRAWL_API_KEY` 才使用该服务。遇到登录墙、动态页面或提取不完整，可在只读
内容目录保存来源正文，并通过 `--url` 与 `--text-file /app/content/source.txt`
一起提交。来源仍作为外部资料处理，不能给 worker 下指令。

`work` 成功选择候选并生成任务后，使用它输出的本地任务 ID 检查结果。
候选被拒绝、等待选题复核或当天额度用尽时，不应假定已经有内容任务：

```bash
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
```

将 `JOB_ID` 替换为真实返回值。`--no-submit` 使检查通过的内容停在本地 `ready`，
此时先用 `show` 检查，尚无 Postiz ID 可供 `sync`。确认后提交并同步：

```bash
bash deploy/postiz/compose.sh run --rm content-worker submit --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID
```

没有 `--no-submit` 时，默认 `CONTENT_AUTO_SUBMIT=true` 将检查通过的普通任务
送入 **Postiz 草稿**。看到 draft / submitted 不能理解为 X 已公开发布。
在 Postiz 打开草稿检查来源、事实、语言和目标账号，再用其编辑日历排期。

### 候选与选题复核

手动导入和订阅发现都先进入持久化候选，再经过选题选择、合并和每日额度控制。
`candidates` 查看候选，`topics` 查看选题；这些 ID 与 `show --id` 接收的内容任务 ID
不同。等待复核的候选或选题不会因重复执行 `work` 就自动变成已批准内容。

```bash
bash deploy/postiz/compose.sh run --rm content-worker candidates
bash deploy/postiz/compose.sh run --rm content-worker topics
bash deploy/postiz/compose.sh run --rm content-worker retry-candidate --id CANDIDATE_ID --reason "已核对并补全原始来源，请重新评估"
bash deploy/postiz/compose.sh run --rm content-worker review-topic --id TOPIC_ID --decision approve --reason "已核对原文与事件日期，证据支持该选题"
```

替换真实 ID，并填写实际核对理由。`review-topic` 的 decision 可以是 `approve` 或
`reject`；批准选题后仍需等待正常生成流程和当日额度，不会立即公开发布。
仅当确认属于与历史记录不同的新事件时，才对 `retry-candidate` 添加
`--confirm-new-event`，并在 reason 中写明依据。它不是规避重复检测、额度或失败
核查的通用开关。内容任务的 `retry --id JOB_ID` 用于另一个阶段，不应用候选 ID 调用。

发现历史选题冲突时，直接 `approve` 会被拒绝。确认是同一事件后，可以明确合并：

```bash
bash deploy/postiz/compose.sh run --rm content-worker review-topic --id REVIEW_TOPIC_ID --decision approve --merge-with EXISTING_TOPIC_ID --reason "核对官方公告、产品与版本后确认是重复报道"
```

合并只补充选题的来源关联和审计记录，不修改原任务的输入、生成稿、回执，也不创建
第二份草稿。目标处于 `unknown` 或 `submitting` 时必须先对账。旧版本任务已有回执
或提交结果未知时，`--confirm-new-event` 同样不能解除冲突。明确不同版本、不同日期
的调价等事件保留独立选题；仅模型名称拼写差异不能作为新事件依据。

确认正常后启动长期 worker：

```bash
bash deploy/postiz/compose.sh --profile worker up -d content-worker
bash deploy/postiz/compose.sh logs --tail 100 content-worker
```

worker 以 `CONTENT_POLL_INTERVAL_MS`（默认 60 秒）作为本地队列循环间隔，
`CONTENT_MAX_JOBS_PER_TICK` 控制单轮处理上限。生成另受持久化每日额度约束：
`CONTENT_DAILY_GENERATION_LIMIT` 默认 3，只允许 1–3；`preview` 也消耗该额度。
`CONTENT_DAILY_TIMEZONE` 默认 `Asia/Shanghai`，按该时区划分日期。
重启容器不应被当成重置额度的方法。外部来源发现使用
独立的 `CONTENT_DISCOVERY_INTERVAL_MS`（默认 24 小时），不会每轮重新付费采集。
`CONTENT_SELECTION_BATCH_SIZE` 默认 20，控制单次候选选择批量；
`CONTENT_MAX_SOURCES_PER_TICK` 默认 5，控制每轮来源处理上限。
来源重试、手动 `discover` 和模型调用仍可能产生费用；每日生成额度不是所有外部
服务的统一费用上限。来源订阅使用可选的
`CONTENT_SOURCES_FILE`；Docker 中的值必须是 `/app/content/` 下的容器路径，例如
`/app/content/sources.json`，文件是 JSON 数组。默认 `sources.example.json` 是空数组，
不会触发付费采集。不配置订阅文件时，worker 处理手动入队的任务。
新鲜度在每个来源对象的 `maxAgeHours` 配置，例如 RSS 96、GetX 24；该窗口不自动
证明缺少发布日期的内容刚刚发布。

如需启用原来的 X 账号与关键词监控，审阅并复制
`config/postiz/sources.getx.example.json` 到自己的 `sources.json`，设置 `GETXAPI_TOKEN`
和 `CONTENT_SOURCES_FILE=/app/content/sources.json`。该文件使用 GetXAPI 两种读取源，
包含 OpenRouter、ooffooxx、LiteLLM 及通用模型/API 查询；每个源的窗口、页数和条数
可独立调整。主动执行 `discover` 同样会读取配置来源并可能产生费用。

更新 `.env.postiz` 后需要重新创建相关容器，单纯 `restart` 不会重新读取 Compose
环境变量：

```bash
bash deploy/postiz/compose.sh --profile worker up -d content-worker
```

修改 Postiz 域名或 X 应用密钥时，对 `postiz` 执行同样的 `up -d postiz`。

## 6. 在 Postiz 排期与核对不确定结果

本 CLI 的候选处理流程只创建草稿，不提供 `now` 即时发布，也不通过新的
`enqueue --schedule` / `--media` 绕过候选与选题管理。请在 Postiz 页面编辑媒体、
确认账号和最终内容，再明确安排发布时间。正常运行保持
`CONTENT_ALLOW_SCHEDULING=false`；不要把打开该开关理解为自动具备了排期策略。

Postiz 接收排期后，由它负责后续平台重试；本 worker 不同时维护另一套 X 发帖
定时器。已有草稿请在 Postiz 页面编辑，不要重新入队规避去重。

如果提交超时或结果未知，先在 Postiz 核对，不能直接重试创建。找到确定属于本
任务的 Postiz 帖子后，可以提供其 ID 对账：

```bash
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID --postiz-id POSTIZ_POST_ID
```

如果回执丢失后已在 Postiz 修改正文，普通对账会拒绝文案不一致。先在 Postiz 核对
账号、来源与草稿身份，再明确接受该已有记录并写下核对依据：

```bash
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID --postiz-id POSTIZ_POST_ID --accept-edited --reason "核对账号、原始来源和编辑记录，确认这是该任务的草稿"
```

此操作只绑定已有记录，保存核对理由、原始生成稿和观察到的修改稿；不会新建帖子。
目标必须属于原任务的 X integration，且不能已被另一任务绑定。

普通可重试的内容处理失败可以使用 `retry --id JOB_ID`；它不能取代未知外部写入
的核对。`sync` 中确认的 Postiz ID 与最终 X 帖子 ID 是两个不同字段。

需要修复尚未提交的失败任务时，可以显式刷新品牌快照并转为草稿：

```bash
bash deploy/postiz/compose.sh run --rm content-worker retry --id JOB_ID --refresh-brand --to-draft --reason "已修正品牌规则，重新生成后在 Postiz 审核"
bash deploy/postiz/compose.sh run --rm content-worker history --id JOB_ID
```

修复保留身份与去重键，保存修改前后记录，清除旧生成结果并重新消耗当日写作额度。
已提交、正在提交、结果未知以及已有平台回执的任务不能通过该入口重新创建。
关闭排期开关时，历史排期任务也会被拦截，需要显式转为草稿。

### 运行汇总与人工反馈

```bash
bash deploy/postiz/compose.sh run --rm content-worker status
bash deploy/postiz/compose.sh run --rm content-worker feedback --id JOB_ID --kind edit --reason "删除泛泛而谈的开场，保留一个具体 API 用法" --actor operator
bash deploy/postiz/compose.sh run --rm content-worker feedback --id JOB_ID --kind reject --reason "来源不足以支持性能结论"
bash deploy/postiz/compose.sh run --rm content-worker history
```

`status` 不调用模型或 Postiz，也不更改内容任务。它读取当前数据库，提供上海日期下的
候选数、写作启动数、额度余额、生成请求和筛选请求次数、草稿与发布状态、失败原因、
来源检查点及人工反馈。`history` 不带 ID 时查看品牌的最近审计记录。

写作启动包含 `preview`、失败和显式重试；模型请求开始次数另外记录，不等于成功响应数、
token 数或费用。`firstObservedDrafts` 表示今天首次观察到的草稿，可能包括今天才同步的
旧草稿，不能当作今天新建数量。查询达到保护性上限时，汇总会明确标记数据不完整。

同步保留原始生成稿和观察到的 Postiz 正文快照；连续相同快照不重复保存，修改后改回
原文仍保留中间版本。`edited` 只代表观察稿与生成稿不同，不能推断具体是谁修改。
worker 不将生成稿写回覆盖 Postiz 编辑。自动对账包含远期排期；未找到远端
记录不代表发布失败，也不会触发重新创建。
配置了 Postiz API key 后，即使 `CONTENT_AUTO_SUBMIT=false` 或使用 `work --no-submit`，
worker 仍会同步已经提交的任务；创建开关不再阻止改稿、排期与最终回执的读取。

反馈类型为 `edit`、`reject` 或 `note`，只形成供人工复盘的原因记录和汇总，不自动修改
品牌规则，不代替 Postiz 中的删除、修改或排期。经操作者确认后再编辑品牌 JSON。
互动数据继续在官方 Postiz 分析页面查看，worker 不假定当前 X 权限提供了哪些指标。

## 7. 不使用 Docker 运行内容 worker

Postiz 可以在另一台服务器运行官方镜像，内容 worker 在有 Node 24 的环境运行。
使用同一份 `.env.postiz` 时，要将 `POSTIZ_BASE_URL` 改成可访问的 API 地址，
`CONTENT_BRAND_FILE` / `CONTENT_SOURCES_FILE` / `CONTENT_DB_PATH` 改成本机路径。

```bash
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile --ignore-scripts
yarn postiz:check
yarn postiz:build
node --env-file=.env.postiz dist-postiz/src/postiz/cli.js integrations
node --env-file=.env.postiz dist-postiz/src/postiz/cli.js work --once
```

开发时也可运行 `node --env-file=.env.postiz --import tsx src/postiz/cli.ts`，后接
相同命令。`yarn postiz:cli` 与 `yarn postiz:worker` 使用相同入口，默认读取
`.env.postiz`，或通过 `CONTENT_ENV_FILE` 选择其他文件。这里显式使用 `--env-file`，
使加载位置清楚。只验证模型、不连接 Postiz 时，可执行：

```bash
node --env-file=.env.postiz dist-postiz/src/postiz/cli.js preview --input-json deploy/postiz/private/content/input.json
```

## 8. 持久化、备份与恢复

worker 以非 root 用户 `1000:1000` 运行，根文件系统只读，只能写入 `/data` 和
临时目录。新 `content-data` 卷从镜像中归属于 node 的目录初始化。恢复旧备份后
若卷属于其他 UID，应先修复该卷所有权，再启动 worker，不要改成 root 常驻运行。

备份需要覆盖三个部分：本地未提交的配置/密钥；worker 的完整数据卷；官方
Postiz 的数据库、Temporal 数据及配置/上传文件卷。SQLite 使用 WAL 时，不要在
运行期间只复制一个 `.sqlite` 文件。可在维护窗口停止 worker 后，导出完整卷：

```bash
mkdir -p deploy/postiz/backups
bash deploy/postiz/compose.sh stop content-worker
bash deploy/postiz/compose.sh run --rm --no-deps --entrypoint tar content-worker -czf - -C /data . > deploy/postiz/backups/content-data.tar.gz
```

使用不同文件名保留多版备份。Postiz PostgreSQL 与 Temporal PostgreSQL 分别备份；
在一致的维护窗口或使用数据库原生备份方案处理，不能只备份 worker 后就认为
社交账号令牌和已排期任务也已保存。备份中可能含令牌与业务资料，不能提交 Git。

停止 worker **不会取消已经交给 Postiz 的排期**。需要暂停公开发布时，应在
Postiz 管理对应排期。普通 `compose down` 保留具名卷；不要把删除卷当作重启或升级。
升级时一起审查固定 Compose commit、镜像 tag/digest 与官方迁移说明，详见
[UPSTREAM.md](../deploy/postiz/UPSTREAM.md)。

## 9. 检查范围与排错

| 现象                               | 先检查                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| Compose 要求填写密码               | `.env.postiz` 中四个独立 secret；不能留空或只修改 `.example`        |
| 提示 `!override` / `!reset` 不识别 | Docker Compose 至少 2.24.4，使用 `docker compose` v2                |
| dynamicconfig 不存在               | 运行完整 bootstrap；不要单独下载官方 YAML                           |
| worker 连接不到 Postiz             | 使用内部 `postiz:5000/api/public/v1`，检查 Postiz/Temporal 健康状态 |
| 401 / 403                          | API key 是否来自正确组织；目标 integration 是否属于该组织           |
| 品牌配置缺失或无权限               | `CONTENT_CONFIG_DIR` 实际目录是否存在；文件是否允许 UID 1000 读取   |
| SQLite 无法写入                    | `/data` 持久卷所有权、剩余空间、是否误用只读挂载                    |
| X 授权失败                         | 公开域名与回调一致、Consumer Key/Secret、X 应用当前读写能力         |
| Postiz 收到草稿但未发出            | 草稿是默认结果；确认是否已在 Postiz 明确排期                        |
| worker 已停，X 仍然发帖            | 该任务可能早已交给 Postiz 排期，去 Postiz 查看                      |

无真实 API key 的类型检查、fixture/mock 测试和配置检查只能证明对应本地行为。
它们不能证明实际镜像已启动、模型响应质量、X 授权能力或真实发帖已成功。
上线验收依次检查：完整 Compose 健康状态 → integrations 读取 → 一条真实来源
生成 → Postiz 草稿可见 → 状态同步；真实排期测试应使用明确选定的账号、内容和时间。

## 实现范围

本 PR 提供网页/RSS/Atom/GetXAPI/JSON 来源、候选与选题管理、品牌相关性判断、研究报告、单帖写作、质量复审和 Postiz 草稿对接。生成工作流复用上游抽出的报告与写作 Prompt，并使用开源 LangGraph 库运行。尚未移植上游的视频理解、AI 生图、线程规划和效果驱动的策略学习。

来源 URL（X 帖子按 status ID）去重与选题去重是不同层次。相似内容不能总被确定为同一事件，保守阻断和人工复核仍有必要。更改品牌规则不会自动重新生成已有来源；使用 `show --id` 查看生成时保存的品牌快照。抓取或模型失败后可按任务状态显式 `retry`；进程崩溃恢复仍可能再次消耗模型调用，不能据此保证外部 API 零费用或零错误。

单条内容生成可能多次调用模型。外部来源是证据材料，模型质量复审也不是独立事实证明；先检查草稿效果，再决定是否在 Postiz 排期。

本次已完成的测试、明确未验证的范围、复现命令及部署后最小验收见 [验证记录](POSTIZ-VALIDATION.md)。

独立 Linux 主机、HTTPS、真实服务联调及 7 天草稿试运行的操作步骤和待填写记录见
[上线与试运行方案](POSTIZ-PILOT.md)。这份方案不代表已部署、已使用真实密钥或已完成 7 天运行。
