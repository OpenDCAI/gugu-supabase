# 协同文件服务

`services/files` 是通用文件协作能力，不属于官方托管控制面。普通附件上传和下载由 Supabase Storage 与 attachments 函数处理；协同编辑由这个 Node 进程处理。

部署时为服务创建独立 LOGIN 角色，令其以 NOLOGIN 的 `gugu_files` 权限运行；不要给进程 postgres 或 service_role 数据库权限。数据库连接串放在权限 0600 的文件中，路径通过 `FILES_DB_URL_FILE` 指定。

设置 `FILES_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`，并按项目实际签名方式配置验签。使用旧 HS256 令牌时，密钥通过 `FILES_JWT_SECRET_FILE` 文件提供。服务没有验签配置就会拒绝启动。

从仓库执行 `pnpm --filter @gugu-supabase/files start`。默认业务端口 18320、管理端口 18321 均绑定回环；通过自己的 HTTPS 反向代理发布业务端口的 `/files` 和 WebSocket，管理端口保持内网。客户端配置对应的文件服务地址，配置键以客户端 `.envs/example.env` 为准。

相关变量与上限见 `services/files/src/config.mjs`。当前没有把这一常驻进程包装成 Supabase Cloud 的一键部署；多用户文件权限与协作逻辑由隔离集成测试验证。

Apply the `20261025055000_workspace_content_editor` release before starting the matching file service. Content stores now write the authenticated human or delegated agent as `updated_by` in the same UPDATE as the body. Unchanged content preserves its previous editor and timestamp; historical rows keep a null editor rather than guessing from version history. The existing metadata RPCs return this additional field without changing their other fields or authorization.
