# Gugu 基础后端（分拆候选）

身份、消息、同步、设备通信、权限和基础文件能力。官方 AgentBay 托管、套餐、模型网关、支付在个人私仓 gugu-cloud；社区安装不要求读取那个仓库或 gugu-dev。

尚未公开或切换生产。许可证与来源审查待完成；Supabase Cloud 授权安装尚待专用项目实测。

## 在自己的 Supabase Cloud 中安装

需要 Node 24、pnpm 10.28.2、自己的 Supabase 账号，以及一个全新的专用 Postgres 17 项目。

```sh
pnpm install --frozen-lockfile
# 在本机设置 SUPABASE_PROJECT_REF 和 SUPABASE_ACCESS_TOKEN；不要发到聊天或提交 Git。
pnpm setup --client-dir /path/to/gugu
```

工具检查项目为空，事务安装公共基线，配置 API schema、部署 server-login/attachments，设置附件回收任务，再写入客户端 `.envs/local.env`。客户端文件只包含公共 URL/anon key；官方托管、官方模型和官方中转均关闭。模型在客户端配置自己的 Claude 账号或 API。

重复运行只接受版本和摘要一致的社区基线；已经有旧 Gugu schema、官方 billing 或不同安装摘要时拒绝，不删除数据或迁移账本。SMTP 与免费项目暂停由安装者管理。

## 基线和权限

`supabase/migrations/20261021000000_foundation.sql` 提取自旧后端 503 条迁移全部重放后的有效结构，包含 RLS、Auth 触发器、Realtime 授权、Storage 策略和三项维护任务。它不包含旧提交祖先、旧迁移历史、用户数据或官方商业实现。

只用于新项目；旧部署继续使用原迁移和账本。基线必须在一个事务内安装。发布后通过增量升级，不改已发布基线或重写安装账本。后续创建的 API 函数默认禁止客户端执行，由迁移显式授权。

`identity.machine_limits_for(uuid)` 是安装策略接口。社区使用受权限保护的安装级配置，缺省无运营者设置的设备数量上限；官方增量可替换该接口读取套餐。设备所有权、群成员、消息与文件权限仍由数据库判定。

## 文件服务

附件上传、提交与签名下载使用自己的 Supabase Storage，不要求官方 OSS/CDN。

协同文件编辑需要另行运行 `services/files` 的 Node 常驻服务。Supabase Cloud 不会替你运行它。服务使用独立 `gugu_files` 数据库角色、项目 JWKS 和 HTTPS/WebSocket 入口，配置见 `services/files/src/config.mjs` 与 `docs/files-service.md`。

## 隔离验证

在一台有 Docker 的专用开发机上运行：

```sh
pnpm test:db:start
export GUGU_INSTALL_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable'
export GUGU_INTEGRATION_DATABASE_URL="$GUGU_INSTALL_TEST_DATABASE_URL"
pnpm test:installation
pnpm test
pnpm test:integration
pnpm test:db:stop
```

`GUGU_TEST_DB_PORT` 可指定未占用端口。该脚本只管理本 checkout 标记的测试 project，数据库绑定回环；stop 会删除这个一次性测试库的卷，不操作其他 project。安装测试必须使用空库，失败后检查日志，再停止并新建本任务装置；不要把正式库改造成测试需要的状态。

客户端契约测试使用主仓的 `supabase-contract` 项目连接这个隔离库，不再读取旧私仓的历史迁移文件。最终完整 CI 在实际试用确认后执行。
