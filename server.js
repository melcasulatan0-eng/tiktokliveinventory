const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');
const app = express();

app.use(express.json());

// Inventory list (in-memory demo)
const inventory = [
  { id: 1, name: 'top', stock: 15, price: '250', emoji: '👕' },
  { id: 2, name: 'shirt', stock: 20, price: '150', emoji: '🩳' },
  { id: 3, name: 'pan', stock: 10, price: '499', emoji: '🍳' },
  { id: 4, name: 'bikinis', stock: 8, price: '180', emoji: '👙' }
];

// TikTok Live configuration (set your live username here)
const tiktokUsername = 'lovemissjoyce'; // e.g. 'some_tiktok_user'

let tiktokConnection = null;

// Server-Sent Events clients
const sseClients = new Set();

function broadcast(event, payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => {
    if (event) res.write(`event: ${event}\n`);
    res.write(message);
  });
}

// Serve a simple dashboard with client-side SSE
app.get('/', (req, res) => {
  const usernameSection = tiktokUsername
    ? `<div class="header-status connected">🔴 LIVE: ${tiktokUsername}</div>`
    : `<div class="header-status disconnected">⚠️ TikTok username not configured</div>`;

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TikTok Live Inventory Tracker</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      background: rgba(255, 255, 255, 0.95);
      padding: 20px 24px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    .header h1 {
      font-size: 28px;
      color: #333;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-status {
      padding: 10px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
    }
    .header-status.connected {
      background: #10b981;
      color: white;
    }
    .header-status.disconnected {
      background: #f59e0b;
      color: white;
    }
    .main-grid {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 24px;
    }
    .inventory-section {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    .inventory-section h2 {
      font-size: 20px;
      color: #333;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .inventory-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }
    .product-card {
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      border-radius: 10px;
      padding: 16px;
      text-align: center;
      transition: all 0.3s ease;
      border: 2px solid transparent;
      cursor: pointer;
    }
    .product-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.15);
      border-color: #667eea;
    }
    .product-emoji {
      font-size: 48px;
      margin-bottom: 12px;
    }
    .product-name {
      font-size: 18px;
      font-weight: 700;
      color: #333;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .product-price {
      font-size: 24px;
      font-weight: 700;
      color: #667eea;
      margin-bottom: 8px;
    }
    .product-price span {
      font-size: 14px;
      color: #666;
    }
    .stock-badge {
      display: inline-block;
      background: #10b981;
      color: white;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .stock-badge.low {
      background: #f59e0b;
    }
    .stock-badge.out {
      background: #ef4444;
    }
    .events-section {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      display: flex;
      flex-direction: column;
    }
    .events-section h2 {
      font-size: 18px;
      color: #333;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .events-feed {
      flex: 1;
      overflow-y: auto;
      max-height: 600px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 12px;
      background: #f9fafb;
    }
    .event-item {
      padding: 10px;
      margin-bottom: 8px;
      background: white;
      border-left: 3px solid #667eea;
      border-radius: 4px;
      font-size: 13px;
      color: #555;
      word-break: break-word;
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(-10px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    .event-item.viewer {
      border-left-color: #3b82f6;
    }
    .event-item.like {
      border-left-color: #ec4899;
    }
    .event-item.gift {
      border-left-color: #f59e0b;
    }
    .event-time {
      font-size: 11px;
      color: #999;
      float: right;
    }
    @media (max-width: 768px) {
      .main-grid {
        grid-template-columns: 1fr;
      }
      .inventory-grid {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      }
      .header {
        flex-direction: column;
        gap: 12px;
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎬 TikTok Live Inventory</h1>
      ${usernameSection}
    </div>

    <div class="main-grid">
      <div class="inventory-section">
        <h2>📦 Available Items</h2>
        <div class="inventory-grid" id="inventory"></div>
      </div>

      <div class="events-section">
        <h2>⚡ Live Events</h2>
        <div class="events-feed" id="events"></div>
      </div>
    </div>
  </div>

  <script>
    const inventoryEl = document.getElementById('inventory');
    const eventsEl = document.getElementById('events');

    function getStockStatus(stock) {
      if (stock <= 0) return 'out';
      if (stock <= 5) return 'low';
      return '';
    }

    function renderInventory(items) {
      inventoryEl.innerHTML = items.map(function(it) {
        const stockClass = getStockStatus(parseInt(it.stock));
        const stockBadge = '<span class="stock-badge ' + stockClass + '">Stock: ' + it.stock + '</span>';
        return '<div class="product-card">' +
          '<div class="product-emoji">' + it.emoji + '</div>' +
          '<div class="product-name">' + it.name + '</div>' +
          '<div class="product-price">\$<span>' + it.price + '</span></div>' +
          stockBadge +
        '</div>';
      }).join('');
    }

    function addLog(message) {
      const el = document.createElement('div');
      el.className = 'event-item';
      
      let eventType = '';
      if (message.includes('Like')) eventType = 'like';
      else if (message.includes('Viewer joined')) eventType = 'viewer';
      else if (message.includes('Gift')) eventType = 'gift';
      
      if (eventType) el.classList.add(eventType);
      
      const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      el.innerHTML = message + '<span class="event-time">' + time + '</span>';
      eventsEl.insertBefore(el, eventsEl.firstChild);
      
      if (eventsEl.children.length > 50) {
        eventsEl.removeChild(eventsEl.lastChild);
      }
    }

    const es = new EventSource('/events');

    es.addEventListener('inventory', (e) => {
      const data = JSON.parse(e.data);
      renderInventory(data);
    });

    es.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      addLog(data.message);
    });

    es.onerror = () => addLog('⚠️ Connection lost. Attempting to reconnect...');
  </script>
</body>
</html>
`);
});

// SSE endpoint
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  // send initial inventory snapshot
  res.write(`event: inventory\n`);
  res.write(`data: ${JSON.stringify(inventory)}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Demo endpoint to simulate a purchase and update inventory
app.post('/simulate-purchase', (req, res) => {
  const { id } = req.body;
  const item = inventory.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.stock <= 0) return res.status(400).json({ error: 'Out of stock' });
  item.stock -= 1;
  broadcast('inventory', inventory);
  broadcast('log', { message: `Purchase simulated: ${item.name} (remaining ${item.stock})` });
  return res.json({ ok: true, item });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server is running on http://localhost:${PORT}`);
  if (tiktokUsername) {
    console.log('✓ Attempting to connect to TikTok Live...');
    initializeTikTokConnection();
  } else {
    console.log('⚠️ TikTok username not configured. TikTok connection skipped.');
  }
});

// Initialize TikTok Live connection and forward events to dashboard
function initializeTikTokConnection() {
  tiktokConnection = new WebcastPushConnection(tiktokUsername);

  tiktokConnection.on('connect', () => {
    console.log('✓ Connected to TikTok Live stream');
    broadcast('log', { message: 'Connected to TikTok Live' });
  });

  tiktokConnection.on('disconnect', () => {
    console.log('✗ Disconnected from TikTok Live stream');
    broadcast('log', { message: 'Disconnected from TikTok Live' });
  });

  tiktokConnection.on('roomUser', (msg) => {
    const message = `👤 Viewer joined: ${msg.uniqueId}`;
    console.log(message);
    broadcast('log', { message });
  });

  tiktokConnection.on('gift', (msg) => {
    const message = `🎁 Gift from ${msg.uniqueId}: ${msg.giftName}`;
    console.log(message);
    broadcast('log', { message });
  });

  tiktokConnection.on('like', (msg) => {
    const message = `❤️ Like from ${msg.uniqueId}`;
    console.log(message);
    broadcast('log', { message });
  });

  tiktokConnection.on('comment', (msg) => {
    const message = `💬 ${msg.uniqueId}: ${msg.comment}`;
    console.log(message);
    broadcast('log', { message });
  });

  tiktokConnection.on('error', (err) => {
    console.error('✗ TikTok connection error:', err && err.message ? err.message : err);
    broadcast('log', { message: `TikTok error: ${err && err.message ? err.message : err}` });
  });

  tiktokConnection.connect().catch(err => {
    console.error('Failed to connect to TikTok Live:', err && err.message ? err.message : err);
    broadcast('log', { message: `Failed to connect: ${err && err.message ? err.message : err}` });
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✓ Shutting down gracefully...');
  if (tiktokConnection) tiktokConnection.disconnect();
  sseClients.forEach((res) => res.end());
  process.exit(0);
});