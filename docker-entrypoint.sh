#!/bin/sh
set -e

# Esse projeto usa "prisma db push" em vez de migrations — sem esse passo
# aqui, o schema do banco de produção nunca é atualizado quando o
# schema.prisma muda, e o Prisma Client (gerado a partir do schema mais
# recente) acaba lendo/gravando colunas ou tabelas que não existem no banco
# real, quebrando em runtime com erro 500 genérico.
npx prisma db push --skip-generate

exec node dist/server.js
