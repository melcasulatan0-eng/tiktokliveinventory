const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ensure images directory exists
const imagesDir = path.join(__dirname, 'public', 'images');
fs.mkdirSync(imagesDir, { recursive: true });

// serve images
app.use('/images', express.static(imagesDir));

// multer setup
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, imagesDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.png';
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: function (req, file, cb) {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'), false);
    cb(null, true);
  }
});

// Serve product images from /images
app.use('/images', express.static(__dirname + '/public/images'));

// Inventory persistence setup
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dataFile = path.join(dataDir, 'inventory.json');
const dbFile = path.join(dataDir, 'inventory.sqlite');

const defaultInventory = [
  { id: 1, name: 'top', stock: 15, price: '250', emoji: '👕', image: '/images/top.svg' },
  { id: 2, name: 'shirt', stock: 20, price: '150', emoji: '🩳', image: '/images/shirt.svg' },
  { id: 3, name: 'pan', stock: 10, price: '499', emoji: '🍳', image: '/images/pan.svg' },
  { id: 4, name: 'bikinis', stock: 8, price: '180', emoji: '👙', image: '/images/bikinis.svg' }
];

const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Failed to open SQLite database:', err);
    process.exit(1);
  }
});

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDatabase() {
  await runSql(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    stock INTEGER NOT NULL,
    price TEXT NOT NULL,
    emoji TEXT,
    image TEXT
  )`);

  const rows = await allSql('SELECT * FROM inventory ORDER BY id');
  if (rows.length > 0) {
    inventory = rows.map((row) => ({
      id: row.id,
      name: row.name,
      stock: row.stock,
      price: row.price,
      emoji: row.emoji,
      image: row.image
    }));
    return;
  }

  let initialInventory = defaultInventory;
  if (fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const jsonItems = JSON.parse(raw);
      if (Array.isArray(jsonItems) && jsonItems.length > 0) {
        initialInventory = jsonItems;
      }
    } catch (err) {
      console.error('Failed to import inventory.json into SQLite:', err);
    }
  }

  for (const item of initialInventory) {
    await runSql(
      'INSERT OR REPLACE INTO inventory (id, name, stock, price, emoji, image) VALUES (?, ?, ?, ?, ?, ?)',
      [item.id, item.name, item.stock, item.price, item.emoji, item.image]
    );
  }

  inventory = initialInventory;

  if (fs.existsSync(dataFile)) {
    try {
      fs.unlinkSync(dataFile);
      console.log('Migrated inventory.json to SQLite and removed legacy JSON file.');
    } catch (err) {
      console.error('Could not remove legacy inventory.json:', err);
    }
  }
}

async function persistItem(item) {
  await runSql('UPDATE inventory SET stock = ?, image = ? WHERE id = ?', [item.stock, item.image, item.id]);
}

let inventory = [];
let viewerCount = 0;

// TikTok Live configuration
const tiktokUsername = 'deutchtrendsofficialacc';

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

function normalizeViewerName(msg) {
  const name = msg && (msg.uniqueId || msg.user?.uniqueId || msg.userId || msg.unique_id || msg.nickName || msg.nickname);
  return name ? String(name) : 'Guest';
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
    .viewer-counter {
      background: rgba(255, 255, 255, 0.92);
      border-radius: 999px;
      padding: 10px 18px;
      color: #1f2937;
      font-weight: 700;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
      margin-top: 12px;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
    }
    .viewer-count-number {
      background: #2563eb;
      color: white;
      padding: 6px 12px;
      border-radius: 999px;
      min-width: 48px;
      text-align: center;
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
    .product-img {
      width: 100%;
      height: 140px;
      object-fit: cover;
      border-radius: 8px;
      margin-bottom: 12px;
      background: linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.03));
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
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>🎬 TikTok Live Inventory</h1>
        <div class="viewer-counter">
          <span>Simulated viewers</span>
          <span id="viewer-count" class="viewer-count-number">0</span>
        </div>
      </div>
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
    const viewerCountEl = document.getElementById('viewer-count');

    function getStockStatus(stock) {
      if (stock <= 0) return 'out';
      if (stock <= 5) return 'low';
      return '';
    }

    function renderInventory(items) {
      inventoryEl.innerHTML = items.map(function(it) {
        const stockClass = getStockStatus(parseInt(it.stock));
        const stockBadge = '<span class="stock-badge ' + stockClass + '">Stock: ' + it.stock + '</span>';
        const imgSrc = it.image || '';
        const imgTag = imgSrc ? '<img class="product-img" src="' + imgSrc + '" alt="' + it.name + '">' : '<div class="product-emoji">' + (it.emoji || '📦') + '</div>';
        return '<div class="product-card">' +
          imgTag +
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

    es.addEventListener('viewerCount', (e) => {
      const data = JSON.parse(e.data);
      viewerCountEl.textContent = data.count;
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

app.get('/admin/data', (req, res) => {
  res.json(inventory);
});

app.post('/admin/update-stock', async (req, res) => {
  const id = parseInt(req.body.id, 10);
  const stock = parseInt(req.body.stock, 10);
  if (!Number.isInteger(id) || !Number.isInteger(stock) || stock < 0) {
    return res.status(400).json({ error: 'Invalid item ID or stock value' });
  }
  const item = inventory.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  item.stock = stock;
  try {
    await persistItem(item);
    broadcast('inventory', inventory);
    broadcast('log', { message: `Stock updated: ${item.name} → ${item.stock}` });
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Failed to persist stock update:', err);
    return res.status(500).json({ error: 'Failed to update stock' });
  }
});

app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Admin Inventory Manager</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #f3f4f6;
      margin: 0;
      padding: 24px;
      color: #111827;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
    }
    .nav-link {
      text-decoration: none;
      color: #2563eb;
      font-weight: 600;
    }
    .message {
      margin: 16px 0;
      padding: 14px 18px;
      border-radius: 12px;
      font-weight: 600;
    }
    .message.info { background: #dbeafe; color: #1e3a8a; }
    .message.success { background: #d1fae5; color: #064e3b; }
    .message.error { background: #fee2e2; color: #991b1b; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 15px 40px rgba(15, 23, 42, 0.08);
    }
    th, td {
      padding: 16px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: middle;
    }
    th { background: #f9fafb; font-size: 14px; letter-spacing: 0.02em; }
    td img {
      max-width: 96px;
      max-height: 72px;
      border-radius: 12px;
      object-fit: cover;
      background: #f3f4f6;
    }
    .stock-input {
      width: 80px;
      padding: 8px 10px;
      border: 1px solid #d1d5db;
      border-radius: 10px;
    }
    .button {
      border: none;
      padding: 10px 16px;
      border-radius: 10px;
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    .button.primary { background: #2563eb; }
    .button.secondary { background: #10b981; }
    .button.upload { background: #9333ea; }
    .upload-form { display: flex; gap: 10px; align-items: center; }
    .upload-form input[type=file] { width: 240px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>Admin Inventory Manager</h1>
        <p>Update stock and upload product images from the browser.</p>
      </div>
      <a class="nav-link" href="/">← Back to public dashboard</a>
    </div>

    <div id="message" class="message info">Loading inventory…</div>

    <table>
      <thead>
        <tr>
          <th>Photo</th>
          <th>Name</th>
          <th>Price</th>
          <th>Stock</th>
          <th>Save</th>
          <th>Upload Image</th>
        </tr>
      </thead>
      <tbody id="inventory-table"></tbody>
    </table>
  </div>

  <script>
    const messageEl = document.getElementById('message');
    const inventoryTable = document.getElementById('inventory-table');

    function setMessage(text, type = 'info') {
      messageEl.textContent = text;
      messageEl.className = 'message ' + type;
    }

    async function loadInventory() {
      setMessage('Loading inventory…', 'info');
      try {
        const res = await fetch('/admin/data');
        const items = await res.json();
        renderInventory(items);
        setMessage('Inventory ready. Edit values and upload new images as needed.', 'success');
      } catch (err) {
        console.error(err);
        setMessage('Unable to load inventory.', 'error');
      }
    }

    function renderInventory(items) {
      inventoryTable.innerHTML = items.map(item => {
        return '<tr>' +
          '<td><img src="' + (item.image || '') + '" alt="' + item.name + '" /></td>' +
          '<td>' + item.name + '</td>' +
          '<td>₱' + item.price + '</td>' +
          '<td><input class="stock-input" type="number" min="0" value="' + item.stock + '" data-id="' + item.id + '" /></td>' +
          '<td><button class="button primary save-stock-btn" data-id="' + item.id + '">Save</button></td>' +
          '<td>' +
            '<form class="upload-form" data-id="' + item.id + '">' +
              '<input type="file" name="image" accept="image/*" />' +
              '<button class="button upload" type="submit">Upload</button>' +
            '</form>' +
          '</td>' +
        '</tr>';
      }).join('');

      document.querySelectorAll('.save-stock-btn').forEach(button => {
        button.addEventListener('click', async () => {
          const id = button.dataset.id;
          const input = document.querySelector('input.stock-input[data-id="' + id + '"]');
          const stock = parseInt(input.value, 10);
          if (!Number.isInteger(stock) || stock < 0) {
            setMessage('Please enter a valid stock quantity.', 'error');
            return;
          }
          await updateStock(id, stock);
        });
      });

      document.querySelectorAll('.upload-form').forEach(form => {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const id = form.dataset.id;
          const fileInput = form.querySelector('input[type=file]');
          if (!fileInput.files.length) {
            setMessage('Please choose an image to upload.', 'error');
            return;
          }
          await uploadImage(id, fileInput.files[0]);
        });
      });
    }

    async function updateStock(id, stock) {
      try {
        setMessage('Saving stock…', 'info');
        const res = await fetch('/admin/update-stock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: parseInt(id, 10), stock })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
        setMessage('Stock updated for ' + data.item.name + '.', 'success');
        loadInventory();
      } catch (err) {
        console.error(err);
        setMessage(err.message || 'Failed to save stock.', 'error');
      }
    }

    async function uploadImage(id, file) {
      try {
        setMessage('Uploading image…', 'info');
        const formData = new FormData();
        formData.append('id', id);
        formData.append('image', file);

        const res = await fetch('/upload-image', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        setMessage('Image updated for ' + data.item.name + '.', 'success');
        loadInventory();
      } catch (err) {
        console.error(err);
        setMessage(err.message || 'Image upload failed.', 'error');
      }
    }

    loadInventory();
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

  // send current viewer count immediately as part of SSE state
  res.write(`event: viewerCount\n`);
  res.write(`data: ${JSON.stringify({ count: viewerCount })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Demo endpoint to simulate a purchase and update inventory
app.post('/simulate-purchase', async (req, res) => {
  const { id } = req.body;
  const item = inventory.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.stock <= 0) return res.status(400).json({ error: 'Out of stock' });
  item.stock -= 1;
  try {
    await persistItem(item);
    broadcast('inventory', inventory);
    broadcast('log', { message: `Purchase simulated: ${item.name} (remaining ${item.stock})` });
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Failed to persist purchase:', err);
    return res.status(500).json({ error: 'Failed to update inventory' });
  }
});

// Upload product image: multipart/form-data { id, image }
app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    const id = parseInt(req.body.id, 10);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const item = inventory.find(i => i.id === id);
    if (!item) {
      // remove uploaded file if item not found
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Item not found' });
    }

    // Update inventory image path (publicly served)
    item.image = '/images/' + req.file.filename;
    await persistItem(item);
    broadcast('inventory', inventory);
    broadcast('log', { message: `Image uploaded for ${item.name}` });
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Start Express server after DB initialization
initDatabase().then(() => {
  app.listen(3000, () => {
    console.log('✓ Server is running on http://localhost:3000');
    if (tiktokUsername) {
      console.log('✓ Waiting for TikTok connection...');
      initializeTikTokConnection();
    } else {
      console.log('⚠️ TikTok username not configured. TikTok connection skipped.');
    }
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Initialize TikTok Live connection
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
    const viewer = normalizeViewerName(msg);
    viewerCount += 1;
    const message = `👤 Viewer joined: ${viewer}`;
    console.log(message);
    broadcast('log', { message });
    broadcast('viewerCount', { count: viewerCount });
  });

  tiktokConnection.on('gift', (msg) => {
    const viewer = normalizeViewerName(msg);
    const gift = msg.giftName || 'a gift';
    const message = `🎁 Gift from ${viewer}: ${gift}`;
    console.log(message);
    broadcast('log', { message });
  });

  tiktokConnection.on('like', (msg) => {
    const viewer = normalizeViewerName(msg);
    const message = `❤️ Like from ${viewer}`;
    console.log(message);
    broadcast('log', { message });
  });

  tiktokConnection.on('comment', (msg) => {
    const viewer = normalizeViewerName(msg);
    const comment = msg.comment || 'sent a comment';
    const message = `💬 ${viewer}: ${comment}`;
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