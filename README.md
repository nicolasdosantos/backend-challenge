# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas de múltiplos provedores de jogos, com foco em correção financeira, concorrência entre múltiplas instâncias, idempotência persistente e processamento assíncrono via SQS.

Stack: Bun, TypeScript, NestJS, PostgreSQL, MikroORM, AWS SQS (emulado localmente) e Docker Compose.

> Em desenvolvimento. Instruções de setup, comandos e decisões técnicas serão documentados neste README e em `ARCHITECTURE.md`.
