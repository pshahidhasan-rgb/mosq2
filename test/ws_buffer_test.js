const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', ws => {
  ws.on('message', data => {
    console.log('Is Buffer?', Buffer.isBuffer(data));
    console.log('Data:', data.toString());
  });
});
setTimeout(() => {
  const ws = new WebSocket('ws://localhost:8080');
  ws.on('open', () => ws.send(JSON.stringify({ hello: 'world' })));
}, 500);
setTimeout(() => process.exit(0), 1000);
