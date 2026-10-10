// Processo filho usado pelo teste de sinais: simula trabalho em andamento e encerra de forma graciosa.
let inFlight = true;

process.on('SIGTERM', async () => {
  console.log('sigterm-received');
  while (inFlight) await Bun.sleep(10);
  console.log('graceful-exit');
  process.exit(0);
});

console.log('ready');
setTimeout(() => {
  inFlight = false;
}, 300);
setInterval(() => {}, 1000);
