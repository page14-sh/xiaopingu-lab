FROM node:22-alpine

WORKDIR /app

COPY local-api-server.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_FILE=/data/local-data.json

EXPOSE 8787

CMD ["node", "local-api-server.js"]
