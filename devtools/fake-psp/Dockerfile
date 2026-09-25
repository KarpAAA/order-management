# Build context: repository root
FROM node:24-slim
WORKDIR /app
COPY devtools/fake-psp/package.json ./
COPY devtools/fake-psp/src ./src
USER node
EXPOSE 4010
CMD ["node", "src/server.ts"]
