FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000
# Inside a container the server must listen on all interfaces, which makes
# COUNTERSIGN_TOKEN mandatory: the server refuses to start without it.
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "src/server.js"]
