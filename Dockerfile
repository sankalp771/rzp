# Shared multi-stage image for every Node service. Build with
#   docker build --build-arg SERVICE=merchant .
# Compose passes SERVICE per container so one Dockerfile covers all five;
# SERVICE_DIR defaults to services/<SERVICE> (the dashboard lives at ./dashboard).
FROM node:22-alpine AS build
ARG SERVICE
ARG SERVICE_DIR=services/${SERVICE}
RUN corepack enable
WORKDIR /app
# Copy manifests first so dependency install is cached across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/llm/package.json packages/llm/
COPY packages/ledger/package.json packages/ledger/
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
RUN pnpm install --frozen-lockfile --filter "@negotiator/${SERVICE}..."
COPY packages ./packages
COPY ${SERVICE_DIR} ./${SERVICE_DIR}
RUN pnpm --filter "@negotiator/${SERVICE}..." run build

FROM node:22-alpine AS runtime
ARG SERVICE
ARG SERVICE_DIR=services/${SERVICE}
ENV NODE_ENV=production SERVICE=${SERVICE} SERVICE_DIR=${SERVICE_DIR}
WORKDIR /app
COPY --from=build /app ./
# Non-root: nothing here needs privileges. data/ is the SQLite home and the
# only path a service may write; it must exist and belong to node before the
# privilege drop (bind mounts may mask it — Docker Desktop mounts are
# permissive, named volumes inherit this ownership).
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["sh", "-c", "node ${SERVICE_DIR}/dist/main.js"]
