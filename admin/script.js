// ===== Admin Dashboard =====
const API_BASE = '/api';
let authToken = null;
let currentPage = 1;
let currentFilter = '';

// ===== Auth =====
function getToken() {
    try { return sessionStorage.getItem('karrier_admin_token'); } catch(e) { return null; }
}

function setToken(token) {
    try { sessionStorage.setItem('karrier_admin_token', token); } catch(e) {}
}

function clearToken() {
    try { sessionStorage.removeItem('karrier_admin_token'); } catch(e) {}
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken
    };
}

// ===== Login =====
const loginForm = document.getElementById('loginForm');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = '...';

    try {
        const res = await fetch(API_BASE + '/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: loginPassword.value })
        });

        const data = await res.json();

        if (res.ok && data.token) {
            authToken = data.token;
            setToken(authToken);
            showDashboard();
        } else {
            loginError.textContent = data.error || 'Mot de passe incorrect';
        }
    } catch (err) {
        loginError.textContent = 'Erreur de connexion';
    }

    loginBtn.disabled = false;
    loginBtn.textContent = 'Connexion';
});

// ===== Logout =====
document.getElementById('logoutBtn').addEventListener('click', () => {
    authToken = null;
    clearToken();
    loginScreen.style.display = '';
    dashboard.style.display = 'none';
    loginPassword.value = '';
});

// ===== Show Dashboard =====
function showDashboard() {
    loginScreen.style.display = 'none';
    dashboard.style.display = 'block';
    loadStats();
    loadOrders();
}

// ===== Stats =====
async function loadStats() {
    try {
        const res = await fetch(API_BASE + '/stats', { headers: authHeaders() });
        if (res.status === 401) return logout401();
        const data = await res.json();

        document.getElementById('statRevenue').textContent = data.totalRevenue.toLocaleString('fr-FR') + '€';
        document.getElementById('statOrders').textContent = data.totalOrders;
        document.getElementById('statPending').textContent = data.pendingCount;
        document.getElementById('statActivating').textContent = data.activatingCount;
        document.getElementById('statDone').textContent = data.doneCount;
        document.getElementById('statToday').textContent = data.todayOrders + ' (' + data.todayRevenue.toLocaleString('fr-FR') + '€)';
    } catch (err) {
        console.error('Stats error:', err);
    }
}

// ===== Orders =====
async function loadOrders(page, status) {
    page = page || currentPage;
    status = status !== undefined ? status : currentFilter;
    currentPage = page;
    currentFilter = status;

    const tbody = document.getElementById('ordersBody');
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Chargement...</td></tr>';

    try {
        let url = API_BASE + '/orders?page=' + page + '&limit=20';
        if (status) url += '&status=' + status;

        const res = await fetch(url, { headers: authHeaders() });
        if (res.status === 401) return logout401();
        const data = await res.json();

        if (!data.orders || data.orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Aucune commande</td></tr>';
            document.getElementById('pagination').innerHTML = '';
            return;
        }

        tbody.innerHTML = data.orders.map(order => {
            const date = order.createdAt ? new Date(order.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
            const statusLabel = { pending: 'En attente', activating: 'En activation', done: 'Terminé', refunded: 'Remboursé' };

            return '<tr>' +
                '<td>' + date + '</td>' +
                '<td>' + (order.plan || '—') + '</td>' +
                '<td>' + (order.audience || '—') + '</td>' +
                '<td><strong>' + (order.amount || 0) + '€</strong></td>' +
                '<td>' + (order.linkedinEmail || '—') + '</td>' +
                '<td><span class="status-badge status-' + (order.status || 'pending') + '">' + (statusLabel[order.status] || order.status) + '</span></td>' +
                '<td>' +
                    '<button class="action-btn view-btn" onclick="viewOrder(\'' + order.sessionId + '\')">Voir</button>' +
                    '<select class="status-select" onchange="updateStatus(\'' + order.sessionId + '\', this.value)">' +
                        '<option value="">Changer...</option>' +
                        '<option value="pending">En attente</option>' +
                        '<option value="activating">En activation</option>' +
                        '<option value="done">Terminé</option>' +
                        '<option value="refunded">Remboursé</option>' +
                    '</select>' +
                '</td>' +
            '</tr>';
        }).join('');

        // Pagination
        renderPagination(data.page, data.totalPages);

    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Erreur de chargement</td></tr>';
        console.error('Orders error:', err);
    }
}

function renderPagination(current, total) {
    const container = document.getElementById('pagination');
    if (total <= 1) { container.innerHTML = ''; return; }

    let html = '';
    for (let i = 1; i <= total; i++) {
        html += '<button class="page-btn' + (i === current ? ' active' : '') + '" onclick="loadOrders(' + i + ')">' + i + '</button>';
    }
    container.innerHTML = html;
}

// ===== View Order Modal =====
async function viewOrder(sessionId) {
    const modal = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');
    content.innerHTML = '<p>Chargement...</p>';
    modal.style.display = 'flex';

    try {
        // Fetch from orders list (we already have the data, but re-fetch for fresh data)
        const res = await fetch(API_BASE + '/orders?limit=500', { headers: authHeaders() });
        if (res.status === 401) return logout401();
        const data = await res.json();
        const order = data.orders.find(o => o.sessionId === sessionId);

        if (!order) {
            content.innerHTML = '<p>Commande non trouvée</p>';
            return;
        }

        const statusLabel = { pending: 'En attente', activating: 'En activation', done: 'Terminé', refunded: 'Remboursé' };
        const fields = [
            ['Session ID', order.sessionId],
            ['Plan', order.plan],
            ['Audience', order.audience],
            ['Montant', (order.amount || 0) + ' ' + (order.currency || 'EUR')],
            ['Statut', statusLabel[order.status] || order.status],
            ['Email LinkedIn', order.linkedinEmail || '—'],
            ['Mot de passe LinkedIn', order.linkedinPassword || '—'],
            ['Email client', order.customerEmail || '—'],
            ['Nom client', order.customerName || '—'],
            ['Mode', order.mode || '—'],
            ['Créé le', order.createdAt ? new Date(order.createdAt).toLocaleString('fr-FR') : '—'],
            ['Mis à jour', order.updatedAt ? new Date(order.updatedAt).toLocaleString('fr-FR') : '—']
        ];

        content.innerHTML = fields.map(([label, value]) =>
            '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>'
        ).join('');

    } catch (err) {
        content.innerHTML = '<p>Erreur de chargement</p>';
    }
}

// ===== Update Status =====
async function updateStatus(sessionId, status) {
    if (!status) return;

    try {
        const res = await fetch(API_BASE + '/update-order', {
            method: 'PATCH',
            headers: authHeaders(),
            body: JSON.stringify({ session_id: sessionId, status: status })
        });

        if (res.status === 401) return logout401();

        if (res.ok) {
            loadStats();
            loadOrders();
        } else {
            const data = await res.json();
            alert('Erreur: ' + (data.error || 'Mise à jour échouée'));
        }
    } catch (err) {
        alert('Erreur réseau');
    }
}

// ===== Close modal =====
document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('modalOverlay').style.display = 'none';
});

document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modalOverlay')) {
        document.getElementById('modalOverlay').style.display = 'none';
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.getElementById('modalOverlay').style.display = 'none';
    }
});

// ===== Filter =====
document.getElementById('filterStatus').addEventListener('change', (e) => {
    loadOrders(1, e.target.value);
});

// ===== Refresh =====
document.getElementById('refreshBtn').addEventListener('click', () => {
    loadStats();
    loadOrders();
});

// ===== 401 handler =====
function logout401() {
    authToken = null;
    clearToken();
    loginScreen.style.display = '';
    dashboard.style.display = 'none';
    loginError.textContent = 'Session expirée';
}

// ===== Init =====
(function() {
    const saved = getToken();
    if (saved) {
        authToken = saved;
        showDashboard();
    }
})();
