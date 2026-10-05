const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8081 });
wss.on('connection', ws => {
  ws.on('message', (data, isBinary) => {
    console.log('Is Binary?', isBinary);
  });
});
setTimeout(() => {
  const ws = new WebSocket('ws://localhost:8081');
  ws.on('open', () => {
    ws.send(JSON.stringify({ hello: 'world' }));
    ws.send(Buffer.from([0, 1, 2]));
  });
}, 500);
setTimeout(() => process.exit(0), 1000);
