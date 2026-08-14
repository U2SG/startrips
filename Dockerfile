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

ARG VITE_ATLAS_DETAIL_TILE_URL
ARG VITE_ATLAS_DETAIL_TILE_ATTRIBUTION
ARG VITE_ATLAS_OVERVIEW_TILE_URL
ENV VITE_ATLAS_DETAIL_TILE_URL=$VITE_ATLAS_DETAIL_TILE_URL
ENV VITE_ATLAS_DETAIL_TILE_ATTRIBUTION=$VITE_ATLAS_DETAIL_TILE_ATTRIBUTION
ENV VITE_ATLAS_OVERVIEW_TILE_URL=$VITE_ATLAS_OVERVIEW_TILE_URL

RUN pnpm build

FROM app-base AS api

ENV NODE_ENV=production
EXPOSE 8787

USER node

CMD ["node", "--import", "tsx", "server/index.ts"]

FROM caddy:2.11.4-alpine AS web

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /app/dist /srv
