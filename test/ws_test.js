const WebSocket = require('ws');
const ws1 = new WebSocket('ws://localhost:3000/ws');
ws1.on('open', () => {
  console.log('TV Connected');
  ws1.send(JSON.stringify({ type: 'JOIN_ROOM', sessionId: 'myo-youth-8f3a9e', role: 'tv' }));
});
ws1.on('message', (data) => {
  console.log('TV Received:', data.toString());
});

setTimeout(() => {
  const ws2 = new WebSocket('ws://localhost:3000/ws');
  ws2.on('open', () => {
    console.log('Admin Connected');
    ws2.send(JSON.stringify({ type: 'JOIN_ROOM', sessionId: 'myo-youth-8f3a9e', role: 'admin' }));
  });
  
  setTimeout(async () => {
    console.log('Admin starting session...');
    const fetch = (await import('node-fetch')).default;
    await fetch('http://localhost:3000/api/session/myo-youth-8f3a9e/start', { method: 'POST' });
  }, 1000);
}, 500);

setTimeout(() => process.exit(0), 3000);
