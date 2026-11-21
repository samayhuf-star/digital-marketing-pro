# Marketing Crew web app (multi-tenant SaaS front end). Build context = repo root.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY web/server ./server
COPY web/public ./public
USER node
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server/index.js"]
