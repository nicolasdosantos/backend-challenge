FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598

WORKDIR /app
COPY package.json bun.lock ./
# patches/ precisa existir antes do install para o bun aplicar patchedDependencies
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .

CMD ["bun", "run", "src/main.ts"]
