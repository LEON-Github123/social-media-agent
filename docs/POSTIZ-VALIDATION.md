# Postiz 内容 worker：验证记录与上线验收

记录日期：2026-09-24。本记录对应本次 PR 的工作区验证；后续代码、依赖、镜像或配置变更后，应重新执行相关检查。

## 已完成的验证

| 项目                       | 本次结果                             | 结果能说明什么                                                                                                           |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 新 worker 的 Node 测试     | **73 / 73 通过，0 跳过**             | 已覆盖测试所定义的正常流程、失败路径与输入边界                                                                           |
| 本地 HTTP 端到端测试       | 通过，包含在上述 73 项中             | 启动 CLI 子进程，访问本地模型和 Postiz mock HTTP 服务，完成入队、生成、草稿提交、同步与重复运行检查                      |
| SQLite 状态与并发          | 通过，使用真实 SQLite 文件与两个连接 | 覆盖任务抢占、持久化、租约、品牌隔离、未知提交结果与恢复边界                                                             |
| worker 类型检查            | 通过                                 | `tsconfig.postiz.json` 所覆盖代码的类型检查通过                                                                          |
| worker 编译与编译后入口    | 通过                                 | 编译生成 `dist-postiz`，编译后的 CLI 能输出 `--help`                                                                     |
| 原仓库 TypeScript 检查     | `tsc --noEmit` 通过                  | 原仓库当前 TypeScript 配置所覆盖内容没有报告类型错误                                                                     |
| 改动的生产 TypeScript 文件 | ESLint 通过                          | 本次 worker 与共享 Prompt 改动通过所运行的 lint 检查                                                                     |
| 官方 Compose bootstrap     | 完整检出成功                         | 固定提交 `dd4969e5e694cd009619a0d53cff14c21104580b` 的完整目录可取得，包含官方 YAML、LICENSE 和两个 `dynamicconfig` 文件 |

测试覆盖的边界包括：来源 URL 与重定向检查、正文/文件大小、无效 UTF-8、无效模型输出、证据链接和 X 加权长度、错误账号、排期时间、重复来源、明确拒绝与未知提交结果。具体断言以 `src/postiz/tests/*.node-test.ts` 为准。

本地 HTTP 测试确实经过 HTTP 请求与 CLI 子进程，但服务响应由测试固定提供。SQLite 测试确实使用数据库文件，但不能据此推断所有生产负载与故障组合都已覆盖。

## 尚未完成的验证

- 当前环境 **Docker Engine 不可用**，没有构建内容 worker 镜像，也没有启动真实的 Postiz / Temporal Docker 栈。
- 没有使用真实模型、Postiz 或 X 密钥执行本次测试，也没有向 X 发帖。
- 模型内容质量仍需使用真实品牌资料和真实来源试跑。Schema、长度和复审流程通过，不等于所有事实和文案质量自动得到保证。
- 没有运行原仓库全部旧测试。全仓类型检查通过不能替代旧工作流的单元、集成或端到端测试。
- 没有据此验证生产环境的 X 授权能力、额度、模型/采集费用、长时间运行或实际 Docker 卷恢复。

因此，本次结果支持继续进行真实环境的分步验收，不能称为 Docker 已部署成功、生产全量回归通过或真实发布闭环已验证。

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
yarn eslint src/postiz/*.ts \
  src/agents/generate-post/nodes/prompt-core.ts \
  src/agents/generate-post/nodes/generate-post/prompts.ts \
  src/agents/generate-post/nodes/generate-report/prompts.ts
```

独立重跑本地 HTTP 端到端与配置测试：

```bash
node --import tsx --test src/postiz/tests/cli.node-test.ts
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

### 3. 验证持久化、草稿提交与同步

```bash
bash deploy/postiz/compose.sh run --rm content-worker enqueue --input-json /app/content/input.json
bash deploy/postiz/compose.sh run --rm content-worker work --once --no-submit
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker submit --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID
```

将 `JOB_ID` 替换为入队返回值。检查本地任务先到 `ready`，提交后在正确 Postiz 账号下出现一份草稿，保存了 Postiz ID。此时未公开发布就应保留空的平台帖子 ID。

再次用相同输入入队并处理，检查任务 ID 与 Postiz 草稿没有重复。重新创建 worker 容器后再运行 `show`，确认具名卷中的任务记录仍可读取。这个小规模复核用于验证实际部署的持久化与去重，不是对所有异常情况作保证。

### 4. 单独验收一次真实排期

仅在账号、最终文案和未来时间已明确选定后，在 Postiz 页面给上述草稿排期。到时检查 X 上的实际帖子，再同步任务，核对最终平台 ID / URL。

如果需要从 CLI 测试排期，使用一条新的、明确选定的来源，并在 `enqueue` 时传 `--schedule`；不要把已经存在的草稿重新入队。遇到提交结果未知，先在 Postiz 核对，不能直接重复创建。

完成后记录实际服务版本、任务 ID、Postiz ID、平台 ID、执行时间及异常。只有这些真实验收完成的部分，才应更新为已验证。
