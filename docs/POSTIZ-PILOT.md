# 独立 Linux 部署、真实服务联调与 7 天试运行

本文件是待执行的操作方案和记录模板，不是上线成功记录。当前不包含已购买的云主机、已配置的 HTTPS 域名、真实服务密钥或 7 天运行数据。GitHub CI 的临时容器测试不能替代这些验收。

本轮使用现有 Linux + Docker Compose 方案。业务代码只维护本 SMA Fork；Postiz 使用固定官方镜像和官方 Compose，不另建 Postiz Fork，也不改造为 Railway 部署。

## 1. 上线前填写环境记录

只记录版本、资源、域名和结果，不把密钥、完整环境文件、数据库或含业务正文的原始日志贴进公开 Issue、PR 或 CI artifact。

| 项目                                     | 待填写内容                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| 执行人、开始时间、验收时区               | 待填写                                                                               |
| Linux 主机、CPU / 内存 / 可用磁盘        | 待填写；确认能运行 Postiz、两套 PostgreSQL、Redis、Temporal、Elasticsearch 和 worker |
| 仓库 commit                              | `git rev-parse HEAD` 的结果                                                          |
| 官方 Compose commit                      | `dd4969e5e694cd009619a0d53cff14c21104580b`；实际结果应一致                           |
| Postiz 镜像                              | 当前配置为 `v2.24.0`，具体 digest 见 [UPSTREAM.md](../deploy/postiz/UPSTREAM.md)     |
| Node / Docker / Compose 版本             | Node 由 worker 镜像提供；Compose 至少 2.24.4                                         |
| HTTPS 域名、证书到期日、代理配置         | 待填写；域名须与 `POSTIZ_PUBLIC_URL` 一致                                            |
| Postiz 组织、目标 X 账号、integration ID | 待填写；不要记录 API key                                                             |
| 模型供应商与模型名、来源服务             | 待填写；不要记录 API key                                                             |
| 备份位置、保留期、恢复执行人             | 待填写；备份不能放进公开仓库                                                         |
| 已通过的 GitHub Actions run              | 待填写实际 run URL，不能只填写工作流文件名                                           |

按照 [安装文档](POSTIZ-SETUP.md) 创建 `.env.postiz` 和私有内容目录，独立生成四个随机 secret。保持数据库、Redis、Elasticsearch 和 Temporal 的宿主端口关闭。宿主 HTTPS 代理转发到 `127.0.0.1:4007`，只开放实际需要的 SSH、HTTP 和 HTTPS 入口。

本方案不提供已经完成的云主机采购、DNS 变更、证书签发或远端发布。部署执行人需要先提供这些运行条件。

## 2. 先验证固定服务栈

在待部署 Linux 主机的仓库根目录执行：

```bash
git rev-parse HEAD
docker version
docker compose version
bash deploy/postiz/bootstrap.sh
bash deploy/postiz/compose.sh config --quiet
bash deploy/postiz/compose.sh build content-worker
bash deploy/postiz/compose.sh up --detach --wait --wait-timeout 600 postiz
bash deploy/postiz/compose.sh ps
```

检查 Postiz、两套 PostgreSQL、Redis、Temporal 和 Elasticsearch 全部健康。若 Elasticsearch 提示 `vm.max_map_count` 不足，由主机管理员按其报错调整宿主内核参数；CI 使用 `262144`。不要用反复删除数据卷来解决启动错误。

将下方示例地址替换为自己的域名；不要使用跳过证书校验的参数掩盖 HTTPS 问题：

```bash
curl --fail --silent --show-error --location --output /dev/null \
  --write-out '%{http_code}\n' https://postiz.example.com
```

确认浏览器访问正常、证书可信，完成首次注册和目标 X 账号连接。X 回调地址要与实际公开域名一致。获取自己组织的 Public API key 后填写私有环境文件，再检查：

```bash
bash deploy/postiz/compose.sh run --rm content-worker integrations
```

**通过条件：** 上述结果明确返回目标账号，且所用 integration ID 属于预期组织和账号。仅看到容器处于 running 状态，不算真实 API 认证通过。

## 3. 联调一条真实内容，先停在草稿

试运行保持 `CONTENT_ALLOW_SCHEDULING=false`。普通任务可自动提交为 Postiz 草稿；`CONTENT_AUTO_SUBMIT=false` 则只生成本地待提交内容。两者含义不同：关闭自动提交不等于取消已经交给 Postiz 的排期。

开始时只启用少量已经审查过的来源，并将每日生成额度设为 1，观察稳定后再调至 2 或 3。配置项和默认值如下：

| 配置                             | 试运行设置         | 含义                                                      |
| -------------------------------- | ------------------ | --------------------------------------------------------- |
| `CONTENT_ALLOW_SCHEDULING`       | `false`            | 禁止本 worker 创建排期；Postiz 页面中的既有排期需另行管理 |
| `CONTENT_DAILY_GENERATION_LIMIT` | 首日 `1`；最多 `3` | 每日生成额度，不是每轮轮询额度                            |
| `CONTENT_DAILY_TIMEZONE`         | `Asia/Shanghai`    | 按这个时区划分额度日期，记录中也采用相同时区              |
| `CONTENT_SELECTION_BATCH_SIZE`   | `20`               | 单次候选选择批量，上限 20                                 |
| `CONTENT_MAX_SOURCES_PER_TICK`   | `5`                | 每轮来源处理上限                                          |
| `CONTENT_AUTO_SUBMIT`            | 首次联调 `false`   | 人工检查本地结果后再提交草稿；稳定后可改为 `true`         |

修改环境变量后用 `up -d` 重新创建 worker；只执行 `restart` 不会重新读取 Compose 环境配置。

把一条有发布日期、可访问原文、可核实具体事实的真实来源写入自己的 `/app/content/input.json`。首次联调执行：

```bash
bash deploy/postiz/compose.sh run --rm content-worker enqueue --input-json /app/content/input.json
bash deploy/postiz/compose.sh run --rm content-worker candidates
bash deploy/postiz/compose.sh run --rm content-worker work --once --no-submit
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
```

`enqueue` 返回的是候选信息；把 `JOB_ID` 替换为 `work` 选择候选并生成后返回的任务 ID。候选尚待复核、被拒绝或当天额度已满时，不应假定已经生成任务。逐项检查来源归因、事件日期、品牌相关性、证据支持、语言和 X 长度；不能把“模型复审通过”当成独立事实核查。确认合格后再提交草稿：

```bash
bash deploy/postiz/compose.sh run --rm content-worker submit --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID
```

**通过条件：** 正确账号下只有一份草稿，本地保存对应 Postiz ID；没有公开发布时，不应填写 X 平台帖子 ID。再次以相同来源入队应命中已有任务，而不是新增一份内容。来源不相关、事实不足或过期时，应记录拒绝或停止原因，不能为了凑每日数量强行发布。

本阶段不使用 `--schedule`，不执行自动公开发布。需要验证真实 X 发布时，应另行明确账号、最终内容和未来时间，记录 Postiz 排期和最终 X URL；该步骤没有完成前，不能把“草稿 API 联调成功”写成“真实发布闭环成功”。

遇到待复核内容，先通过 `candidates` / `topics` 找到正确对象。候选重新评估使用
`retry-candidate --id CANDIDATE_ID --reason "实际理由"`；选题人工决策使用
`review-topic --id TOPIC_ID --decision approve|reject --reason "实际理由"`。
这里的 `approve|reject` 表示二选一，不要把竖线原样当作 Shell 命令执行。
若需要 `--confirm-new-event`，必须先核实该来源与历史记录是不同事件，并写明证据。
将这些决定和理由纳入每日记录，不能仅记录最终草稿数量。

### 真实素材验收矩阵：尚未执行

以下只列出待抓取、待真实模型实测的素材和人工检查标准，不表示已经读取页面或验证文案质量。按每日 1–3 次生成额度分日执行，记录抓取时间、最终 URL、模型、候选/任务 ID、结果和人工理由。

| 素材                                                                      | 人工验收标准                                                                             | 当前状态          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| [Tokenhot 文档入口](https://docs.tokenhot.ai/general)中的集成教程         | 若教程提供具体步骤，产出可核实的开发者集成价值；不虚构兼容性、价格或未经实际测试的效果   | 待抓取 / 待实测   |
| [Tokenhot 网站](https://tokenhot.ai)                                      | 若素材展示网络延迟，只描述其实际测量范围，不将网络延迟等同于模型推理延迟、吞吐或推理性能 | 待抓取 / 待实测   |
| 一篇已超新闻新鲜度窗口的旧发布公告，具体 URL 待选                         | 保留真实发布日期，不能包装成新发布；旧新闻应被拒绝或按规则复核，不能为凑数量强行入选     | 待选素材 / 待实测 |
| [Yellowstone bison 页面](https://www.nps.gov/yell/learn/nature/bison.htm) | 对当前 AI API / 开发者品牌定位判定不相关，不强行关联产品或生成营销帖                     | 待抓取 / 待实测   |

上述矩阵没有已通过项目。单元测试中的固定响应和本地 HTTP mock 不能替代真实模型的内容质量验收。

## 4. 启动常驻 worker，并检查重启恢复

确认前述联调通过，再启动常驻进程：

```bash
bash deploy/postiz/compose.sh --profile worker up -d content-worker
bash deploy/postiz/compose.sh ps
bash deploy/postiz/compose.sh logs --tail 100 content-worker
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
```

在空闲时重新创建 worker，再读取同一个任务：

```bash
bash deploy/postiz/compose.sh --profile worker up -d --force-recreate content-worker
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
```

**通过条件：** 数据卷未丢失，任务 ID 和 Postiz ID 不变，没有重复草稿。此检查不是所有故障组合的保证；提交结果未知时，先在 Postiz 核对，再按安装文档执行 `sync --postiz-id` 对账，不能直接重复创建。

另选维护窗口，按安装文档备份 worker 卷、Postiz 数据库、Temporal 数据及配置/上传文件。至少在独立测试目录与独立 Compose project 中演练一次恢复，确认备份可读。不要在生产 project 上运行删除卷的命令，也不要把 CI 脚本的临时卷清理步骤复制到生产恢复流程。

## 5. 连续 7 天记录

开始计时的前提是：真实 HTTPS、Postiz 认证、目标账号、真实模型生成和草稿可见性已验收。中途更换重要模型、来源策略、额度或代码时记录变更；不要事后补写成连续稳定运行。

每日至少检查一次，保留任务 ID、来源 URL 和结果摘要。来源服务、模型和 Postiz 的费用/额度以各服务实际记录为准；本地每日生成额度不代表所有外部 API 费用都有统一上限。

| 日期 / 时区   | commit / 配置变更 | 来源数 / 候选数 | 生成数 / 当日额度 | 合格草稿数 | 拒绝、失败、未知数 | 重复内容 / 重复草稿 | 人工质量结论与处理 | 实际费用或额度消耗 | 证据：任务 ID / Postiz ID |
| ------------- | ----------------- | --------------- | ----------------- | ---------- | ------------------ | ------------------- | ------------------ | ------------------ | ------------------------- |
| Day 1：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |
| Day 2：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |
| Day 3：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |
| Day 4：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |
| Day 5：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |
| Day 6：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |
| Day 7：待填写 |                   |                 |                   |            |                    |                     |                    |                    |                           |

每天使用同一组基础检查命令；`JOB_ID` 取当天实际任务：

```bash
bash deploy/postiz/compose.sh ps
bash deploy/postiz/compose.sh logs --since 24h --tail 300 content-worker
bash deploy/postiz/compose.sh run --rm content-worker status
bash deploy/postiz/compose.sh run --rm content-worker show --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker history --id JOB_ID
df -h
docker system df
```

`status` 汇总本地持久化记录，不会自行刷新 Postiz；对于已经有 Postiz ID 的任务，先运行 `sync --id JOB_ID` 再查看最新观察结果。区分本地任务状态、收到提交回执、Postiz 草稿/排期/发布状态以及未知结果；不能把“已收到回执”当作已公开发布。“今日生成次数”包含消耗额度的 preview、失败和重试；模型调用另计，“今日首次观察到草稿”也不等于今天生成的草稿。

在 Postiz 人工修改内容后，先同步，再保存具体修改理由；例如：

```bash
bash deploy/postiz/compose.sh run --rm content-worker sync --id JOB_ID
bash deploy/postiz/compose.sh run --rm content-worker feedback --id JOB_ID --kind edit --reason "已将推理性能表述改为素材实际支持的网络延迟" --actor "operator"
bash deploy/postiz/compose.sh run --rm content-worker history --id JOB_ID
```

把理由和 actor 替换成实际内容。`--kind` 可选 `edit`、`reject` 或 `note`；反馈只记录人工意见，不自动修改、删除或取消远端草稿/排期。报告保留原始生成结果，依据最近一次匹配 Postiz ID 的观察判断正文是否变化，不能把未观察到变化解释为没有人工修改。

不要把原始日志和完整内容自动上传到公开 CI。故障记录至少包括发生时间、当前 commit、任务 ID、状态、是否存在 Postiz ID、恢复动作和核对结果；不要包含 token 或 key。

出现错误账号、事实无依据、重复草稿、未知外部提交结果、额度异常或持续重启时，停止扩大来源和额度，先处理原因。需要暂停 worker：

```bash
bash deploy/postiz/compose.sh stop content-worker
```

这个命令不会撤销 Postiz 中已经存在的排期。需要暂停公开发布时，还要在 Postiz 检查和处理对应排期。

## 6. 试运行结束后的验收记录

| 验收项                               | 实际证据                           | 结果 / 未完成原因 |
| ------------------------------------ | ---------------------------------- | ----------------- |
| HTTPS、真实 Postiz 认证、正确 X 账号 | 待填写                             | 待验收            |
| 真实模型与来源质量                   | 待填写；列出人工核查样本           | 待验收            |
| 每日生成额度与时区                   | 待填写；至少包含跨日观察           | 待验收            |
| 重复来源与重复草稿                   | 待填写                             | 待验收            |
| 常驻进程、重启后的队列与去重         | 待填写                             | 待验收            |
| 提交失败或未知结果的核对             | 若未发生，记录“未实测”，不能写通过 | 待验收            |
| 备份与独立恢复                       | 待填写                             | 待验收            |
| 7 天费用、错误与人工修订比例         | 待填写实际值，不预设成绩           | 待验收            |
| 真实公开发布                         | 未纳入本次默认草稿试运行           | 未执行            |

只把实际执行且有证据的项目标为通过。7 天结束后继续保持首期规则：worker 生成草稿，由人在 Postiz 中审阅、编辑和排期；试运行完成不会自动开启 worker 排期或改变发布权限。结果也不能证明未来永不重复、模型永不出错或生产系统无需维护。
