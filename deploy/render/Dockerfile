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
RUN node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {renderNginxConfig} from './deploy/render/start.mjs'; writeFileSync('/runtime/nginx/buildcheck.conf',renderNginxConfig({platformPort:10000,config:{runMode:'showcase',transport:'trusted-local-proxy',host:'127.0.0.1',port:4175,publicOrigin:'https://bsr-temporary-preview-production.up.railway.app',proxySecret:'0123456789abcdef'.repeat(4)}}));" \
 && nginx -t -p /runtime/nginx/ -c /runtime/nginx/buildcheck.conf \
 && rm /runtime/nginx/buildcheck.conf
EXPOSE 10000
STOPSIGNAL SIGTERM
CMD ["node", "deploy/render/start.mjs"]
