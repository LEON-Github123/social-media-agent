# Postiz 内容 worker：验证记录与上线验收

记录日期：2026-09-24。实现提交 `073a1b63b0f5f75f894ee8ba27ca8e21fd809c00` 的本地和 GitHub worker 回归均为 **195 / 195 通过，0 跳过**。该提交的 CI、Unit Tests、Postiz content worker 三个工作流全部成功，包含真实 worker 容器和固定官方 Postiz 完整服务栈启动。代码、依赖、镜像或配置变更后，应重新执行相关检查；本页后续的文档更新不改变这些结果对应的实现提交。

## 已完成的验证

### 补充的恢复边界回归

本轮在三批实现之上补充品牌与 X integration 的持久绑定（数据库版本 5，升级前备份），
防止更改配置后将历史候选或任务交给另一个账号。首次绑定核对已有任务；旧版只有候选
没有任务的数据不包含账号身份，升级前须按部署说明核对配置。

未知提交支持在核对已有 Postiz ID 后，用 `--accept-edited --reason` 接受人工改稿，
保留原稿、观察稿和对账前后审计；同一远端记录不能绑定到两份任务。关闭自动提交时，
有 API key 的 worker 仍同步已提交任务；远期排期也包含在同步范围内。

新增和扩展回归覆盖账号切换、双连接并发绑定、v4 升级备份、修改稿对账与账号拒绝、
不自动提交时继续同步、800 天后的排期，并修正 Windows 下测试数据库连接的关闭顺序。
最新代码的完整自动验证以 [PR Checks](https://github.com/LEON-Github123/social-media-agent/pull/1/checks)
对应提交的结果为准；下面 195 项记录对应此前三批实现，不代表真实模型或 X 验收。

| 项目                    | 本次结果                                   | 结果能说明什么                                                                                                                     |
| ----------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 新 worker 的 Node 测试  | **195 / 195 通过**                         | 已覆盖三批代码所定义的正常流程、失败路径、状态与统计边界                                                                           |
| 本地 HTTP 端到端测试    | 通过，包含在上述 195 项中                  | CLI 子进程通过本地模型/Postiz mock HTTP 完成候选 → 选题 → 生成 → 草稿 → 同步；验证重启无重复请求、每日额度、人工反馈和远端正文变化 |
| SQLite 状态与并发       | 通过，使用真实 SQLite 文件、多个连接和进程 | 覆盖版本迁移、旧数据保留、来源检查点/退避重启恢复、候选/选题持久化、五进程争抢每日最多三次额度、租约和未知提交隔离                 |
| 运营报告与人工反馈      | 通过，包含在上述 195 项中                  | 分开本地状态与 Postiz 回执、生成尝试与模型调用；保留原始输出，按最近一次匹配回执观察正文修改，验证时区日界线和人工理由记录         |
| worker 类型检查         | 通过                                       | `tsconfig.postiz.json` 所覆盖代码的类型检查通过                                                                                    |
| worker 编译与编译后入口 | 通过                                       | 编译生成 `dist-postiz`，编译后的 CLI 能输出 `--help`                                                                               |
| 原仓库 TypeScript 检查  | `tsc --noEmit` 通过                        | 原仓库当前 TypeScript 配置所覆盖内容没有报告类型错误                                                                               |
| 全仓 lint 与图路径检查  | 通过                                       | 包含新增测试文件；保留原有检查规则。上游 8 条 unused-disable 警告不导致失败                                                        |
| 官方 Compose bootstrap  | 完整检出成功                               | 固定提交 `dd4969e5e694cd009619a0d53cff14c21104580b` 的完整目录可取得，包含官方 YAML、LICENSE 和两个 `dynamicconfig` 文件           |

测试覆盖的边界还包括：来源 URL 与重定向、正文/文件大小、无效 UTF-8、输入与品牌共用校验、无效模型输出、证据链接和 X 加权长度、错误账号、默认禁排期、旧新闻与未知日期、同一事件多来源合并、历史选题冲突的人工复核、来源错误隔离、明确拒绝与未知提交结果。具体断言以 `src/postiz/tests/*.node-test.ts` 为准。

本地 HTTP 测试确实经过 HTTP 请求与 CLI 子进程，但服务响应由测试固定提供。SQLite 测试确实使用数据库文件，但不能据此推断所有生产负载与故障组合都已覆盖。

## GitHub CI

第三批实现提交 `073a1b6` 的 [Postiz content worker](https://github.com/LEON-Github123/social-media-agent/actions/runs/35988153460)、[CI：lint、格式与拼写](https://github.com/LEON-Github123/social-media-agent/actions/runs/35988153403) 和 [原仓库 Unit Tests](https://github.com/LEON-Github123/social-media-agent/actions/runs/35988153431) 已全部通过。

第二批提交也已通过 [Postiz worker 检查](https://github.com/LEON-Github123/social-media-agent/actions/runs/35986736764)、[Lint 检查](https://github.com/LEON-Github123/social-media-agent/actions/runs/35986736753) 和 [原仓库 Unit Tests](https://github.com/LEON-Github123/social-media-agent/actions/runs/35986736737)。

PR 的 `Postiz content worker` 工作流还增加了实际 Docker 构建和容器验证：检查编译入口，以非 root 用户在只读根文件系统、无网络的容器中入队，再创建新容器检查具名卷持久化和去重。它只使用公开示例数据，不需要业务密钥，也不调用发布服务。各次提交的实际执行结果见 [PR Checks](https://github.com/LEON-Github123/social-media-agent/pull/1/checks)，新增检查在完成前不能视为通过。

### 本轮新增的固定全栈检查

工作流已补 `main` 分支 push 触发，并将环境变量示例、部署文件及 `docs/POSTIZ-*.md` 纳入路径过滤。PR 和手动执行也保留。新增独立 `stack` job，运行 [test-stack.sh](../deploy/postiz/test-stack.sh)；该检查已在上述实现提交上实际执行通过。

该检查的范围是：

- 完整 bootstrap 固定官方 Compose commit，验证合并配置、Postiz 镜像 digest、Temporal 配置挂载、私有依赖端口和 worker 权限。
- 使用随机且相互独立的测试 secret、独立项目/卷/镜像标签和空来源配置，启动 Postiz、两套 PostgreSQL、Redis、Temporal、Elasticsearch 和空队列 worker。
- 最多等待 10 分钟服务健康，再有限等待真实前端/API 和 Temporal `default` namespace。检查固定版本中的 frontend、backend、orchestrator 进程在线。
- 检查真实前端可访问、未经认证的 Public API 请求被拒绝、worker 能经内部 Docker 地址访问该 API，并以非 root 用户读取 SQLite。
- 不使用模型、Postiz 或 X 业务密钥，不创建社交账号连接，不调用模型或公开发布。可选 Temporal UI、管理工具和 Spotlight 不属于本次运行所需服务。
- 失败时仅上传脱敏后的状态、服务和启动诊断，保留 7 天；不上传 `.env`、合并后的完整配置、完整容器 inspect、PM2 环境 JSON 或数据库。退出时清理本测试随机项目的卷和临时 worker 镜像。

| 本轮检查                               | 实际 run URL / 提交                                                                                          | 结果                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 第二批 worker、Lint、原仓库 Unit Tests | 上述三个第二批 run                                                                                           | 已通过                                               |
| 第三批本地 Node 回归、编译与 CLI 入口  | `073a1b6`                                                                                                    | 195 / 195；编译和入口检查通过                        |
| 第三批 GitHub worker 与容器验证        | [worker job](https://github.com/LEON-Github123/social-media-agent/actions/runs/35988153460/job/107595591958) | 通过；195 项测试、镜像构建、非 root 持久化与重启去重 |
| 固定官方 Postiz + Temporal 全栈启动    | [stack job](https://github.com/LEON-Github123/social-media-agent/actions/runs/35988153460/job/107595592175)  | 通过；真实容器启动与内部连通性                       |
| 独立 Linux HTTPS 与真实密钥联调        | 见试运行记录                                                                                                 | 未执行                                               |
| 连续 7 天草稿试运行                    | 见试运行记录                                                                                                 | 未执行                                               |

全栈日志显示：10:36:03 UTC 合并配置通过；10:41:17 Postiz、两套 PostgreSQL、Redis、Temporal 和 Elasticsearch 健康；10:41:31 前端、后端、orchestrator 在线，真实 Public API 拒绝未认证请求；10:41:32 非 root worker 能读取 SQLite 并通过私网访问 Postiz；10:41:39 完整检查通过。随后清理隔离项目，job 成功结束。本地执行环境没有 Docker Engine，实际容器证据来自上述 GitHub Linux runner。

## 尚未完成的验证

- 用户的独立 Linux 主机、HTTPS 域名和真实账号仍待配置。GitHub 的隔离全栈测试不能替代该业务环境验收。
- 没有使用真实模型、Postiz 或 X 密钥执行本次测试，也没有向 X 发帖。
- 模型内容质量仍需使用真实品牌资料和真实来源试跑。Schema、长度和复审流程通过，不等于所有事实和文案质量自动得到保证。
- 原仓库 Unit Tests 已由 GitHub 执行；需要真实服务的旧工作流集成测试、生产端到端测试仍未执行。
- 没有据此验证生产环境的 X 授权能力、额度、模型/采集费用、长时间运行或实际 Docker 卷恢复。

因此，本次结果支持继续进行真实环境的分步验收，不能据此声称用户的云主机已上线、生产全量回归通过或真实发布闭环已验证。

## 可复现命令

在仓库根目录使用 Node 24 和 Yarn 1.22.22。以下软件检查不需要真实业务密钥；测试中的模型和 Postiz 服务使用本地测试响应。

```bash
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile --ignore-scripts

yarn postiz:check
yarn postiz:test
yarn postiz:build
node dist-postiz/src/postiz/cli.js --help

yarn tsc --noEmit
yarn lint:all
```

独立重跑本地 HTTP 端到端与配置测试：

```bash
node --import tsx --test src/postiz/tests/cli.node-test.ts
```

独立重跑真实 SQLite、来源恢复及运营统计相关测试：

```bash
node --import tsx --test src/postiz/tests/store.node-test.ts src/postiz/tests/operations-store.node-test.ts src/postiz/tests/collector.node-test.ts src/postiz/tests/reports.node-test.ts
```

验证官方部署输入需要访问 GitHub，但不需要 Docker 或业务密钥：

```bash
bash deploy/postiz/bootstrap.sh
git -C deploy/postiz/upstream rev-parse HEAD
git -C deploy/postiz/upstream diff --quiet HEAD --
test -f deploy/postiz/upstream/docker-compose.yaml
test -f deploy/postiz/upstream/dynamicconfig/development-sql.yaml
test -f deploy/postiz/upstream/dynamicconfig/development-cass.yaml
test -f deploy/postiz/upstream/LICENSE
```

预期 HEAD 为 `dd4969e5e694cd009619a0d53cff14c21104580b`。bootstrap 对已存在的正确检出执行验证，不会覆盖被修改的上游文件。版本出处与镜像固定信息见 [UPSTREAM.md](../deploy/postiz/UPSTREAM.md)。

在有 Docker Engine、Compose 2.24.4+、Git 和 Python 3 的 Linux CI runner 或开发环境重跑全栈检查：

```bash
bash deploy/postiz/test-stack.sh
```

这个命令会拉取官方镜像、构建 worker、启动隔离临时服务并在结束时删除其临时数据卷。它不读取本地 `.env.postiz` 或业务资料；基础服务密码由脚本生成，worker 使用空来源、禁排期和禁自动提交配置。失败时输出脱敏诊断目录。GitHub runner 会在运行前设置 Elasticsearch 所需的 `vm.max_map_count=262144`。

全栈通过只证明这次固定版本在该 runner 上完成了所列启动和连通性检查。API 返回 401/403 是未认证请求的预期结果，不能据此声称真实 API key、X 授权、模型内容或发布已验证。

## 部署后最小验收

先按 [安装文档](POSTIZ-SETUP.md) 配置真实域名、独立随机 secret、品牌资料和所需服务密钥。以下是待在部署环境执行的验收步骤，不是本次已经完成的操作。

### 1. 验证真实容器和内部连接

```bash
bash deploy/postiz/compose.sh config --quiet
bash deploy/postiz/compose.sh build content-worker
bash deploy/postiz/compose.sh up -d postiz
bash deploy/postiz/compose.sh ps
bash deploy/postiz/compose.sh run --rm content-worker integrations
```

确认依赖服务健康，自己的 HTTPS 域名可访问，返回的 integration 是目标 X 账号。此步骤同时验证当前机器上的构建依赖、官方镜像启动和内部 API 地址；不要只以容器进程存在作为通过依据。

### 2. 验证真实模型和一条可核查的来源

把一条真实来源的正文与 URL 写入自己的 `/app/content/input.json`，先生成预览：

```bash
bash deploy/postiz/compose.sh run --rm content-worker preview --input-json /app/content/input.json
```

检查品牌匹配、来源归因、时效、语言和具体事实。缺少自有测试证据时，文案不能声称“我们测试过”。不通过时先调整资料或规则，不扩大自动处理数量。

`preview` 也会消耗每日生成额度，并写入 SQLite。若当天额度已耗尽，应等待配置时区的下一天或使用已有结果检查，不能通过删除数据库规避额度。

### 3. 验证持久化、草稿提交与同步

```bash
bash deploy/postiz/compose.sh run --rm content-worker enqueue --input-json /app/content/input.json
bash deploy/postiz/compose.sh run --rm content-worker candidates
bash deploy/postiz/compose.sh run --rm content-worker work --once --no-submit
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker submit --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID
```

`enqueue` 返回候选信息，不是内容任务。将 `JOB_ID` 替换为 `work` 选择候选并生成后返回的任务 ID；候选被拒绝、待复核或额度耗尽时，先处理对应状态。检查本地任务先到 `ready`，提交后在正确 Postiz 账号下出现一份草稿，保存了 Postiz ID。此时未公开发布就应保留空的平台帖子 ID。

再次用相同输入入队并处理，检查任务 ID 与 Postiz 草稿没有重复。重新创建 worker 容器后再运行 `show`，确认具名卷中的任务记录仍可读取。这个小规模复核用于验证实际部署的持久化与去重，不是对所有异常情况作保证。

### 4. 单独验收一次真实排期

仅在账号、最终文案和未来时间已明确选定后，在 Postiz 页面给上述草稿排期。到时检查 X 上的实际帖子，再同步任务，核对最终平台 ID / URL。

正常运行保持 `CONTENT_ALLOW_SCHEDULING=false`，排期和媒体编辑在 Postiz 页面操作；不要把已经存在的草稿重新入队。遇到提交结果未知，先在 Postiz 核对，不能直接重复创建。

完成后记录实际服务版本、任务 ID、Postiz ID、平台 ID、执行时间及异常。只有这些真实验收完成的部分，才应更新为已验证。

独立 Linux、HTTPS、真实密钥联调的执行前条件和 7 天逐日记录模板见 [上线与试运行方案](POSTIZ-PILOT.md)。当前这些项目均不能标记为已完成。

日常先用 `status` 查看本地汇总、`history --id JOB_ID` 查看审计记录；人工改稿或拒稿后，使用 `feedback --id JOB_ID --kind edit|reject|note --reason TEXT` 保存理由。三种 kind 需选择一种；反馈不会自动编辑或取消 Postiz 中的内容。完整命令及真实素材待验收矩阵见试运行方案。
