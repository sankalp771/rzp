# Shared multi-stage image for every Node service. Build with
#   docker build --build-arg SERVICE=merchant .
# Compose passes SERVICE per container so one Dockerfile covers all four.
FROM node:22-alpine AS build
ARG SERVICE
RUN corepack enable
WORKDIR /app
# Copy manifests first so dependency install is cached across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/llm/package.json packages/llm/
COPY services/${SERVICE}/package.json services/${SERVICE}/
RUN pnpm install --frozen-lockfile --filter "@negotiator/${SERVICE}..."
COPY packages ./packages
COPY services/${SERVICE} ./services/${SERVICE}
RUN pnpm --filter "@negotiator/${SERVICE}..." run build

FROM node:22-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=build /app ./
# Non-root: nothing here needs privileges. data/ is the SQLite home and the
# only path a service may write; it must exist and belong to node before the
# privilege drop (bind mounts may mask it — Docker Desktop mounts are
# permissive, named volumes inherit this ownership).
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["sh", "-c", "node services/${SERVICE}/dist/main.js"]
