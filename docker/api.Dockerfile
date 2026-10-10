# =============================================================
# DeskAlarm API 服务端
#
# 数据库是外部的 PostgreSQL，镜像里不需要任何编译工具链。
# =============================================================
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷依赖清单，让 npm ci 这一层能被缓存住
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm config set registry https://registry.npmmirror.com && npm ci --no-audit --no-fund

COPY server/tsconfig.json ./server/
COPY server/src ./server/src
COPY server/scripts ./server/scripts
COPY shared ./shared

RUN cd server && npm run build

# ---------------------------------------------------------------- 运行
FROM node:22-alpine
WORKDIR /app

# 只需要运行期依赖。lock 文件必须一起带过来，npm ci 没它会直接报错
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm config set registry https://registry.npmmirror.com && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/shared ./shared

RUN chown -R node:node /app
USER node
EXPOSE 8787

# 健康检查直接打 Postgres 依赖的服务端。DB 挂了就不算健康
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server/dist/server/src/index.js"]
