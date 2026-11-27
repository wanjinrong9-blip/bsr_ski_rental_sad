FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /runtime/data /runtime/backups /runtime/nginx \
    && chown -R node:node /app /runtime

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node tools/temporary-preview-setup.mjs ./tools/temporary-preview-setup.mjs
COPY --chown=node:node deploy/render/start.mjs deploy/render/nginx.conf.template ./deploy/render/

ENV NODE_ENV=production
USER node
EXPOSE 10000
STOPSIGNAL SIGTERM
CMD ["node", "deploy/render/start.mjs"]
