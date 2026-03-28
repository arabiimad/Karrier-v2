const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

// In-memory order store for local dev
const orders = [];

const MIME = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.json': 'application/json',
    '.xml':  'application/xml',
    '.webp': 'image/webp',
};

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
    });
}

const server = http.createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    // API: Create order (saves to local store)
    if (req.url === '/api/create-order' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            const data = JSON.parse(body);
            const order = {
                sessionId: data.orderId || `kareer_${Date.now()}`,
                plan: data.planId,
                planLabel: data.plan,
                audience: data.audience,
                amount: data.amount,
                currency: data.currency || 'EUR',
                linkedinEmail: data.linkedinEmail,
                linkedinPassword: data.linkedinPassword,
                customerEmail: data.customerEmail,
                language: data.language || 'fr',
                status: 'pending',
                source: 'checkout-whatsapp',
                createdAt: new Date().toISOString(),
            };
            orders.unshift(order);
            console.log(`✅ Order saved: ${order.sessionId} — ${order.planLabel} — ${order.amount}€ — ${order.linkedinEmail}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, orderId: order.sessionId }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: List orders (for local admin testing)
    if (req.url.startsWith('/api/orders') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders, total: orders.length, page: 1, totalPages: 1 }));
        return;
    }

    // API: Stats (for local admin testing)
    if (req.url.startsWith('/api/stats') && req.method === 'GET') {
        const totalRevenue = orders.reduce((s, o) => s + (o.amount || 0), 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            totalRevenue, totalOrders: orders.length,
            pendingCount: orders.filter(o => o.status === 'pending').length,
            activatingCount: orders.filter(o => o.status === 'activating').length,
            doneCount: orders.filter(o => o.status === 'done').length,
            todayOrders: orders.length, todayRevenue: totalRevenue
        }));
        return;
    }

    // Serve static files
    let filePath = req.url.split('?')[0];
    if (filePath === '/') filePath = '/index.html';
    
    const fullPath = path.join(__dirname, filePath);
    const ext = path.extname(fullPath);

    try {
        if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
            res.writeHead(404);
            return res.end('Not found');
        }
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(content);
    } catch {
        res.writeHead(500);
        res.end('Server error');
    }
});

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   🚀 Kareer Server running              ║
║   http://localhost:${PORT}                 ║
║                                          ║
║   ✅ API: /api/create-order              ║
║   ✅ API: /api/orders (admin)            ║
║   ✅ API: /api/stats  (admin)            ║
╚══════════════════════════════════════════╝
`);
});
