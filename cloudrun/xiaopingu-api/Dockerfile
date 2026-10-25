FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY app.js index.js static.js runtime-policy.js legacy-security.js ./
COPY assessment ./assessment
COPY portal ./portal
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "index.js"]
