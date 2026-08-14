FROM node:22-bookworm-slim AS app-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
    && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

FROM app-base AS frontend-build
RUN pnpm build

FROM app-base AS api

ENV NODE_ENV=production
EXPOSE 8787

USER node

CMD ["node", "--import", "tsx", "server/index.ts"]

FROM caddy:2.11.4-alpine AS web

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /app/dist /srv
