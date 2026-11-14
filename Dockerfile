FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
WORKDIR /app

FROM base AS build
# The build context allowlist excludes Git, env/secrets, tests, caches and artifacts.
COPY . .
RUN test "$(node --version)" = v26.13.1 && test "$(npm --version)" = 11.20.0 \
 && npm ci --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && mkdir /runtime \
 && mv node_modules dist /runtime/ \
 && cp package.json package-lock.json /runtime/ \
 && cp -R drizzle /runtime/

FROM base AS production
ENV NODE_ENV=production APP_MODE=runtime PORT=3000
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","dist/main.js"]
