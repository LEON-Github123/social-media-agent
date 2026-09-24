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
Postiz key / integration，可先执行 `preview`：它不会入队或调用 Postiz。
Docker 方式仍需要上面的基础服务配置；完全不运行 Postiz 时使用第 7 节原生 CLI。

```bash
bash deploy/postiz/compose.sh run --rm content-worker preview --input-json /app/content/input.json
```

设置好 `POSTIZ_INTEGRATION_ID` 后再入队，先只生成并保存本地结果：

```bash
bash deploy/postiz/compose.sh run --rm content-worker enqueue --input-json /app/content/input.json
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

运行返回本地任务 ID 后，可检查结果或同步 Postiz 状态：

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

确认正常后启动长期 worker：

```bash
bash deploy/postiz/compose.sh --profile worker up -d content-worker
bash deploy/postiz/compose.sh logs --tail 100 content-worker
```

worker 每轮分别最多生成、提交 `CONTENT_MAX_JOBS_PER_TICK` 个任务，以
`CONTENT_POLL_INTERVAL_MS`（默认 60 秒）作为本地队列循环间隔。外部来源发现使用
独立的 `CONTENT_DISCOVERY_INTERVAL_MS`（默认 24 小时），不会每轮重新付费采集。
该发现时钟目前保存在进程内，重启 worker 或另开 `work --once` 会重新检查一次
来源；持久化去重避免重复生成/提交，但不能避免这次外部读取费用。来源订阅使用可选的
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

## 6. 明确排期与不确定结果

本 CLI 不提供 `now` 即时发布模式。若要在 CLI 创建新的排期任务，必须在
**enqueue 时**显式传入未来 UTC 时间；之后的 `submit` 沿用入队时的模式：

```text
bash deploy/postiz/compose.sh run --rm content-worker enqueue --input-json /app/content/input.json --schedule "YYYY-MM-DDTHH:mm:ssZ"
bash deploy/postiz/compose.sh run --rm content-worker work --once --no-submit
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker submit --id JOB_ID
```

替换 ID 和时间。只有使用带 `--schedule` 的新任务才会进入真实排期；默认自动
提交也会按该任务已明确的 schedule 执行。已经存在 Postiz 草稿的任务请在 Postiz
页面编辑排期，`submit` 不接受 `--schedule`，也不要重新入队规避去重。
Postiz 接收排期后，由它负责后续
平台重试；本 worker 不同时维护另一套 X 发帖定时器。

如果提交超时或结果未知，先在 Postiz 核对，不能直接重试创建。找到确定属于本
任务的 Postiz 帖子后，可以提供其 ID 对账：

```bash
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID --postiz-id POSTIZ_POST_ID
```

普通可重试的内容处理失败可以使用 `retry --id JOB_ID`；它不能取代未知外部写入
的核对。`sync` 中确认的 Postiz ID 与最终 X 帖子 ID 是两个不同字段。

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

本 PR 提供网页/RSS/Atom/GetXAPI/JSON 来源、品牌相关性判断、研究报告、单帖写作、质量复审和 Postiz 草稿/排期对接。生成工作流复用上游抽出的报告与写作 Prompt，并使用开源 LangGraph 库运行。尚未移植上游的跨选题语义聚类、视频理解、AI 生图、线程规划和效果驱动的策略学习。单条任务可手工提供多个来源作为证据。

来源去重按品牌、目标账号、来源 URL（X 帖子按 status ID）进行，不等于跨不同 URL 的事件语义去重。更改品牌规则不会自动重新生成已有来源；使用 `show --id` 查看当时保存的品牌快照。抓取或模型失败后可显式 `retry`；进程崩溃发生在生成期间，租约过期后从该任务重新生成，可能再次消耗模型调用，已提交的 Postiz 任务不会因此重发。

默认每条通过的内容最多调用模型四次。外部来源是证据材料，模型质量复审也不是独立事实证明；建议先检查草稿效果再扩大自动排期。

本次已完成的测试、明确未验证的范围、复现命令及部署后最小验收见 [验证记录](POSTIZ-VALIDATION.md)。
