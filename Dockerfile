FROM oven/bun:1.3-alpine
WORKDIR /app

# Install curl for IPv6 source rotation
RUN apk add --no-cache curl

# Copy dependency manifests
COPY package.json bun.lock* ./

# Install all dependencies (no production deps)
RUN bun install

# Copy source code
COPY src/ src/
COPY public/ public/
COPY proxy.txt ./

EXPOSE 3000

USER bun

CMD ["bun", "run", "src/index.ts"]
