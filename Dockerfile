FROM node:22.19.0-alpine AS base
RUN corepack enable

# ---

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY ./src/ ./
COPY tsconfig.json ./
RUN pnpm build

# ---

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ ./dist

EXPOSE 3000
CMD ["node", "/app/dist/index.js"]