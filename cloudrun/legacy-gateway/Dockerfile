FROM node:22-alpine
WORKDIR /app
COPY gateway.js index.js ./
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.js"]
