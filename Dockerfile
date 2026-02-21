FROM node:25.6.1-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# ---

FROM base AS builder
RUN npm install -g --force corepack@latest
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY ./src/ ./
COPY tsconfig.json ./
RUN pnpm build

# ---

FROM base AS runtime
ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ ./dist

EXPOSE 3000
CMD ["/sbin/tini", "--", "node", "/app/dist/index.js"]
