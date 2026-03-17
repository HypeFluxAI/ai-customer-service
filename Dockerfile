FROM node:22-alpine

WORKDIR /app

# 安装 Python3 (for MCP servers)
RUN apk add --no-cache python3 py3-pip bash

# Copy package files and install Node deps
COPY server/package*.json ./server/
RUN cd server && npm ci --production

# Copy Python deps and install
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir pymongo pyyaml python-dotenv

# Copy application code
COPY server/ ./server/
COPY mcp/ ./mcp/
COPY knowledge/ ./knowledge/
COPY response/ ./response/
COPY analysis/ ./analysis/
COPY core/ ./core/
COPY logging_/ ./logging_/
COPY .gemini/ ./.gemini/
COPY scripts/ ./scripts/
COPY GEMINI.md CLAUDE.md config.yaml ./

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# Start
WORKDIR /app/server
CMD ["node", "index.js"]
