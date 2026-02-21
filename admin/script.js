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
    authToken = null;
    clearToken();
    var ls = $('loginScreen');
    var db = $('dashboard');
    var le = $('loginError');
    if (ls) ls.style.display = '';
    if (db) db.style.display = 'none';
    if (le) le.textContent = 'Session expirée';
}

// ===== Tabs =====
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        var tab = $('tab-' + btn.dataset.tab);
        if (tab) tab.classList.add('active');
        if (btn.dataset.tab === 'analytics') loadAnalytics();
    });
});

// ===== Stats =====
async function loadStats() {
    try {
        var res = await fetch(API_BASE + '/stats', { headers: authHeaders() });
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

        renderOrders(data.orders);
        renderPagination(data.page, data.totalPages);

    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Erreur de chargement</td></tr>';
        console.error('Orders error:', err);
    }
}

function renderOrders(orders) {
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
                '<button class="action-btn copy-btn" onclick="copyToClipboard(\'' + (order.linkedinEmail || '') + '\', \'' + (order.linkedinPassword || '') + '\')" title="Copier identifiants">📋</button>' +
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
            ['Mot de passe LinkedIn', '<code>' + (order.linkedinPassword || '—') + '</code>'],
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
                '<button class="auto-btn" onclick="copyToClipboard(\'' + (order.linkedinEmail || '') + '\', \'' + (order.linkedinPassword || '') + '\')">📋 Copier identifiants</button>' +
                '<button class="auto-btn" onclick="sendReminderFromModal(\'' + order.sessionId + '\')">📧 Envoyer rappel</button>' +
                (order.status !== 'refunded' ? '<button class="auto-btn auto-btn-danger" onclick="refundFromModal(\'' + order.sessionId + '\')">💸 Rembourser</button>' : '');
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
        if (res.status === 401) return logout401();
        if (res.ok) { showToast('Statut mis à jour', 'success'); loadStats(); loadOrders(); }
        else { var data = await res.json(); showToast('Erreur: ' + (data.error || 'Mise à jour échouée'), 'error'); }
    } catch (err) { showToast('Erreur réseau', 'error'); }
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
        [{ id: 'cfgStripe', ok: data.stripe }, { id: 'cfgWebhook', ok: data.webhook }, { id: 'cfgResend', ok: data.resend }, { id: 'cfgTelegram', ok: data.telegram }, { id: 'cfgKV', ok: data.kv }].forEach(function(item) {
            var el = $(item.id); if (!el) return;
            el.textContent = item.ok ? 'Actif' : 'Non configuré';
            el.style.background = item.ok ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
            el.style.color = item.ok ? '#10B981' : '#EF4444';
        });
    } catch (err) { console.error('Config check error:', err); }
}

// ===== Init =====
(function() {
    var saved = getToken();
    if (saved) {
        authToken = saved;
        showDashboard();
    }
    console.log('[Karrier Admin] Script loaded OK');
})();
