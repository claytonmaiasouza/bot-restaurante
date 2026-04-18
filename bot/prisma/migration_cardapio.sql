-- Migration: adicionar tabelas Categoria, Produto, Tamanho e tornar strapiId opcional

-- 1. Tornar strapiId opcional no Restaurante
ALTER TABLE "Restaurante" ALTER COLUMN "strapiId" DROP NOT NULL;

-- 2. Criar tabela Categoria
CREATE TABLE IF NOT EXISTS "Categoria" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "nome"          TEXT NOT NULL,
  "ordem"         INTEGER NOT NULL DEFAULT 0,
  "restauranteId" TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Categoria_restauranteId_fkey" FOREIGN KEY ("restauranteId") REFERENCES "Restaurante"("id") ON DELETE CASCADE
);

-- 3. Criar tabela Produto
CREATE TABLE IF NOT EXISTS "Produto" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "nome"        TEXT NOT NULL,
  "descricao"   TEXT,
  "preco"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "ativo"       BOOLEAN NOT NULL DEFAULT true,
  "categoriaId" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Produto_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "Categoria"("id") ON DELETE CASCADE
);

-- 4. Criar tabela Tamanho
CREATE TABLE IF NOT EXISTS "Tamanho" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "nome"          TEXT NOT NULL,
  "preco"         DOUBLE PRECISION NOT NULL,
  "precoComBorda" DOUBLE PRECISION,
  "produtoId"     TEXT NOT NULL,
  CONSTRAINT "Tamanho_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE
);

-- 5. Índices
CREATE INDEX IF NOT EXISTS "Categoria_restauranteId_idx" ON "Categoria"("restauranteId");
CREATE INDEX IF NOT EXISTS "Produto_categoriaId_idx" ON "Produto"("categoriaId");
CREATE INDEX IF NOT EXISTS "Tamanho_produtoId_idx" ON "Tamanho"("produtoId");
