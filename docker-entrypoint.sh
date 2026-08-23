#!/bin/sh
set -e

# Sem esse passo, o schema do banco de produção nunca é atualizado quando o
# schema.prisma muda, e o Prisma Client (gerado a partir do schema mais
# recente) acaba lendo/gravando colunas ou tabelas que não existem no banco
# real, quebrando em runtime com erro 500 genérico.
#
# "migrate deploy" (não "db push"): aplica só os arquivos versionados em
# prisma/migrations, na ordem, sem perguntar nada — a revisão de risco
# (perda de dado, constraint nova, etc.) acontece antes, quando a migration
# é criada localmente com "prisma migrate dev" e revisada no PR. Isso
# substitui o antigo "db push --accept-data-loss", que aplicava qualquer
# mudança do schema.prisma direto em produção sem nenhum arquivo pra
# revisar.
npx prisma migrate deploy

exec node dist/server.js
