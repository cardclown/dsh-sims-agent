# SIMS 助手

`@dsh-ops/dsh-sims-agent@0.1.4` 开发候选：一个 DSH Bundle、一个 `sims` 模型工具。当前实现连接配置、凭据管理、真实账号检查和单日考勤查询；已接入用户模板显式管理；尚未完成市场交付，请勿作为正式市场版本发布。

## 能力与边界

用户对 SIMS 助手说“检查连接”，模型调用 `sims({"action":"connection.check"})`。插件向配置地址追加 `/auth/me`，通过 SIMS 返回的身份核对连接。只有 HTTP 成功、业务信封成功及身份字段有效时返回 `CONNECTED`。

其他状态包括 `CONFIGURATION_REQUIRED`、`AUTH_REQUIRED`、`FORBIDDEN`、`UNAVAILABLE`、`INVALID_RESPONSE`、`TIMEOUT`、`CANCELLED`。成功结果包含检查时间及账号、角色、权限；不返回令牌或原始响应。此账号是管理员绑定的服务账号，不代表当前聊天用户。尚不提供库存、OCR、写入、自动登录或令牌刷新。

## 插件结构

- `src/host.mjs`：复用 DSH settings、credentials 服务管理本插件配置和授权。
- `src/settings-rpc.mjs`：通过已认证的宿主连接提供 `/sims-agent` 管理入口。
- `client/index.js`：DSH 原生设置页中的 SIMS 助手区块。
- `src/tool.mjs`：唯一模型工具与 SIMS 作用域限制；不影响其他智能体。
- `presets/sims/`：可导入的原生 Agent Preset 资源。
- `cordis.patch.yml`：仅追加自身 Host 和管理 RPC，不修改共享 agent-presets 的 default、roots 或启用状态。

适配 Node.js 22.19–22.x、DSH 0.1.2-rc.1。依赖宿主公开契约，不修改 Core、第三方插件或 node_modules。插件生命周期会取消自身未完成请求；配置、凭据与用户模板遵循宿主持久化语义，不随代码归档打包。

## 开发与候选安装

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run check
npm test
npm run check:release
```

`check:release` 验证包结构及来源声明；通过不代表已发布或已上架。检查只验证包结构，实际市场收录、市场安装和目标平台离线重建必须另有证据。不要绕过发布检查进行正式发布。

内部验收可在构建后执行 `npm pack --ignore-scripts`，使用独立 HOME 和 Profile 正常安装归档。不得在存在缺包的生产 Profile 反复试装；不要使用开发目录 link 或复制运行树替代发行归档。构建脚本是开发命令，不是宿主安装 hook。

Bundle 应位于宿主基础包和 web-app 之后。安装后在原生设置中打开“SIMS 助手”，填写实际 API 基地址与超时，输入 SIMS access token 并保存，然后检查连接。地址应为追加 `/auth/me` 前的路径；不要照搬作者服务器地址。

令牌通过宿主凭据服务保存，页面只显示是否已配置。令牌输入留空表示保留已有授权，“解除绑定”用于清除。检查连接使用已保存配置；输入尚未保存时应先保存。令牌失效需重新授权，插件不会尝试猜测账号密码。

## 用户模板与显式移除

在“设置 → SIMS 助手”填写模板标识及助手名称，点击“创建 SIMS 助手”。创建后可在新会话中选择；不会替换当前默认助手。标识最多 64 字符，只接受小写英文字母、数字和连字符，首字符为字母或数字。名称最多 80 字符。同名标识拒绝覆盖；更新模板请使用新标识，旧副本保留。

页面列出本插件创建的模板、来源版本和状态。点击对应“移除模板”仅删除未修改的该副本；不会卸载插件或解除 SIMS 授权。整个目录摘要包含元数据及新增资产；修改过的模板由原生“Agent 预设”管理页处理，本插件拒绝删除。原生页面删除过的副本可能显示“已不存在”，后续创建使用新标识。

直接卸载插件会保留用户模板，DSH 将缺少工具的副本标记为不可用；重新安装兼容版本后可再次使用。卸载期间本插件设置页不可用，仍可从宿主原生“Agent 预设”管理页清理副本。使用同一用户模板目录的其他 Profile 也可发现副本，未安装插件时不可用。

插件只通过 DSH 公开创作接口导入和移除，保留已有 default、roots 及启用标志。创建记录由宿主 settings 保存，只包含标识、名称、版本和摘要，不保存作者绝对路径。迁移需要同时保留用户模板和宿主设置；缺少创建记录的副本只能从原生管理页处理。复制成功后若记录保存失败，保留副本并报告操作未完成，不擅自删除目录。

## 从 0.1.0 迁移

新版默认使用 Host 管理的配置和凭据。旧模板中的 `tokenFile` 配置不会自动转换：推荐在设置页重新绑定；如需暂时保留受保护文件读取，必须在旧工具配置中显式设置 `mode: legacy-file` 并保留原 `apiBaseUrl`、`tokenFile`、`timeoutMs`。文件须仅含 access token、非符号链接、权限 0400 或 0600，大小不超过 16 KiB。

旧版修改过共享 agent-presets 配置的现场，需要依据原备份保留用户 default/roots，再移除旧包专属根目录引用；新版 Bundle 不会猜测或覆盖这些值。迁移前保留原 Profile 清单、锁文件、补丁及原版制品。卸载后用户配置、凭据及模板的保留与显式清理应分别核对，不承诺一键恢复所有持久状态。

## 验证说明

协议测试中的临时 HTTP 服务只验证错误处理，不证明真实业务连通。测试同时覆盖真实 DSH Loader、standing Preset 到子智能体的工具可见性、配置冲突、凭据变更、请求取消及经过宿主认证的管理 RPC。归档测试使用临时目录正常 npm 安装制品与 DSH，不借用作者 node_modules；需要 npm registry 或完整缓存可用。

真实验收需分别记录设置保存回读、SIMS 身份检查、自然语言模型调用、升级/卸载和不同 HOME 重建结果。市场收录、生产部署和源码发布均是独立状态，不能由本地测试通过推断完成。开发规则见仓库 `docs/dsh-plugin-development-rules.md`。

## 公开源码构建

本仓库是独立插件源码，0.1.4 为开发候选。克隆后按上面的命令构建与验证，执行 `npm pack` 生成包含客户端资源的安装包。`prepare` 是包管理器的标准构建生命周期，不是 DSH 安装 hook；禁止脚本时需显式执行 `npm run build`。GitHub 固定提交直装已通过下述隔离 Profile 验证；市场 UI 安装与实际收录仍待验收。

0.1.2 的离线夹具与历史结果仅适用于原 0.1.2 制品，不覆盖本候选的新增发布元数据和构建入口。源码公开不等于 npm 发布、市场收录或生产部署。

## GitHub 直装（无需 npm 登录）

已验证 Node 22.22.3、DSH 0.1.2-rc.1、pnpm 10.32.1、macOS arm64。使用已安装的 DSH：

```sh
dsh plugin --profile web add 'git+https://github.com/cardclown/dsh-sims-agent.git#cd898c05aec853e80e1e417ac3b606c25f525934'
```

pnpm 首次可能返回 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。按错误指出的 Profile 路径，在其 `pnpm-workspace.yaml` 已有配置中合并下列许可，然后重试原命令；保留已有许可和其他设置，不覆盖整个文件：

```yaml
onlyBuiltDependencies:
  - "@dsh-ops/dsh-sims-agent"
```

该字段对应已验证的 pnpm 10.32.1；其他版本遵循自身错误提示。允许的只是本插件源码构建。安装后按宿主提示刷新或重启，在设置中配置 SIMS。安装需要网络访问 GitHub 和依赖来源，但不需要 npm 账号。

2026-09-13 已从公开固定提交安装到新的独立 Profile：客户端资源生成、Bundle 注册、真实 DSH 启动、经过宿主认证的 RPC、模板创建/识别/显式移除均通过。未配置账号时正确返回 `CONFIGURATION_REQUIRED`。本次不包含真实 SIMS 授权、市场 UI、生产部署或新版跨平台离线重建验收。隔离 Profile 使用已安装的官方 DSH 宿主，未复制插件开发目录。

## 单日考勤（0.1.4 候选）

例如“查询 2026 年 9 月 13 日考勤”，使用同一个 `sims` 工具：

```json
{"action":"attendance.summary","date":"2026-09-13","page":1,"size":20}
```

固定读取 `/attendance/summary`，需绑定账号具有 `attendance:view` 权限；组织数据范围由 SIMS 服务端控制。当前不提供员工/组织筛选，也不触发同步。日期必填，单页最多 50 条。结果 `OK` 才表示查询成功，`total` 是该账号可见的记录数，`hasMore` 表示有后续页；空页不代表全公司无人出勤。状态标签和净工时来自 SIMS，不在插件中重算。缺失字段返回 null，不当作零。

此动作使用 Host 凭据，同次查询以同一令牌核对账号和读取考勤。`legacy-file` 用户需先在设置页配置 Host；模型参数不能覆盖凭据、API 地址或身份。旧用户模板是独立副本，升级后需显式创建新模板以使用新增说明，旧模板不被覆盖。

本候选已通过真实 DSH 工具管线查询绑定账号的真实考勤及分页校验；不等于自然语言页面验收、市场收录或生产部署。前文 GitHub 固定提交仍指向已验收的 0.1.3，不包含考勤功能。
