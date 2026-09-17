FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY fast-query ./fast-query

RUN mkdir -p /var/lib/manager-gateway \
  && chown -R node:node /app /var/lib/manager-gateway

USER node

ENV MANAGER_GATEWAY_HOST=0.0.0.0 \
    MANAGER_GATEWAY_PORT=43118 \
    MANAGER_GATEWAY_STATE_DIR=/var/lib/manager-gateway

EXPOSE 43118

CMD ["node", "src/cli.mjs"]
