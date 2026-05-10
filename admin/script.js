// ===== Admin Dashboard =====
var API_BASE = '/api';
var authToken = null;
var currentPage = 1;
var currentFilter = '';
var allOrdersCache = [];
var searchTimeout = null;
var lastOrderCount = -1;
var autoRefreshInterval = null;

// ===== Notification Sound =====
function playNotificationSound() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.value = 0.3;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
}

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
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken };
}

// ===== Safe element helper =====
function $(id) { return document.getElementById(id); }
function on(id, evt, fn) { var el = $(id); if (el) el.addEventListener(evt, fn); }

function escapeHTML(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function jsArg(value) {
    return escapeHTML(JSON.stringify(String(value || '')));
}
function getStatusLabel(status) {
    var labels = {
        pending: 'En attente',
        pending_payment: 'Paiement en attente',
        awaiting_credentials: 'Identifiants demandes',
        activating: 'En activation',
        done: 'Termine',
        refunded: 'Rembourse'
    };
    return labels[status] || status || 'pending';
}
function getCredentialLabel(order) {
    if (order.hasCredentials) return 'Identifiants recus';
    if (order.credentialLinkSentAt) return 'Lien envoye';
    return 'Aucun identifiant';
}
function safeDate(value) {
    return value ? new Date(value).toLocaleString('fr-FR') : '-';
}
function renderStatusOptions(selected) {
    var options = [
        ['', 'Changer...'],
        ['pending_payment', 'Paiement en attente'],
        ['awaiting_credentials', 'Identifiants demandes'],
        ['activating', 'En activation'],
        ['done', 'Termine'],
        ['refunded', 'Rembourse']
    ];
    return options.map(function(option) {
        return '<option value="' + option[0] + '"' + (option[0] === selected ? ' selected' : '') + '>' + option[1] + '</option>';
    }).join('');
}
function canSendCredentialLink(order) {
    return order && (order.status === 'pending' || order.status === 'pending_payment' || order.status === 'awaiting_credentials');
}

// ===== Toast =====
function showToast(message, type) {
    type = type || 'info';
    var container = $('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() { toast.classList.add('toast-show'); }, 10);
    setTimeout(function() {
        toast.classList.remove('toast-show');
        setTimeout(function() { toast.remove(); }, 300);
    }, 3500);
}

// ===== Live Clock =====
function updateClock() {
    var el = $('liveClock');
    if (el) el.textContent = new Date().toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// ===== Connection Status =====
function setConnected(ok) {
    var dot = $('connectionDot');
    if (!dot) return;
    dot.className = 'connection-dot ' + (ok ? 'connected' : 'disconnected');
    dot.title = ok ? 'Connecté' : 'Déconnecté';
}

// ===== Show Dashboard =====
function showDashboard() {
    var ls = $('loginScreen');
    var db = $('dashboard');
    if (ls) ls.style.display = 'none';
    if (db) { db.style.display = 'block'; db.classList.add('dashboard-enter'); }
    setConnected(true);
    loadStats();
    loadOrders();
    loadConfigCheck();
    startAutoRefresh();
}

function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(function() {
        // Pause auto-refresh when modal is open or dropdown is active
        var modal = $('modalOverlay');
        if (modal && modal.style.display !== 'none') return;
        if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
        loadStats();
        loadOrders();
    }, 30000);
}

// ===== Logout =====
on('logoutBtn', 'click', function() {
    authToken = null;
    clearToken();
    var ls = $('loginScreen');
    var db = $('dashboard');
    if (ls) ls.style.display = '';
    if (db) db.style.display = 'none';
    var pw = $('loginPassword');
    if (pw) pw.value = '';
});

// ===== 401 handler =====
function logout401() {
    console.log('[logout401] Session expirée - déconnexion');
    authToken = null;
    clearToken();
    var ls = $('loginScreen');
    var db = $('dashboard');
    if (ls) ls.style.display = 'flex';
    if (db) db.style.display = 'none';
    
    // Vider complètement le sessionStorage
    try {
        sessionStorage.clear();
    } catch(e) {}
    
    showToast('Session expirée. Veuillez vous reconnecter.', 'error');
}

// ===== Tabs =====
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        var tab = $('tab-' + btn.dataset.tab);
        if (tab) tab.classList.add('active');
        
        // Charger les données spécifiques à l'onglet
        if (btn.dataset.tab === 'promos') {
            loadPromos();
        }
        if (btn.dataset.tab === 'referrals') {
            loadReferrals();
        }
        if (btn.dataset.tab === 'inbox') {
            loadInbox();
        }
        if (btn.dataset.tab === 'analytics') loadAnalytics();
    });
});

// ===== Stats =====
async function loadStats() {
    try {
        var res = await fetch(API_BASE + '/analytics?type=stats', { headers: authHeaders() });
        if (res.status === 401) return logout401();
        if (res.status === 429) { showToast('Rate limit — patientez', 'error'); return; }
        setConnected(true);
        var data = await res.json();
        var el;
        if ((el = $('statRevenue'))) { el.textContent = data.totalRevenue.toLocaleString('fr-FR') + '€'; el.classList.add('stat-flash'); setTimeout(function() { el.classList.remove('stat-flash'); }, 600); }
        if ((el = $('statOrders'))) el.textContent = data.totalOrders;
        if ((el = $('statPending'))) el.textContent = data.pendingCount;
        if ((el = $('statActivating'))) el.textContent = data.activatingCount;
        if ((el = $('statDone'))) el.textContent = data.doneCount;
        if ((el = $('statToday'))) el.textContent = data.todayOrders + ' (' + data.todayRevenue.toLocaleString('fr-FR') + '€)';

        if (lastOrderCount >= 0 && data.totalOrders > lastOrderCount) {
            playNotificationSound();
            showToast('Nouvelle commande !', 'success');
        }
        lastOrderCount = data.totalOrders;
    } catch (err) {
        setConnected(false);
        console.error('Stats error:', err);
    }
}

// ===== Orders =====
async function loadOrders(page, status) {
    page = page || currentPage;
    status = status !== undefined ? status : currentFilter;
    currentPage = page;
    currentFilter = status;

    var tbody = $('ordersBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><div class="loading-spinner"></div> Chargement...</td></tr>';

    try {
        var url = API_BASE + '/orders?page=' + page + '&limit=20';
        if (status) url += '&status=' + status;
        if (currentSearch) url += '&search=' + encodeURIComponent(currentSearch);

        var res = await fetch(url, { headers: authHeaders() });
        if (res.status === 401) return logout401();
        var data = await res.json();

        allOrdersCache = data.orders || [];

        // Update order count badge
        var countEl = $('ordersCount');
        if (countEl) countEl.textContent = data.total ? data.total + ' commande(s)' : '';

        if (!data.orders || data.orders.length === 0) {
            var emptyMsg = currentSearch ? 'Aucun résultat pour "' + currentSearch + '"' : 'Aucune commande';
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state">' + emptyMsg + '</td></tr>';
            var pg = $('pagination'); if (pg) pg.innerHTML = '';
            return;
        }

        renderOrdersV2(data.orders);
        renderPagination(data.page, data.totalPages);

    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Erreur de chargement</td></tr>';
        console.error('Orders error:', err);
    }
}

function renderOrders(orders) {
    return renderOrdersV2(orders);
    var tbody = $('ordersBody');
    if (!tbody) return;
    var statusLabel = { pending: 'En attente', activating: 'En activation', done: 'Terminé', refunded: 'Remboursé' };

    tbody.innerHTML = orders.map(function(order) {
        var date = order.createdAt ? new Date(order.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        return '<tr>' +
            '<td>' + date + '</td>' +
            '<td><span class="plan-badge plan-' + (order.plan || '') + '">' + (order.plan || '—') + '</span></td>' +
            '<td>' + (order.audience || '—') + '</td>' +
            '<td><strong>' + (order.amount || 0) + '€</strong></td>' +
            '<td class="email-cell">' + (order.customerEmail || '—') + '</td>' +
            '<td class="email-cell">' + (order.linkedinEmail || '—') + '</td>' +
            '<td><span class="status-badge status-' + (order.status || 'pending') + '">' + (statusLabel[order.status] || order.status) + '</span></td>' +
            '<td class="actions-cell">' +
                '<button class="action-btn view-btn" onclick="viewOrder(\'' + order.sessionId + '\')">👁️</button>' +
                '<button class="action-btn copy-btn" onclick="revealCredentials(\'' + order.sessionId + '\')" title="Reveler / copier">Reveler</button>' +
                '<button class="action-btn delete-btn" onclick="deleteOrder(\'' + order.sessionId + '\')" title="Supprimer">🗑️</button>' +
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
}

function renderOrdersV2(orders) {
    var tbody = $('ordersBody');
    if (!tbody) return;

    tbody.innerHTML = orders.map(function(order) {
        var date = order.createdAt ? new Date(order.createdAt).toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }) : '-';
        var status = order.status || 'pending_payment';
        var plan = order.plan || order.planLabel || '-';
        var actions = '';

        actions += '<button class="action-btn view-btn" onclick="viewOrderSafe(' + jsArg(order.sessionId) + ')" title="Voir">Voir</button>';
        if (canSendCredentialLink(order)) {
            actions += '<button class="action-btn copy-btn" onclick="sendCredentialLink(' + jsArg(order.sessionId) + ')" title="Paiement recu / envoyer lien">Lien</button>';
        }
        if (order.hasCredentials) {
            actions += '<button class="action-btn copy-btn" onclick="revealCredentials(' + jsArg(order.sessionId) + ')" title="Reveler / copier">Reveler</button>';
        }
        actions += '<button class="action-btn delete-btn" onclick="deleteOrder(' + jsArg(order.sessionId) + ')" title="Supprimer">Suppr.</button>';
        actions += '<select class="status-select" onchange="updateStatus(' + jsArg(order.sessionId) + ', this.value)">' + renderStatusOptions('') + '</select>';

        return '<tr>' +
            '<td>' + escapeHTML(date) + '</td>' +
            '<td><span class="plan-badge plan-' + escapeHTML(order.plan || '') + '">' + escapeHTML(plan) + '</span></td>' +
            '<td>' + escapeHTML(order.audience || '-') + '</td>' +
            '<td><strong>' + escapeHTML(order.amount || 0) + ' EUR</strong></td>' +
            '<td class="email-cell">' + escapeHTML(order.customerEmail || '-') + '</td>' +
            '<td class="email-cell">' + escapeHTML(order.linkedinEmail || '-') + '</td>' +
            '<td><span class="status-badge status-' + escapeHTML(status) + '">' + escapeHTML(getStatusLabel(status)) + '</span><br><small>' + escapeHTML(getCredentialLabel(order)) + '</small></td>' +
            '<td class="actions-cell">' + actions + '</td>' +
        '</tr>';
    }).join('');
}

function renderPagination(current, total) {
    var container = $('pagination');
    if (!container) return;
    if (total <= 1) { container.innerHTML = ''; return; }
    var html = '';
    if (current > 1) html += '<button class="page-btn" onclick="loadOrders(' + (current - 1) + ')">‹</button>';
    for (var i = 1; i <= total; i++) {
        if (i === 1 || i === total || (i >= current - 2 && i <= current + 2)) {
            html += '<button class="page-btn' + (i === current ? ' active' : '') + '" onclick="loadOrders(' + i + ')">' + i + '</button>';
        } else if (i === current - 3 || i === current + 3) {
            html += '<span class="page-dots">...</span>';
        }
    }
    if (current < total) html += '<button class="page-btn" onclick="loadOrders(' + (current + 1) + ')">›</button>';
    container.innerHTML = html;
}

// ===== Search (server-side) =====
var currentSearch = '';
on('searchInput', 'input', function() {
    var input = $('searchInput');
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function() {
        var query = input.value.trim();
        currentSearch = query;
        loadOrders(1, currentFilter);
    }, 400);
});

// ===== Copy to clipboard =====
function copyToClipboard(email, password) {
    var text = 'Email: ' + email + '\nPassword: ' + password;
    navigator.clipboard.writeText(text).then(function() {
        showToast('Identifiants copiés !', 'success');
    }).catch(function() {
        showToast('Erreur de copie', 'error');
    });
}

// ===== View Order Modal =====
async function viewOrder(sessionId) {
    return viewOrderSafe(sessionId);
    var modal = $('modalOverlay');
    var content = $('modalContent');
    var actions = $('modalActions');
    if (!modal || !content) return;
    content.innerHTML = '<p><div class="loading-spinner"></div> Chargement...</p>';
    if (actions) actions.innerHTML = '';
    modal.style.display = 'flex';

    try {
        // Check local cache first
        var order = allOrdersCache.find(function(o) { return o.sessionId === sessionId; });
        if (!order) {
            var res = await fetch(API_BASE + '/orders?search=' + encodeURIComponent(sessionId) + '&limit=1', { headers: authHeaders() });
            if (res.status === 401) return logout401();
            var data = await res.json();
            order = data.orders && data.orders[0];
        }

        if (!order) { content.innerHTML = '<p>Commande non trouvée</p>'; return; }

        var statusLabel = { pending: 'En attente', activating: 'En activation', done: 'Terminé', refunded: 'Remboursé' };
        var fields = [
            ['Session ID', '<code>' + order.sessionId + '</code>'],
            ['Plan', '<span class="plan-badge plan-' + order.plan + '">' + order.plan + '</span>'],
            ['Audience', order.audience],
            ['Montant', '<strong>' + (order.amount || 0) + ' ' + (order.currency || 'EUR').toUpperCase() + '</strong>'],
            ['Statut', '<span class="status-badge status-' + order.status + '">' + (statusLabel[order.status] || order.status) + '</span>'],
            ['Email LinkedIn', order.linkedinEmail || '—'],
            ['Identifiants LinkedIn', order.hasCredentials ? 'Disponibles via Reveler / copier' : 'Non recus'],
            ['Email client', order.customerEmail || '—'],
            ['Langue', order.language || 'fr'],
            ['Créé le', order.createdAt ? new Date(order.createdAt).toLocaleString('fr-FR') : '—'],
            ['Mis à jour', order.updatedAt ? new Date(order.updatedAt).toLocaleString('fr-FR') : '—']
        ];
        if (order.refundId) {
            fields.push(['Remboursement ID', '<code>' + order.refundId + '</code>']);
            fields.push(['Remboursé le', order.refundedAt ? new Date(order.refundedAt).toLocaleString('fr-FR') : '—']);
        }
        content.innerHTML = fields.map(function(f) {
            return '<div class="detail-row"><span class="detail-label">' + f[0] + '</span><span class="detail-value">' + f[1] + '</span></div>';
        }).join('');

        if (actions) {
            actions.innerHTML =
                '<button class="auto-btn" onclick="revealCredentials(\'' + order.sessionId + '\')">Reveler / copier</button>' +
                '<button class="auto-btn" onclick="sendReminderFromModal(\'' + order.sessionId + '\')">📧 Envoyer rappel</button>' +
                (order.status !== 'refunded' ? '<button class="auto-btn auto-btn-danger" onclick="refundFromModal(\'' + order.sessionId + '\')">💸 Rembourser</button>' : '');
        }
    } catch (err) {
        content.innerHTML = '<p>Erreur de chargement</p>';
    }
}

function copyText(text, successMessage) {
    if (!navigator.clipboard) {
        showToast('Copie indisponible dans ce navigateur', 'error');
        return Promise.resolve(false);
    }
    return navigator.clipboard.writeText(text).then(function() {
        showToast(successMessage || 'Copie effectuee', 'success');
        return true;
    }).catch(function() {
        showToast('Erreur de copie', 'error');
        return false;
    });
}

async function sendCredentialLink(sessionId) {
    try {
        var res = await fetch(API_BASE + '/update-order', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ action: 'credential_link', session_id: sessionId })
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (!data.success) {
            return showToast('Erreur: ' + (data.error || 'Echec'), 'error');
        }
        if (data.link) {
            await copyText(data.link, data.emailSent ? 'Lien envoye par email et copie' : 'Lien copie');
        } else {
            showToast(data.emailSent ? 'Lien envoye par email' : 'Lien genere', 'success');
        }
        loadStats();
        loadOrders();
    } catch (err) {
        showToast('Erreur reseau', 'error');
    }
}

async function revealCredentials(sessionId) {
    if (!confirm('Reveler et copier le mot de passe LinkedIn pour cette commande ?')) return;
    try {
        var res = await fetch(API_BASE + '/update-order', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ action: 'reveal_credentials', session_id: sessionId })
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (!data.success) {
            return showToast('Erreur: ' + (data.error || 'Echec'), 'error');
        }
        var text = 'Email LinkedIn: ' + (data.linkedinEmail || '') + '\nMot de passe: ' + data.linkedinPassword;
        await copyText(text, 'Identifiants copies');
    } catch (err) {
        showToast('Erreur reseau', 'error');
    }
}

async function viewOrderSafe(sessionId) {
    var modal = $('modalOverlay');
    var content = $('modalContent');
    var actions = $('modalActions');
    if (!modal || !content) return;
    content.innerHTML = '<p><div class="loading-spinner"></div> Chargement...</p>';
    if (actions) actions.innerHTML = '';
    modal.style.display = 'flex';

    try {
        var order = allOrdersCache.find(function(o) { return o.sessionId === sessionId; });
        if (!order) {
            var res = await fetch(API_BASE + '/orders?search=' + encodeURIComponent(sessionId) + '&limit=1', { headers: authHeaders() });
            if (res.status === 401) return logout401();
            var data = await res.json();
            order = data.orders && data.orders[0];
        }

        if (!order) {
            content.innerHTML = '<p>Commande non trouvee</p>';
            return;
        }

        var status = order.status || 'pending_payment';
        var credentialStatus = getCredentialLabel(order);
        var fields = [
            ['Session ID', '<code>' + escapeHTML(order.sessionId) + '</code>'],
            ['Plan', '<span class="plan-badge plan-' + escapeHTML(order.plan || '') + '">' + escapeHTML(order.planLabel || order.plan || '-') + '</span>'],
            ['Audience', escapeHTML(order.audience || '-')],
            ['Montant', '<strong>' + escapeHTML(order.amount || 0) + ' ' + escapeHTML((order.currency || 'EUR').toUpperCase()) + '</strong>'],
            ['Statut', '<span class="status-badge status-' + escapeHTML(status) + '">' + escapeHTML(getStatusLabel(status)) + '</span>'],
            ['Email LinkedIn', escapeHTML(order.linkedinEmail || '-')],
            ['Identifiants', escapeHTML(credentialStatus)],
            ['Lien envoye le', escapeHTML(safeDate(order.credentialLinkSentAt))],
            ['Lien expire le', escapeHTML(safeDate(order.credentialLinkExpiresAt))],
            ['Identifiants recus le', escapeHTML(safeDate(order.credentialsSubmittedAt))],
            ['Credentials supprimes le', escapeHTML(safeDate(order.credentialsDeletedAt))],
            ['Email client', escapeHTML(order.customerEmail || '-')],
            ['Langue', escapeHTML(order.language || 'fr')],
            ['Cree le', escapeHTML(safeDate(order.createdAt))],
            ['Mis a jour', escapeHTML(safeDate(order.updatedAt))]
        ];
        if (order.refundId) {
            fields.push(['Remboursement ID', '<code>' + escapeHTML(order.refundId) + '</code>']);
            fields.push(['Rembourse le', escapeHTML(safeDate(order.refundedAt))]);
        }
        content.innerHTML = fields.map(function(f) {
            return '<div class="detail-row"><span class="detail-label">' + f[0] + '</span><span class="detail-value">' + f[1] + '</span></div>';
        }).join('');

        if (actions) {
            var html = '';
            if (canSendCredentialLink(order)) {
                html += '<button class="auto-btn" onclick="sendCredentialLink(' + jsArg(order.sessionId) + ')">Paiement recu / envoyer lien</button>';
            }
            if (order.hasCredentials) {
                html += '<button class="auto-btn" onclick="revealCredentials(' + jsArg(order.sessionId) + ')">Reveler / copier</button>';
            }
            html += '<button class="auto-btn" onclick="sendReminderFromModal(' + jsArg(order.sessionId) + ')">Envoyer rappel</button>';
            if (order.status !== 'refunded') {
                html += '<button class="auto-btn auto-btn-danger" onclick="refundFromModal(' + jsArg(order.sessionId) + ')">Rembourser</button>';
            }
            actions.innerHTML = html;
        }
    } catch (err) {
        content.innerHTML = '<p>Erreur de chargement</p>';
    }
}

async function sendReminderFromModal(sessionId) {
    try {
        var res = await fetch(API_BASE + '/automation', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'send_reminder', session_id: sessionId }) });
        var data = await res.json();
        showToast(data.success ? 'Rappel envoyé !' : 'Erreur: ' + (data.error || 'Échec'), data.success ? 'success' : 'error');
    } catch (err) { showToast('Erreur réseau', 'error'); }
}

async function refundFromModal(sessionId) {
    if (!confirm('Confirmer le remboursement de cette commande ?')) return;
    try {
        var res = await fetch(API_BASE + '/refund', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ session_id: sessionId, reason: 'requested_by_customer' }) });
        var data = await res.json();
        if (data.success) {
            showToast('Remboursement effectué: ' + data.refund.amount + '€', 'success');
            var m = $('modalOverlay'); if (m) m.style.display = 'none';
            loadStats(); loadOrders();
        } else { showToast('Erreur: ' + (data.error || 'Échec'), 'error'); }
    } catch (err) { showToast('Erreur réseau', 'error'); }
}

// ===== Update Status =====
async function updateStatus(sessionId, status) {
    if (!status) return;
    try {
        var res = await fetch(API_BASE + '/update-order', { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ session_id: sessionId, status: status }) });
        var data = await res.json();
        if (data.success) { showToast('Statut mis à jour', 'success'); loadStats(); loadOrders(); }
        else { showToast('Erreur: ' + (data.error || 'Échec'), 'error'); }
    } catch (err) { showToast('Erreur réseau', 'error'); }
}

// ===== Delete Order =====
async function deleteOrder(sessionId) {
    if (!confirm('⚠️ Supprimer définitivement cette commande ?\n\nCette action est irréversible.')) return;
    try {
        var res = await fetch(API_BASE + '/update-order?session_id=' + encodeURIComponent(sessionId), { method: 'DELETE', headers: authHeaders() });
        var data = await res.json();
        if (data.success) { 
            showToast('Commande supprimée', 'success'); 
            loadStats(); 
            loadOrders(); 
        } else { 
            showToast('Erreur: ' + (data.error || 'Échec'), 'error'); 
        }
    } catch (err) { 
        showToast('Erreur réseau', 'error'); 
    }
}

// ===== Analytics =====
async function loadAnalytics() {
    var periodEl = $('analyticsPeriod');
    var period = periodEl ? periodEl.value : '30';
    try {
        var res = await fetch(API_BASE + '/analytics?period=' + period, { headers: authHeaders() });
        if (res.status === 401) return logout401();
        var data = await res.json();
        renderRevenueChart(data.revenue.daily || []);
        renderBreakdown('planBreakdown', data.revenue.byPlan || {}, data.orders.byPlan || {}, '€');
        renderBreakdown('audienceBreakdown', data.revenue.byAudience || {}, data.orders.byAudience || {}, '€');
        renderLanguageBreakdown(data.orders.byLanguage || {});
        renderKPIs(data);
    } catch (err) { console.error('Analytics error:', err); showToast('Erreur chargement analytics', 'error'); }
}

function renderRevenueChart(daily) {
    var container = $('revenueChart');
    if (!container) return;
    if (!daily.length) { container.innerHTML = '<p class="empty-state">Aucune donnée</p>'; return; }
    var maxRevenue = Math.max.apply(null, daily.map(function(d) { return d.revenue; })) || 1;
    var html = '<div class="bar-chart">';
    daily.forEach(function(d) {
        var height = Math.max(4, (d.revenue / maxRevenue) * 100);
        var label = d.date.substring(5);
        html += '<div class="bar-col" title="' + d.date + ': ' + d.revenue + '€ (' + d.orders + ' cmd)"><div class="bar-value">' + d.revenue + '€</div><div class="bar" style="height:' + height + '%"></div><div class="bar-label">' + label + '</div></div>';
    });
    html += '</div>';
    container.innerHTML = html;
}

function renderBreakdown(containerId, revenueMap, ordersMap, suffix) {
    var container = $(containerId);
    if (!container) return;
    var entries = Object.entries(revenueMap).sort(function(a, b) { return b[1] - a[1]; });
    if (!entries.length) { container.innerHTML = '<p class="empty-state">Aucune donnée</p>'; return; }
    var total = entries.reduce(function(s, e) { return s + e[1]; }, 0) || 1;
    container.innerHTML = entries.map(function(e) {
        var pct = ((e[1] / total) * 100).toFixed(1);
        var orders = ordersMap[e[0]] || 0;
        return '<div class="breakdown-item"><div class="breakdown-header"><span class="breakdown-name">' + e[0] + '</span><span class="breakdown-value">' + e[1].toLocaleString('fr-FR') + suffix + ' (' + orders + ')</span></div><div class="breakdown-bar"><div class="breakdown-fill" style="width:' + pct + '%"></div></div></div>';
    }).join('');
}

function renderLanguageBreakdown(langMap) {
    var container = $('languageBreakdown');
    if (!container) return;
    var langNames = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch' };
    var entries = Object.entries(langMap).sort(function(a, b) { return b[1] - a[1]; });
    if (!entries.length) { container.innerHTML = '<p class="empty-state">Aucune donnée</p>'; return; }
    var total = entries.reduce(function(s, e) { return s + e[1]; }, 0) || 1;
    container.innerHTML = entries.map(function(e) {
        var pct = ((e[1] / total) * 100).toFixed(1);
        return '<div class="breakdown-item"><div class="breakdown-header"><span class="breakdown-name">' + (langNames[e[0]] || e[0]) + '</span><span class="breakdown-value">' + e[1] + ' (' + pct + '%)</span></div><div class="breakdown-bar"><div class="breakdown-fill" style="width:' + pct + '%"></div></div></div>';
    }).join('');
}

function renderKPIs(data) {
    var container = $('kpiSection');
    if (!container) return;
    var kpis = [
        { label: 'Revenu total', value: data.revenue.total.toLocaleString('fr-FR') + '€' },
        { label: 'Commandes', value: data.orders.total },
        { label: 'Panier moyen', value: data.conversion.averageOrderValue.toFixed(2) + '€' },
        { label: 'Taux complétion', value: data.conversion.completionRate.toFixed(1) + '%' }
    ];
    if (data.topPlans && data.topPlans.length) {
        kpis.push({ label: 'Top plan', value: data.topPlans[0].plan + ' (' + data.topPlans[0].revenue + '€)' });
    }
    container.innerHTML = kpis.map(function(k) {
        return '<div class="kpi-item"><span class="kpi-label">' + k.label + '</span><span class="kpi-value">' + k.value + '</span></div>';
    }).join('');
}

on('refreshAnalytics', 'click', loadAnalytics);
on('analyticsPeriod', 'change', loadAnalytics);

// ===== Inbox =====
var inboxCache = [];
var currentInboxId = null;

async function loadInbox() {
    var list = $('inboxList');
    var count = $('inboxCount');
    if (!list) return;
    list.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div> Chargement...</div>';

    try {
        var res = await fetch(API_BASE + '/inbox?limit=80', { headers: authHeaders() });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erreur inbox');

        inboxCache = data.items || [];
        if (count) count.textContent = data.total + ' message(s)';
        renderInboxList();

        if (currentInboxId) {
            viewInboxMessage(currentInboxId);
        }
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Erreur de chargement inbox</div>';
        showToast('Erreur inbox: ' + err.message, 'error');
    }
}

function renderInboxList() {
    var list = $('inboxList');
    if (!list) return;

    if (!inboxCache.length) {
        list.innerHTML = '<div class="empty-state">Aucun message reçu</div>';
        return;
    }

    list.innerHTML = inboxCache.map(function(item) {
        var classes = 'inbox-item' + (item.read ? '' : ' unread') + (item.id === currentInboxId ? ' active' : '');
        var orderBadge = item.orderMatches && item.orderMatches.length ? '<span class="inbox-badge">Commande ' + escapeHTML(item.orderMatches[0].sessionId) + '</span>' : '';
        return '<div class="' + classes + '" onclick="viewInboxMessage(' + jsArg(item.id) + ')">' +
            '<div class="inbox-item-top">' +
                '<div class="inbox-from">' + escapeHTML(item.fromEmail || item.from || '-') + '</div>' +
                '<div class="inbox-date">' + escapeHTML(safeDate(item.receivedAt)) + '</div>' +
            '</div>' +
            '<div class="inbox-subject">' + escapeHTML(item.subject || '(sans objet)') + '</div>' +
            '<div class="inbox-preview">' + escapeHTML(item.preview || '') + '</div>' +
            orderBadge +
        '</div>';
    }).join('');
}

async function viewInboxMessage(id) {
    currentInboxId = id;
    renderInboxList();
    var detail = $('inboxDetail');
    if (!detail) return;
    detail.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div> Chargement...</div>';

    try {
        var res = await fetch(API_BASE + '/inbox?id=' + encodeURIComponent(id), { headers: authHeaders() });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (!data.success) throw new Error(data.error || 'Message introuvable');

        renderInboxDetail(data.item);
        if (!data.item.read) markInboxRead(id, true);
    } catch (err) {
        detail.innerHTML = '<div class="empty-state">Erreur de chargement du message</div>';
        showToast('Erreur message: ' + err.message, 'error');
    }
}

function renderInboxDetail(item) {
    var detail = $('inboxDetail');
    if (!detail) return;
    var orders = item.orderMatches && item.orderMatches.length
        ? item.orderMatches.map(function(order) {
            return '<div class="inbox-badge">Commande ' + escapeHTML(order.sessionId) + ' · ' + escapeHTML(getStatusLabel(order.status)) + '</div>';
        }).join(' ')
        : '<span class="inbox-meta">Aucune commande liée automatiquement</span>';

    var thread = (item.messages || []).map(function(message) {
        var label = message.direction === 'outgoing' ? 'Réponse envoyée · ' + safeDate(message.createdAt) : 'Message reçu · ' + safeDate(message.createdAt);
        return '<div class="inbox-message ' + escapeHTML(message.direction || 'incoming') + '">' +
            '<div class="inbox-message-label">' + escapeHTML(label) + '</div>' +
            '<div class="inbox-message-body">' + escapeHTML(message.text || '') + '</div>' +
        '</div>';
    }).join('');

    detail.innerHTML =
        '<div class="inbox-thread-header">' +
            '<h2>' + escapeHTML(item.subject || '(sans objet)') + '</h2>' +
            '<div class="inbox-meta">' +
                '<div><strong>De :</strong> ' + escapeHTML(item.from || '-') + '</div>' +
                '<div><strong>À :</strong> ' + escapeHTML((item.to || []).join(', ')) + '</div>' +
                '<div><strong>Boîte :</strong> ' + escapeHTML(item.mailbox || '-') + '</div>' +
                '<div><strong>Reçu :</strong> ' + escapeHTML(safeDate(item.receivedAt)) + '</div>' +
            '</div>' +
            '<div style="margin-top:12px">' + orders + '</div>' +
        '</div>' +
        '<div class="inbox-thread">' + thread + '</div>' +
        '<div class="inbox-reply-box">' +
            '<textarea id="inboxReplyBody" class="auto-input" placeholder="Votre réponse..."></textarea>' +
            '<div class="auto-row">' +
                '<select id="inboxReplyFrom" class="auto-select">' +
                    '<option value="' + escapeHTML(item.mailbox || 'contact@kareer.pro') + '">' + escapeHTML(item.mailbox || 'contact@kareer.pro') + '</option>' +
                    '<option value="contact@kareer.pro">contact@kareer.pro</option>' +
                    '<option value="notifications@kareer.pro">notifications@kareer.pro</option>' +
                '</select>' +
                '<button class="auto-btn" onclick="replyInboxMessage(' + jsArg(item.id) + ')">Répondre</button>' +
                '<button class="auto-btn auto-btn-warning" onclick="markInboxRead(' + jsArg(item.id) + ', false)">Marquer lu</button>' +
            '</div>' +
            '<div class="auto-result" id="resultInboxReply"></div>' +
        '</div>';
}

async function markInboxRead(id, silent) {
    try {
        var res = await fetch(API_BASE + '/inbox', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ action: 'mark_read', id: id })
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (data.success) {
            inboxCache = inboxCache.map(function(item) {
                if (item.id === id) item.read = true;
                return item;
            });
            renderInboxList();
            if (!silent) showToast('Message marqué comme lu', 'success');
        }
    } catch (err) {
        if (!silent) showToast('Erreur inbox', 'error');
    }
}

async function replyInboxMessage(id) {
    var bodyEl = $('inboxReplyBody');
    var fromEl = $('inboxReplyFrom');
    var result = $('resultInboxReply');
    var message = bodyEl ? bodyEl.value.trim() : '';
    if (!message) return showToast('Écrivez une réponse', 'error');
    if (result) result.textContent = 'Envoi...';

    try {
        var res = await fetch(API_BASE + '/inbox', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                action: 'reply',
                id: id,
                message: message,
                fromAddress: fromEl ? fromEl.value : undefined
            })
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (!data.success) throw new Error(data.error || 'Réponse non envoyée');

        if (result) { result.textContent = 'Réponse envoyée'; result.className = 'auto-result auto-result-success'; }
        if (bodyEl) bodyEl.value = '';
        showToast('Réponse envoyée', 'success');
        renderInboxDetail(data.item);
        loadInbox();
    } catch (err) {
        if (result) { result.textContent = err.message; result.className = 'auto-result auto-result-error'; }
        showToast('Erreur réponse: ' + err.message, 'error');
    }
}

on('refreshInbox', 'click', loadInbox);

// ===== Automation Buttons =====
on('btnProcessPending', 'click', async function() {
    this.disabled = true;
    var result = $('resultProcessPending');
    if (result) result.textContent = 'Traitement...';
    try {
        var res = await fetch(API_BASE + '/automation', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'process_pending' }) });
        var data = await res.json();
        if (data.success) { if (result) { result.textContent = data.result.processed + ' commande(s) traitée(s)'; result.className = 'auto-result auto-result-success'; } showToast(data.result.processed + ' commande(s) traitée(s)', 'success'); loadStats(); }
        else { if (result) { result.textContent = 'Erreur: ' + (data.error || 'Échec'); result.className = 'auto-result auto-result-error'; } }
    } catch (err) { if (result) { result.textContent = 'Erreur réseau'; result.className = 'auto-result auto-result-error'; } }
    this.disabled = false;
});

on('btnSendReminder', 'click', async function() {
    var sid = $('reminderSessionId'); if (!sid || !sid.value.trim()) return showToast('Entrez un Session ID', 'error');
    this.disabled = true;
    var result = $('resultSendReminder'); if (result) result.textContent = 'Envoi...';
    try {
        var res = await fetch(API_BASE + '/automation', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'send_reminder', session_id: sid.value.trim() }) });
        var data = await res.json();
        if (data.success && data.result.sent) { if (result) { result.textContent = 'Email envoyé à ' + data.result.email; result.className = 'auto-result auto-result-success'; } showToast('Rappel envoyé !', 'success'); }
        else { if (result) { result.textContent = data.error || (data.result && data.result.reason) || 'Non envoyé'; result.className = 'auto-result auto-result-error'; } }
    } catch (err) { if (result) { result.textContent = 'Erreur réseau'; result.className = 'auto-result auto-result-error'; } }
    this.disabled = false;
});

on('btnSendLegacyClientOffer', 'click', async function() {
    var emailEl = $('legacyClientEmail');
    var firstNameEl = $('legacyClientFirstName');
    var email = emailEl ? emailEl.value.trim() : '';
    var firstName = firstNameEl ? firstNameEl.value.trim() : '';
    if (!email) return showToast('Entrez une adresse email', 'error');
    if (!firstName) return showToast('Entrez le prénom', 'error');
    if (!confirm('Envoyer l’offre ancien client à ' + firstName + ' <' + email + '> ?')) return;

    this.disabled = true;
    var result = $('resultLegacyClientOffer');
    if (result) result.textContent = 'Envoi...';
    try {
        var res = await fetch(API_BASE + '/automation', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                action: 'send_legacy_customer_offer',
                email: email,
                firstName: firstName
            })
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (data.success && data.result && data.result.sent) {
            if (result) {
                result.textContent = 'Email envoyé à ' + data.result.email + ' avec le code ' + data.result.promoCode;
                result.className = 'auto-result auto-result-success';
            }
            showToast('Offre envoyée !', 'success');
            if (emailEl) emailEl.value = '';
            if (firstNameEl) firstNameEl.value = '';
        } else {
            var message = data.error || (data.result && data.result.reason) || 'Non envoyé';
            if (result) { result.textContent = message; result.className = 'auto-result auto-result-error'; }
            showToast(message, 'error');
        }
    } catch (err) {
        if (result) { result.textContent = 'Erreur réseau'; result.className = 'auto-result auto-result-error'; }
        showToast('Erreur réseau', 'error');
    }
    this.disabled = false;
});

on('btnBulkUpdate', 'click', async function() {
    var fromEl = $('bulkFrom'), toEl = $('bulkTo');
    if (!fromEl || !toEl) return;
    var from = fromEl.value, to = toEl.value;
    if (from === to) return showToast('Les statuts doivent être différents', 'error');
    if (!confirm('Changer toutes les commandes "' + from + '" en "' + to + '" ?')) return;
    this.disabled = true;
    var result = $('resultBulkUpdate'); if (result) result.textContent = 'Mise à jour...';
    try {
        var res = await fetch(API_BASE + '/automation', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'bulk_update', from_status: from, to_status: to }) });
        var data = await res.json();
        if (data.success) { if (result) { result.textContent = data.result.updated + ' commande(s) mise(s) à jour'; result.className = 'auto-result auto-result-success'; } showToast(data.result.updated + ' commande(s) mise(s) à jour', 'success'); loadStats(); loadOrders(); }
        else { if (result) { result.textContent = 'Erreur: ' + (data.error || 'Échec'); result.className = 'auto-result auto-result-error'; } }
    } catch (err) { if (result) { result.textContent = 'Erreur réseau'; result.className = 'auto-result auto-result-error'; } }
    this.disabled = false;
});

on('btnRefund', 'click', async function() {
    var sid = $('refundSessionId'), reasonEl = $('refundReason');
    if (!sid || !sid.value.trim()) return showToast('Entrez un Session ID', 'error');
    if (!confirm('Confirmer le remboursement ?')) return;
    this.disabled = true;
    var result = $('resultRefund'); if (result) result.textContent = 'Remboursement...';
    try {
        var res = await fetch(API_BASE + '/refund', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ session_id: sid.value.trim(), reason: reasonEl ? reasonEl.value : 'requested_by_customer' }) });
        var data = await res.json();
        if (data.success) { if (result) { result.textContent = 'Remboursé: ' + data.refund.amount + '€ (ID: ' + data.refund.id + ')'; result.className = 'auto-result auto-result-success'; } showToast('Remboursement effectué: ' + data.refund.amount + '€', 'success'); loadStats(); loadOrders(); }
        else { if (result) { result.textContent = 'Erreur: ' + (data.error || 'Échec'); result.className = 'auto-result auto-result-error'; } }
    } catch (err) { if (result) { result.textContent = 'Erreur réseau'; result.className = 'auto-result auto-result-error'; } }
    this.disabled = false;
});

on('btnCleanup', 'click', async function() {
    var daysEl = $('cleanupDays');
    var days = daysEl ? parseInt(daysEl.value, 10) : 90;
    if (!days || days < 30) return showToast('Minimum 30 jours', 'error');
    if (!confirm('Supprimer les commandes terminées/remboursées de plus de ' + days + ' jours ?')) return;
    this.disabled = true;
    var result = $('resultCleanup'); if (result) result.textContent = 'Nettoyage...';
    try {
        var res = await fetch(API_BASE + '/automation', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'cleanup_old', days: days }) });
        var data = await res.json();
        if (data.success) { if (result) { result.textContent = data.result.cleaned + ' commande(s) supprimée(s), ' + data.result.totalRemaining + ' restante(s)'; result.className = 'auto-result auto-result-success'; } showToast(data.result.cleaned + ' commande(s) nettoyée(s)', 'success'); loadStats(); loadOrders(); }
        else { if (result) { result.textContent = 'Erreur: ' + (data.error || 'Échec'); result.className = 'auto-result auto-result-error'; } }
    } catch (err) { if (result) { result.textContent = 'Erreur réseau'; result.className = 'auto-result auto-result-error'; } }
    this.disabled = false;
});

// ===== Export =====
on('btnExport', 'click', async function() {
    var formatEl = $('exportFormat'), statusEl = $('exportStatus');
    var format = formatEl ? formatEl.value : 'csv';
    var status = statusEl ? statusEl.value : '';
    var url = API_BASE + '/export?format=' + format;
    if (status) url += '&status=' + status;
    try {
        var res = await fetch(url, { headers: authHeaders() });
        if (res.status === 401) return logout401();
        var blob = await res.blob();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'karrier-orders.' + format;
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('Export téléchargé !', 'success');
    } catch (err) { showToast('Erreur export', 'error'); }
});

// ===== Close modal =====
on('modalClose', 'click', function() { var m = $('modalOverlay'); if (m) m.style.display = 'none'; });
on('modalOverlay', 'click', function(e) { if (e.target === $('modalOverlay')) { $('modalOverlay').style.display = 'none'; } });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { var m = $('modalOverlay'); if (m) m.style.display = 'none'; } });

// ===== Filter =====
on('filterStatus', 'change', function(e) { loadOrders(1, e.target.value); });

// ===== Refresh =====
on('refreshBtn', 'click', async function() {
    var icon = $('refreshIcon');
    if (icon) icon.classList.add('spin');
    await Promise.all([loadStats(), loadOrders()]);
    if (icon) icon.classList.remove('spin');
    showToast('Données actualisées', 'info');
});

// ===== Config Check =====
async function loadConfigCheck() {
    try {
        var res = await fetch(API_BASE + '/config-check', { headers: authHeaders() });
        if (res.status === 401) return;
        var data = await res.json();
        [{ id: 'cfgStripe', ok: data.stripe }, { id: 'cfgWebhook', ok: data.webhook }, { id: 'cfgResend', ok: data.resend }, { id: 'cfgTelegram', ok: data.telegram }, { id: 'cfgKV', ok: data.kv }, { id: 'cfgCredentials', ok: data.credentialsEncryption }].forEach(function(item) {
            var el = $(item.id); if (!el) return;
            el.textContent = item.ok ? 'Actif' : 'Non configuré';
            el.style.background = item.ok ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
            el.style.color = item.ok ? '#10B981' : '#EF4444';
        });
    } catch (err) { console.error('Config check error:', err); }
}

// ===== authFetch =====
async function authFetch(url, opts) {
    opts = opts || {};
    var token = authToken || getToken();
    return fetch(url, Object.assign({}, opts, {
        headers: Object.assign(
            { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            opts.headers || {}
        )
    }));
}

// ===== Promos ===== 
async function deletePromo(code) {
    if (!confirm('Supprimer le code "' + code + '" ?')) return;
    try {
        var res = await authFetch('/api/rewards?type=promo&code=' + encodeURIComponent(code), {
            method: 'DELETE'
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (data.success) {
            loadPromos();
            showToast('Code supprimé', 'success');
        } else {
            showToast(data.error || 'Erreur', 'error');
        }
    } catch (err) {
        showToast('Erreur réseau', 'error');
    }
}

// Mettre à jour le placeholder selon le type
function updatePromoValuePlaceholder() {
    var type = $('promoType').value;
    var input = $('promoValue');
    if (type === 'percentage') {
        input.placeholder = 'Ex: 10 (pour 10%)';
        input.max = '100';
    } else {
        input.placeholder = 'Ex: 20 (pour 20€)';
        input.removeAttribute('max');
    }
}

// Créer un code promo
async function createPromoCode(event) {
    event.preventDefault();
    
    var code = $('promoCode').value.trim().toUpperCase();
    var type = $('promoType').value;
    var value = parseFloat($('promoValue').value);
    var maxUses = parseInt($('promoMaxUses').value) || null;
    var minAmount = parseFloat($('promoMinAmount').value) || 0;
    var description = $('promoDescription').value.trim();
    var expiresAt = $('promoExpiry').value || null;
    var applicablePlans = $('promoPlans').value;

    if (!value || value <= 0) {
        return showToast('Valeur invalide', 'error');
    }

    if (type === 'percentage' && value > 100) {
        return showToast('Le pourcentage ne peut pas dépasser 100%', 'error');
    }

    try {
        console.log('[createPromoCode] Envoi de la requête...');
        console.log('[createPromoCode] Token actuel:', authToken ? 'Présent (' + authToken.substring(0, 20) + '...)' : 'MANQUANT');
        var res = await authFetch('/api/rewards?type=promo', {
            method: 'POST',
            body: JSON.stringify({
                code: code || null,
                type: type,
                value: value,
                maxUses: maxUses,
                minAmount: minAmount,
                description: description,
                expiresAt: expiresAt,
                applicablePlans: applicablePlans,
                autoGenerate: !code
            })
        });

        console.log('[createPromoCode] Statut de la réponse:', res.status);
        
        if (res.status === 401) {
            console.error('[createPromoCode] 401 - Token invalide ou expiré');
            return logout401();
        }
        
        var data = await res.json();
        console.log('[createPromoCode] Réponse:', data);
        
        if (data.success) {
            showToast('Code créé : ' + data.code, 'success');
            $('createPromoForm').reset();
            loadPromos();
        } else {
            showToast(data.error || 'Erreur lors de la création', 'error');
        }
    } catch (err) {
        console.error('[createPromoCode] Erreur:', err);
        showToast('Erreur: ' + err.message, 'error');
    }
}

// Charger la liste des codes promo
async function loadPromos() {
    var list = $('promosList');
    if (!list) return;
    
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">⏳ Chargement...</div>';
    
    try {
        var res = await authFetch('/api/rewards?type=promo');
        if (res.status === 401) return logout401();
        
        var data = await res.json();
        
        if (!data.codes || data.codes.length === 0) {
            list.innerHTML = '<div class="promo-empty-state">' +
                '<div class="promo-empty-icon">🏷️</div>' +
                '<div class="promo-empty-text">Aucun code promo créé</div>' +
                '<div class="promo-empty-hint">Créez votre premier code promo ci-dessus</div>' +
                '</div>';
            return;
        }

        var html = '';
        data.codes.forEach(function(promo) {
            var isExpired = promo.expiresAt && new Date(promo.expiresAt) < new Date();
            var isExhausted = promo.maxUses && promo.usedCount >= promo.maxUses;
            var isActive = promo.active && !isExpired && !isExhausted;
            var statusClass = isActive ? 'active' : (isExpired ? 'expired' : 'inactive');
            var statusText = isActive ? 'Actif' : (isExpired ? 'Expiré' : (isExhausted ? 'Épuisé' : 'Inactif'));

            html += '<div class="promo-card">';
            html += '<div class="promo-card-header">';
            html += '<div class="promo-code-badge">' + escapeHTML(promo.code) + '</div>';
            html += '<div class="promo-status-badge ' + escapeHTML(statusClass) + '">' + escapeHTML(statusText) + '</div>';
            html += '</div>';
            
            if (promo.description) {
                html += '<div class="promo-description">' + escapeHTML(promo.description) + '</div>';
            }
            
            html += '<div class="promo-card-body">';
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Réduction</div>';
            html += '<div class="promo-info-value highlight">';
            html += escapeHTML(promo.type === 'percentage' ? '-' + promo.value + '%' : '-' + promo.value + ' EUR');
            html += '</div></div>';
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Utilisations</div>';
            html += '<div class="promo-info-value">' + escapeHTML((promo.usedCount || 0) + (promo.maxUses ? '/' + promo.maxUses : '/inf')) + '</div>';
            html += '</div>';
            
            if (promo.minAmount > 0) {
                html += '<div class="promo-info-item">';
                html += '<div class="promo-info-label">Montant min.</div>';
                html += '<div class="promo-info-value">' + escapeHTML(promo.minAmount) + ' EUR</div>';
                html += '</div>';
            }
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Expiration</div>';
            html += '<div class="promo-info-value">' + escapeHTML(promo.expiresAt ? new Date(promo.expiresAt).toLocaleDateString('fr-FR') : 'Jamais') + '</div>';
            html += '</div>';
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Plans</div>';
            html += '<div class="promo-info-value" style="font-size:12px">' + escapeHTML(promo.applicablePlans === 'all' ? 'Tous' : 'Specifiques') + '</div>';
            html += '</div>';
            html += '</div>';
            
            html += '<div class="promo-card-actions">';
            html += '<button onclick="togglePromoStatus(' + jsArg(promo.code) + ', ' + !promo.active + ')" class="promo-action-btn ' + (promo.active ? '' : 'success') + '">';
            html += (promo.active ? '⏸️ Désactiver' : '▶️ Activer');
            html += '</button>';
            html += '<button onclick="deletePromo(' + jsArg(promo.code) + ')" class="promo-action-btn danger">Supprimer</button>';
            html += '</div>';
            html += '</div>';
        });

        list.innerHTML = html;
        
    } catch (err) {
        list.innerHTML = '<div class="promo-empty-state">' +
            '<div class="promo-empty-icon">❌</div>' +
            '<div class="promo-empty-text">Erreur de chargement</div>' +
            '<div class="promo-empty-hint">' + escapeHTML(err.message) + '</div>' +
            '</div>';
    }
}

// Activer/désactiver un code promo
async function togglePromoStatus(code, newStatus) {
    try {
        var res = await authFetch('/api/rewards?type=promo', {
            method: 'PUT',
            body: JSON.stringify({
                code: code,
                updates: { active: newStatus }
            })
        });

        if (res.status === 401) return logout401();
        
        var data = await res.json();
        
        if (data.success) {
            showToast('Statut mis à jour', 'success');
            loadPromos();
        } else {
            showToast(data.error || 'Erreur', 'error');
        }
    } catch (err) {
        showToast('Erreur réseau', 'error');
    }
}

// ===== Referrals =====
async function loadReferrals() {
    var list = $('referralsList');
    if (!list) return;
    
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">⏳ Chargement...</div>';
    
    try {
        var res = await authFetch('/api/rewards?type=referral');
        if (res.status === 401) return logout401();
        
        var data = await res.json();
        
        if (!data.referrals || data.referrals.length === 0) {
            list.innerHTML = '<div class="promo-empty-state">' +
                '<div class="promo-empty-icon">👥</div>' +
                '<div class="promo-empty-text">Aucun parrainage enregistré</div>' +
                '<div class="promo-empty-hint">Les parrainages apparaîtront ici automatiquement</div>' +
                '</div>';
            return;
        }

        // Calculer les statistiques
        var totalReferrals = 0;
        var totalEarnings = 0;
        data.referrals.forEach(function(ref) {
            var count = ref.referralCount || 0;
            totalReferrals += count;
            totalEarnings += count * 10; // 10€ pour le parrain uniquement
        });
        
        $('totalReferrers').textContent = data.referrals.length;
        $('totalReferrals').textContent = totalReferrals;
        $('totalReferralEarnings').textContent = totalEarnings + '€';

        // Afficher les parrainages triés par nombre de filleuls
        data.referrals.sort(function(a, b) {
            return (b.referralCount || 0) - (a.referralCount || 0);
        });
        
        var html = '';
        data.referrals.forEach(function(referrer, index) {
            var referralCount = referrer.referralCount || 0;
            var totalEarned = referralCount * 10;
            
            html += '<div class="promo-card">';
            html += '<div class="promo-card-header">';
            html += '<div class="promo-code-badge">' + escapeHTML(referrer.code) + '</div>';
            html += '<div class="promo-status-badge active" style="font-size:16px;font-weight:700">';
            html += '👥 ' + referralCount + ' filleul' + (referralCount > 1 ? 's' : '');
            html += ' • 💰 ' + totalEarned + '€';
            html += '</div>';
            html += '</div>';
            
            html += '<div class="promo-card-body">';
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Parrain</div>';
            html += '<div class="promo-info-value">' + escapeHTML(referrer.referrerName || referrer.referrerEmail) + '</div>';
            html += '</div>';
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Email</div>';
            html += '<div class="promo-info-value" style="font-size:13px">' + escapeHTML(referrer.referrerEmail) + '</div>';
            html += '</div>';
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Mode de récompense</div>';
            html += '<div class="promo-info-value">' + (referrer.rewardMode === 'transfer' ? '💸 Virement' : '🎟️ Codes promo') + '</div>';
            html += '</div>';
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Gains totaux</div>';
            html += '<div class="promo-info-value highlight">' + ((referrer.referralCount || 0) * 10) + '€</div>';
            html += '</div>';
            
            if (referrer.rewardMode === 'transfer') {
                html += '<div class="promo-info-item">';
                html += '<div class="promo-info-label">Solde en attente</div>';
                html += '<div class="promo-info-value" style="color:var(--warning)">' + (referrer.pendingBalance || 0) + '€</div>';
                html += '</div>';
            }
            
            html += '<div class="promo-info-item">';
            html += '<div class="promo-info-label">Créé le</div>';
            html += '<div class="promo-info-value">' + new Date(referrer.createdAt).toLocaleDateString('fr-FR') + '</div>';
            html += '</div>';
            html += '</div>';
            
            // Afficher les demandes de virement
            if (referrer.transferRequests && referrer.transferRequests.length > 0) {
                html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">';
                html += '<div class="promo-info-label" style="margin-bottom:12px">💸 Demandes de virement (' + referrer.transferRequests.length + ')</div>';
                referrer.transferRequests.forEach(function(req) {
                    var statusColor = req.status === 'completed' ? 'var(--success)' : req.status === 'rejected' ? 'var(--error)' : 'var(--warning)';
                    var statusText = req.status === 'completed' ? '✓ Effectué' : req.status === 'rejected' ? '✗ Refusé' : '⏳ En attente';
                    html += '<div style="padding:12px;background:rgba(255,193,7,0.1);border-left:3px solid ' + statusColor + ';border-radius:6px;margin-bottom:8px">';
                    html += '<div style="display:flex;justify-content:space-between;margin-bottom:8px">';
                    html += '<div style="font-weight:600;font-size:14px">' + req.amount + '€</div>';
                    html += '<div style="font-size:13px;color:' + statusColor + ';font-weight:600">' + statusText + '</div>';
                    html += '</div>';
                    html += '<div style="font-size:12px;color:var(--text-muted)">Demandé le ' + new Date(req.requestedAt).toLocaleDateString('fr-FR') + '</div>';
                    if (req.paymentInfo) {
                        html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">IBAN: ' + escapeHTML(req.paymentInfo.iban.substring(0, 10)) + '...</div>';
                        html += '<div style="font-size:12px;color:var(--text-muted)">Titulaire: ' + escapeHTML(req.paymentInfo.accountName) + '</div>';
                    }
                    html += '</div>';
                });
                html += '</div>';
            }
            
            // Afficher les filleuls
            if (referrer.referrals && referrer.referrals.length > 0) {
                html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">';
                html += '<div class="promo-info-label" style="margin-bottom:12px">👥 Filleuls (' + referrer.referrals.length + ')</div>';
                referrer.referrals.forEach(function(ref) {
                    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(21,101,192,0.05);border-radius:6px;margin-bottom:6px">';
                    html += '<div>';
                    html += '<div style="font-weight:600;font-size:14px">' + escapeHTML(ref.name || ref.email) + '</div>';
                    html += '<div style="font-size:12px;color:var(--text-muted)">' + new Date(ref.usedAt).toLocaleDateString('fr-FR') + '</div>';
                    html += '</div>';
                    html += '<div style="font-weight:700;color:var(--success)">+10€</div>';
                    html += '</div>';
                });
                html += '</div>';
            }
            
            html += '</div>';
        });

        list.innerHTML = html;
        
    } catch (err) {
        console.error('[loadReferrals] Erreur:', err);
        list.innerHTML = '<div class="promo-empty-state">' +
            '<div class="promo-empty-icon">❌</div>' +
            '<div class="promo-empty-text">Erreur de chargement</div>' +
            '<div class="promo-empty-hint">' + escapeHTML(err.message) + '</div>' +
            '</div>';
    }
}

// ===== Init =====
(function() {
    var saved = getToken();
    if (saved) {
        authToken = saved;
        showDashboard();
    }
    console.log('[Kareer Admin] Script loaded OK');
})();
