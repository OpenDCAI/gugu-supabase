# 文件服务镜像。构建上下文是仓库根目录(要用根上的锁文件):
#   docker build -f services/files/Dockerfile -t gugu-files:<sha> .
# 基础镜像按 index digest 钉死(amd64 / arm64 同一个 digest),取自 public.ecr.aws —— 与 gugu-newapi 同一个来源。
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/files-core packages/files-core
COPY services/files services/files
# 只装这个包的运行依赖,按根上的锁文件,导出成一个自带 node_modules 的独立目录。
RUN pnpm --filter @gugu-supabase/files deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# 18320:/files 与 WebSocket(nginx 的 /files/ 转到这里);18321:/healthz、/stats,❌ 经 nginx 暴露。
EXPOSE 18320 18321
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.FILES_ADMIN_PORT || 18321) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.mjs"]
