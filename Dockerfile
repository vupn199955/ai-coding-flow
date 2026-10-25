FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production FLOW_WEB_HOST=0.0.0.0 FLOW_DATA_DIR=/data
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
