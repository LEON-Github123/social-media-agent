# Tokenhot 内容工作台

工作台管理素材、候选、选题和生成任务。Postiz 负责最终编辑、审核、排期与发布。
页面中的“批准写作”只代表允许生成草稿，不代表批准公开发布。它不是原版 Agent Inbox，
也不需要 LangGraph Server；页面与 CLI 共用 worker 的状态与执行规则。

## 日常操作

1. 登录后打开“今日工作”，查看今日采集、未看推荐、草稿与写作额度。首页会提示下一步；配置检查、暂停/恢复与手动运行放在“来源与运行”。
2. 打开“挑选素材”，默认显示全部推荐待办，包含历史未处理项。“今日采集”可查看今天新发现的帖子及未推荐理由；“今日未看推荐”仅包含今天首次发现、尚未标记看过的推荐，数量为零不代表当天未采集。
3. 查看中文摘要、推荐理由、可借鉴角度及传播指标；原文、指标计算与事实缺口可展开。打开“设置写作与审批”，默认行业观点，允许保留第三方品牌与模型，由运营复核并补充模型链接；也可明确选择品牌内容，按需改写角度并检查资料。品牌内容需要匹配的已确认品牌事实；行业观点不能借此转述为 Tokenhot 自有功能。点击内部的“批准写作”才会启动完整写作。失败原因就地显示，并保留已填内容。
4. 批准后后台自动继续，在“内容进度”查看研究、写作和检查结果。有依据的厂商自述可注明来源进入草稿，待核实细节和运营待补链接显示为“运营复核点（不阻断草稿）”。编造数字、冒充亲测或无依据的自有产品声明仍会阻断。每日最多三次完整写作，超出额度的已批准项目等待下次额度。
5. 打开 Postiz，编辑草稿并决定舍弃或排期。工作台同步观察到的修改版本，保留原始生成稿。
6. 发布结果依据 Postiz 回执显示。已接收不等于已发布；最终平台 ID/URL 只有在接口实际返回后才出现。

临时素材放入“手动添加”，支持链接、正文及最多八个来源的 JSON。品牌事实和选材偏好在“品牌资料”维护。页面切换不会提交审批、标记看过或触发真实写作。

选题、相关性和质量检查的内部理由要求模型使用简体中文，公开帖子仍使用品牌配置的语言。新选题保留具体推荐理由和归组依据；历史“检查通过”占位提示只作中文展示，不补造理由、不重新运行模型，也不改动人工审核记录。其他历史自由文本保留原样。

最终审阅入口只在任务取得 Postiz ID 后显示；“草稿模式”本身不表示已经送达。界面轮询会更新任务状态与结果，同时保留正在填写的表单；状态变化导致旧操作失效时，输入保留供复制，旧操作不能继续提交。首次启用的工作台保持暂停，配置检查通过后再恢复。
暂停会阻止启动新的采集与写作；已在执行的调用需要结束，已提交任务仍可同步结果。

## 品牌事实与退稿修改

“品牌事实库”保存可核对的产品声明、官方链接、原文摘录、匹配词和有效期。
Tokenhot 首批八条公开资料默认待确认；打开证据链接核对后，填写理由并点击
“我已核对证据，确认事实”。创建或保存修改不会自动确认。价格事实有效期最多七天，
其他事实最多九十天；产品变化时可提前停用。记录和确认历史保存在同一 SQLite 数据库，
升级迁移前自动备份，不需要新增数据库或环境变量。

写作前系统从本次素材匹配最多八条已确认、未过期的事实。模型事实只匹配完整型号
或精确官方模型页面；相近版本、输入音频与输出语音不能互相代替。匹配结果与证据快照
显示在任务详情。没有匹配事实仍可以写有来源的行业内容，不强行植入 Tokenhot。
匹配不是独立事实核查；网站宣传、网络探测延迟也不能证明模型性能。

未提交的草稿可在“内容进度”中选择：

- **修改文案并重新检查**：直接修改当前正文，系统保留输入文字并重新审核。
- **按要求重新生成**：填写明确改写要求，例如“删除没有证据的文档与价格引导句，仅保留来源明确描述的功能”。要求会传给写作模型，但不能作为事实证据或覆盖审核规则。
- **重试/修复配置**：用于失败恢复。“处理原因”仅记录操作，不是改写指令。

修改与重新生成共用每日三次额度，失败也计入；到达上限后排队等待次日。
原稿、修改原因与检查结果保留在操作历史中。通过检查后才会送到 Postiz 草稿，
已提交、提交中或结果未知的任务不能从这里重新创建；Postiz 内人工修改的稿件不会被覆盖。
被停用、过期或修改的品牌事实会阻止使用旧证据快照的草稿提交，需明确重新检查。

## 自动收集与每日审批

当前竞对模式使用 `config/postiz/sources.tokenhot-competitors.json` 中的 X 账号，
北京时间每天 09:00 独立检查各来源；RSS 历史记录保留，但不进入日常推荐。
新帖经过筛选和归组后等待人工挑选。重复链接不会重复生成。
无需每天手动运行采集，也无需为普通批准填写固定格式的说明。

人工只需完成两步：工作台中批准素材；Postiz 中审阅生成稿并排期。
批准素材不会直接公开发布，稿件仍须通过质量检查。没有批准的项目不消耗写作次数；
自动筛选仍会调用模型，调用数量单独记录，不能把每日三次写作理解为全部模型调用上限。

来源检查成功不保证有新增帖子，采集到新帖也不保证达到推荐标准。详细来源、失败原因、下一次检查时间和调用额度都在“来源与运行”。旧版非竞对模式仍可使用 [来源清单](POSTIZ-SOURCES.md) 中的网页/RSS 配置。

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
