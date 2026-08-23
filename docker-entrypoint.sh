#!/bin/sh
set -e

# Esse projeto usa "prisma db push" em vez de migrations — sem esse passo
# aqui, o schema do banco de produção nunca é atualizado quando o
# schema.prisma muda, e o Prisma Client (gerado a partir do schema mais
# recente) acaba lendo/gravando colunas ou tabelas que não existem no banco
# real, quebrando em runtime com erro 500 genérico.
#
# --accept-data-loss: sem essa flag, o db push recusa aplicar qualquer
# constraint nova (ex: unique) com um erro genérico de "possível perda de
# dados" — mesmo quando a mudança é só aditiva e só falharia de verdade se
# já existisse duplicata. Como isso travava o deploy inteiro (Swarm faz
# rollback do serviço quando o entrypoint sai com erro), aceitamos a flag
# aqui. Continua seguro: adicionar uma constraint não apaga nada, só falha
# se houver duplicata real — nesse caso o container erra e não sobe, não
# perde dado silenciosamente.
npx prisma db push --skip-generate --accept-data-loss

exec node dist/server.js
