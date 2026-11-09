FROM node:26.13.0-alpine AS base
WORKDIR /app

# ---

FROM base AS dependencies_base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g --force corepack@latest
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/

# ---

FROM dependencies_base AS builder

RUN pnpm install --frozen-lockfile

COPY ./src/ ./src/
COPY ./web/ ./web/
COPY tsconfig.json ./
RUN pnpm build

# ---

FROM dependencies_base AS production_dependencies

# Le producteur seul : l'interface est déjà construite dans dist/admin-ui, ses dépendances n'ont rien à faire ici.
RUN pnpm install --frozen-lockfile --prod --filter @bus-tracker/gtfsrt-tcl

# ---

FROM base AS runtime
ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=production_dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist/ ./dist
COPY ./assets/ ./assets/

EXPOSE 3000
CMD ["/sbin/tini", "--", "node", "/app/dist/index.js"]
