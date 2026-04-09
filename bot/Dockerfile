FROM node:20-alpine

# Dependências nativas do Prisma (openssl) e utilitários
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copia manifesto de dependências primeiro (cache de camadas)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia schema do Prisma e gera o client
COPY prisma ./prisma/
RUN npx prisma generate

# Copia o restante do código
COPY . .

# Cria diretório de logs
RUN mkdir -p logs

EXPOSE 3000

# Roda migrations e inicia o servidor
# O entrypoint garante que o banco esteja pronto antes de migrar
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
