# Tokenhot 内容工作台

工作台管理素材、候选、选题和生成任务。Postiz 负责最终编辑、审核、排期与发布。
页面中的“通过选题”只代表允许写作，不代表批准公开发布。它不是原版 Agent Inbox，
也不需要 LangGraph Server；页面与 CLI 共用 worker 的状态与执行规则。

## 日常操作

1. 登录工作台，查看“配置检查”和运行状态。模型、品牌、Postiz API 和 X 渠道就绪后才能执行完整任务。
2. 在素材入口粘贴链接；无法抓取的页面可同时提供正文。JSON 入口接受现有来源格式，最多八个来源。
3. 在选题页处理待复核项目。查看入选、拒绝或归组原因，确认需要保留的主题与版本。
4. 在任务页观察研究、写作和检查进度。合格内容提交为 Postiz 草稿；不合格内容保留原因，允许当天零草稿。
5. 打开 Postiz，编辑草稿并决定舍弃或排期。工作台同步观察到的修改版本，保留原始生成稿。
6. 发布结果依据 Postiz 回执显示。已接收不等于已发布；最终平台 ID/URL 只有在接口实际返回后才出现。

界面轮询不会覆盖正在填写的表单。首次启用的工作台保持暂停，配置检查通过后再恢复。
暂停会阻止启动新的采集与写作；已在执行的调用需要结束，已提交任务仍可同步结果。

## 恢复与额度

- 以 `Asia/Shanghai` 的日期统计，每天最多三次完整写作启动；预览、失败和手动重试共用持久额度。
- 候选筛选模型调用单独计数，三次写作额度不代表全部 API 调用次数。
- 只有符合原有状态规则的失败任务可以重试。显式刷新品牌或转草稿需要填写原因并保留审计记录。
- 提交中、已经提交及提交结果未知的任务不能重新创建。结果未知时先在 Postiz 核实，使用实际 Postiz ID 对账。
- 人工修改过的未知草稿需要明确勾选接受编辑并填写原因后对账。原始生成稿不被修改。
- 反馈用于记录编辑或拒绝原因，不会自动修改品牌规则。

## 本地启动

需要 Node.js 24+，按仓库约定安装依赖。复制 `.env.postiz.example` 到私有 `.env.postiz`，
配置品牌文件、数据库路径以及工作台专用随机密码（至少 20 个字符）。

```bash
yarn postiz:build
PORT=4080 node dist-postiz/src/postiz/cli.js serve
```

PowerShell 中先设置 `$env:PORT='4080'`，再执行 Node 命令。
`CONTENT_WORKBENCH_URL=http://localhost:4080` 必须与浏览器实际访问的 origin 一致。
工作台可以在模型/X 尚未配置时启动并展示缺项，不能因此启动完整写作流程。
`CONTENT_WORKBENCH_PASSWORD` 未设置时拒绝启动；它与 Postiz 账号密码不同。

Compose 可叠加工作台配置，仍只有一个 worker：

```bash
bash deploy/postiz/compose.sh --profile worker \
  -f "$PWD/deploy/postiz/compose.workbench.yaml" up -d --build content-worker
```

默认只在本机 `127.0.0.1:4080` 暴露；远程使用配置正确 origin 的 HTTPS 反向代理。
原有 `work` 命令保留供无网页场景使用；不要另起一个 `work` 副本与网页进程共用同一 SQLite。

## Railway

继续使用已有 GitHub worker 服务和 `Dockerfile.postiz`，保持一个实例。
Postiz 与其数据库等服务维持独立，不需要安装另一套 Agent Server。

| 项目                             | 值                                                                    |
| -------------------------------- | --------------------------------------------------------------------- |
| Dockerfile                       | `Dockerfile.postiz`                                                   |
| 启动命令                         | `node scripts/start-postiz-railway.mjs`                               |
| 公共端口                         | `8080`                                                                |
| 健康检查                         | `/healthz`                                                            |
| 持久卷挂载                       | `/data`                                                               |
| `CONTENT_DB_PATH`                | `/data/worker/content.sqlite`                                         |
| `RAILWAY_RUN_UID`                | `0`，仅用于初始化卷；启动器在加载应用前降为 UID 1000                  |
| `PORT`                           | `8080`                                                                |
| `CONTENT_WORKBENCH_URL`          | 工作台的完整 HTTPS origin，末尾不加路径                               |
| `CONTENT_WORKBENCH_PASSWORD`     | 独立随机密码，至少 20 个字符                                          |
| `CONTENT_BRAND_FILE`             | `/app/config/postiz/brand.example.json` 或已部署的真实品牌配置        |
| `CONTENT_SOURCES_FILE`           | `/app/config/postiz/sources.example.json`（默认空列表）               |
| `POSTIZ_BASE_URL`                | `http://postiz.railway.internal:5000/api/public/v1`，按实际服务名调整 |
| `POSTIZ_PUBLIC_URL`              | 用户浏览器访问的 Postiz HTTPS 地址                                    |
| `CONTENT_ALLOW_SCHEDULING`       | `false`                                                               |
| `CONTENT_AUTO_SUBMIT`            | `true`（只送草稿）                                                    |
| `CONTENT_DAILY_GENERATION_LIMIT` | `3`                                                                   |
| `CONTENT_DAILY_TIMEZONE`         | `Asia/Shanghai`                                                       |

镜像只包含公开的品牌示例与空来源列表，不含真实密钥、任务库或私有业务材料。
示例品牌没有任何未经验证的功能/价格事实。业务来源需明确配置后才会采集。
健康检查只证明进程正常，业务配置、真实模型调用和渠道授权在工作台中分别检查。

Railway 卷以 root 挂载。专用启动器只初始化 `/data/worker`，随后降权运行；
不对整块卷递归修改所有权。迁移前按现有机制备份数据库，另为该卷配置备份。
来源：[Railway 卷文档](https://docs.railway.com/volumes)。

## DeepSeek V4.1 Flash

```dotenv
CONTENT_MODEL_PROVIDER=openai
CONTENT_MODEL=deepseek-flash
CONTENT_MODEL_BASE_URL=https://api.deepseek.com
CONTENT_MODEL_API_KEY=YOUR_PRIVATE_KEY
CONTENT_MODEL_THINKING=disabled
```

官方 API 中 `deepseek-flash` 对应 V4.1 Flash。此流程使用文本聊天兼容接口；短文案任务显式关闭思考模式，
避免默认思考消耗有限输出预算。其他不支持此参数的兼容服务应留空 `CONTENT_MODEL_THINKING`。
密钥仅放入私有环境变量，不提交 Git，也不传给浏览器。
来源：[DeepSeek 接口](https://api-docs.deepseek.com/zh-cn/)、[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)。

## X 授权与最终验收

在自己的 X 开发者账号创建应用。按 Postiz 文档设置 Read and Write、Native App，
回调地址为 `https://你的Postiz域名/integrations/social/x`。
Consumer API Key/Secret 只配置给 Postiz 的 `X_API_KEY`/`X_API_SECRET`；在本项目私有配置中使用
`POSTIZ_X_API_KEY`/`POSTIZ_X_API_SECRET` 时，部署层负责映射。
它们不是 OAuth 2.0 Client ID，也不是 worker 的 Postiz API key。
若平台要求付费或确认条款，由账号所有者决定并操作。
来源：[Postiz X 接入说明](https://docs.postiz.com/self-host/providers/x-twitter)。

然后在 Postiz Add Channel 中连接目标 X 账号，在 Settings 的开发者/Public API 区域取得 API key，
将其配置给 worker 的 `POSTIZ_API_KEY`；查询渠道列表并填写实际 `POSTIZ_INTEGRATION_ID`。
不得填写临时或虚构的渠道 ID；品牌绑定一旦建立，不能通过更换变量把历史任务转发到其他账号。

完整验收必须记录：真实素材及筛选结果、真实模型输出、Postiz 草稿 ID、人工编辑同步、
用户逐条排期后的发布回执与平台 URL。模拟接口测试和“部署成功”不能替代这一步。
另外进行七天试运行，观察重启、暂时网络错误、额度、备份恢复及人工修改原因；未经过七天不能宣称持续运行验收完成。
