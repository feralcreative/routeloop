# RouteLoop — Node/Express static server with runtime API-key injection
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

ENV NODE_ENV=production
ENV PORT=6686

EXPOSE 6686

CMD ["node", "server.js"]
