// Reenfileira lotes de histórico (coexistência) que já passaram pelo worker
// de webhook. A Meta não reenvia um lote, mas a fila guarda os últimos
// jobs concluídos (removeOnComplete) com o corpo inteiro — dá pra
// reprocessar depois de corrigir o handler, sem pedir o histórico de novo.
//
// Uso (dentro do container do worker, que enxerga o Redis do Swarm):
//   node dist/scripts/replayHistorySync.js           -> só lista
//   node dist/scripts/replayHistorySync.js --apply   -> reenfileira
import { connection, webhookQueue } from "../queue/queue.js";

function hasHistory(body: any): boolean {
  return (body?.entry ?? []).some((entry: any) =>
    (entry?.changes ?? []).some((change: any) => change?.value?.history)
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const jobs = await webhookQueue.getJobs(["completed", "failed"], 0, -1);
  const historyJobs = jobs
    .filter((job) => job && hasHistory(job.data))
    .sort((a, b) => a.timestamp - b.timestamp);

  console.log(`${historyJobs.length} lote(s) de histórico encontrados na fila`);
  for (const job of historyJobs) {
    console.log(`  job ${job.id} — recebido em ${new Date(job.timestamp).toISOString()}`);
  }

  if (!apply) {
    console.log("Nada reenfileirado. Rode de novo com --apply para reprocessar.");
  } else {
    for (const job of historyJobs) {
      await webhookQueue.add("process-event", job.data);
    }
    console.log(`${historyJobs.length} lote(s) reenfileirados — acompanhe nos logs do worker.`);
  }

  await webhookQueue.close();
  await connection.quit();
  // queue.ts também abre um QueueEvents (conexão bloqueante própria) que
  // seguraria o processo vivo.
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await connection.quit().catch(() => {});
  process.exit(1);
});
