FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY app.js index.js static.js runtime-policy.js legacy-security.js demo-accounts.js ./
COPY assessment ./assessment
COPY portal ./portal
# public/ 不在版本库内（.gitignore 忽略），构建时创建空目录，
# 避免 COPY 缺失目录导致构建失败；静态资源由静态托管提供。
RUN mkdir -p ./public

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "index.js"]
