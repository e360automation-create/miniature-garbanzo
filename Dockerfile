FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY apps/agent/src/server.ts ./apps/agent/src/server.ts
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "apps/agent/src/server.ts"]
