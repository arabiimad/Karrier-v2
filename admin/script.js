// Kareer admin.
// Sections: Aujourd'hui (work to do), Commandes, Messages, Statistiques,
// Codes promo, Parrainage, Outils. One order panel shared by every section.

var API_BASE = '/api';
var authToken = null;
var LATE_AFTER_MIN = 30; // the site promises activation within 30 minutes of receiving credentials

var state = {
    section: 'home',
    page: 1,
    status: '',
    view: '',
    payment: '',
    search: '',
    orders: [],
    homeOrders: [],
    stats: null,
    lastOrderCount: -1,
    drawerId: null,
    inbox: [],
    inboxId: null
};
var refreshTimer = null;
var searchTimer = null;

var PLAN_NAMES = {
    'career-student': 'LinkedIn Career', 'career-salary': 'LinkedIn Career', career: 'LinkedIn Career',
    'business-student': 'LinkedIn Business', 'business-salary': 'LinkedIn Business', business: 'LinkedIn Business',
    'sales-nav': 'Sales Navigator Core', recruiter: 'Recruiter Lite'
};
var STATUS_LABELS = {
    pending: 'Nouvelle',
    pending_payment: 'Nouvelle',
    awaiting_credentials: 'Attente identifiants',
    activating: 'À activer',
    done: 'Activée',
    refunded: 'Remboursée'
};

// ===== Helpers =====
function $(id) { return document.getElementById(id); }
function on(id, evt, fn) { var el = $(id); if (el) el.addEventListener(evt, fn); }
function setText(id, value) { var el = $(id); if (el) el.textContent = value; }

function escapeHTML(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function getToken() { try { return sessionStorage.getItem('karrier_admin_token'); } catch (e) { return null; } }
function clearToken() { try { sessionStorage.removeItem('karrier_admin_token'); } catch (e) {} }
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken }; }

// Calls the API with the admin token. Returns parsed JSON, or null after a 401.
async function api(path, options) {
    options = options || {};
    var res = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers: authHeaders(),
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (res.status === 401) { logout401(); return null; }
    setConnected(true);
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok && !data.error) data.error = 'Erreur ' + res.status;
    return data;
}

function formatEuro(value) { return Number(value || 0).toLocaleString('fr-FR') + ' €'; }
// Amounts set in the monospace face: no space cell before the euro sign.
function euroHTML(value) { return escapeHTML(Number(value || 0).toLocaleString('fr-FR')) + '<span class="cur">€</span>'; }
function safeDate(value) { return value ? new Date(value).toLocaleString('fr-FR') : '-'; }
function shortDate(value) {
    if (!value) return '-';
    return new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function minutesSince(value) {
    if (!value) return null;
    return Math.floor((Date.now() - new Date(value).getTime()) / 60000);
}
function formatDuration(minutes) {
    if (minutes == null) return '';
    if (minutes < 60) return minutes + ' min';
    var h = Math.floor(minutes / 60), m = minutes % 60;
    if (h < 24) return h + ' h' + (m ? ' ' + String(m).padStart(2, '0') : '');
    return Math.floor(h / 24) + ' j';
}
function timeAgo(value) {
    var m = minutesSince(value);
    if (m === null) return '';
    if (m < 1) return "à l'instant";
    return 'il y a ' + formatDuration(m);
}
function formatAudience(audience) {
    var names = { Etudiant: 'Étudiant', Salarie: 'Salarié', student: 'Étudiant', salary: 'Salarié' };
    return names[audience] || audience || '';
}
function planName(order) { return order.planLabel || PLAN_NAMES[order.plan] || order.plan || '-'; }
function refOf(order) { return order.reference || order.sessionId; }

// WhatsApp messages the team sends at each step, in the customer's language.
var WA_COPY = {
    fr: {
        hello: 'Bonjour,',
        newOrder: 'merci pour votre commande {ref} ({plan}, {amount}). Je vous envoie par e-mail un lien sécurisé pour transmettre votre mot de passe LinkedIn. L\'activation prend 5 à 30 minutes après réception, et vous ne réglez qu\'une fois Premium actif.',
        student: 'Comme il s\'agit du tarif étudiant, pouvez-vous m\'envoyer ici votre carte étudiante ou une attestation de diplôme récente ?',
        linkSent: 'le lien sécurisé pour votre commande {ref} vient de partir par e-mail (pensez à regarder dans les spams). Dès que vous avez transmis votre mot de passe, l\'activation prend 5 à 30 minutes.',
        activating: 'nous lançons l\'activation de votre commande {ref}. LinkedIn va peut-être vous envoyer un code de vérification par e-mail ou par SMS : pouvez-vous me le transmettre ici dès que vous le recevez ?',
        live: 'LinkedIn Premium est actif sur votre compte {email}, vous pouvez vérifier en vous connectant. Le montant à régler est de {amount} (commande {ref}). Dites-moi quel moyen de paiement vous arrange et je vous envoie les informations.',
        nudge: 'petit rappel pour la commande {ref} : Premium est actif depuis le {date} et le règlement de {amount} n\'est pas encore arrivé de notre côté. Dites-moi si je peux vous aider.',
        paid: 'nous avons bien reçu votre paiement de {amount} pour la commande {ref}, merci. Le reçu vient de partir par e-mail. Bonne utilisation de LinkedIn Premium.',
        referral: 'Votre code de parrainage {code} fait économiser 10 € à vos proches, et vous rapporte 10 € par commande activée.',
        refunded: 'le remboursement de votre commande {ref} ({amount}) est fait, par le même moyen que votre paiement. Selon ce moyen, il arrive en quelques minutes ou quelques jours ouvrés.',
        sign: 'L\'équipe Kareer'
    },
    en: {
        hello: 'Hello,',
        newOrder: 'thank you for your order {ref} ({plan}, {amount}). I am emailing you a secure link to submit your LinkedIn password. Activation takes 5 to 30 minutes once we have it, and you only pay once Premium is live.',
        student: 'As this is the student price, could you send me your student card or a recent degree certificate here?',
        linkSent: 'the secure link for your order {ref} has just been emailed to you (check your spam folder too). Once you have submitted your password, activation takes 5 to 30 minutes.',
        activating: 'we are starting the activation of your order {ref}. LinkedIn may send you a verification code by email or text message: could you send it to me here as soon as you get it?',
        live: 'LinkedIn Premium is live on your account {email}; you can check by signing in. The amount due is {amount} (order {ref}). Let me know which payment method suits you and I will send you the details.',
        nudge: 'a quick reminder about order {ref}: Premium has been live since {date} and we have not received the payment of {amount} yet. Let me know if I can help.',
        paid: 'we have received your payment of {amount} for order {ref}, thank you. The receipt is in your inbox. Enjoy LinkedIn Premium.',
        referral: 'Your referral code {code} saves your friends €10, and earns you €10 for each activated order.',
        refunded: 'the refund for your order {ref} ({amount}) has been made through the method you paid with. Depending on that method, it arrives within minutes or a few business days.',
        sign: 'The Kareer team'
    },
    es: {
        hello: 'Hola:',
        newOrder: 'gracias por tu pedido {ref} ({plan}, {amount}). Te envío por correo un enlace seguro para enviar tu contraseña de LinkedIn. La activación tarda entre 5 y 30 minutos tras recibirla y solo pagas cuando Premium esté activo.',
        student: 'Como es el precio para estudiantes, ¿me puedes enviar aquí tu carné de estudiante o un certificado de título reciente?',
        linkSent: 'el enlace seguro de tu pedido {ref} acaba de salir por correo (revisa también el spam). En cuanto envíes tu contraseña, la activación tarda entre 5 y 30 minutos.',
        activating: 'empezamos la activación de tu pedido {ref}. Es posible que LinkedIn te envíe un código de verificación por correo o SMS: ¿me lo pasas por aquí en cuanto te llegue?',
        live: 'LinkedIn Premium ya está activo en tu cuenta {email}; puedes comprobarlo iniciando sesión. El importe a pagar es {amount} (pedido {ref}). Dime qué medio de pago te viene mejor y te envío los datos.',
        nudge: 'un recordatorio sobre el pedido {ref}: Premium está activo desde el {date} y todavía no nos ha llegado el pago de {amount}. Dime si te puedo ayudar.',
        paid: 'hemos recibido tu pago de {amount} del pedido {ref}, gracias. El recibo te ha llegado por correo. Disfruta de LinkedIn Premium.',
        referral: 'Tu código de recomendación {code} ahorra 10 € a quien lo use y te da 10 € por cada pedido activado.',
        refunded: 'el reembolso de tu pedido {ref} ({amount}) está hecho por el mismo medio con el que pagaste. Según ese medio, llega en unos minutos o en unos días hábiles.',
        sign: 'El equipo de Kareer'
    },
    de: {
        hello: 'Guten Tag,',
        newOrder: 'vielen Dank für Ihre Bestellung {ref} ({plan}, {amount}). Ich sende Ihnen per E-Mail einen sicheren Link für Ihr LinkedIn-Passwort. Die Aktivierung dauert danach 5 bis 30 Minuten, und Sie zahlen erst, wenn Premium aktiv ist.',
        student: 'Da es sich um den Studierendenpreis handelt: Könnten Sie mir hier Ihren Studierendenausweis oder ein aktuelles Abschlusszeugnis schicken?',
        linkSent: 'der sichere Link für Ihre Bestellung {ref} ist gerade per E-Mail rausgegangen (bitte auch im Spam-Ordner nachsehen). Sobald Sie Ihr Passwort übermittelt haben, dauert die Aktivierung 5 bis 30 Minuten.',
        activating: 'wir starten jetzt die Aktivierung Ihrer Bestellung {ref}. LinkedIn schickt Ihnen eventuell einen Bestätigungscode per E-Mail oder SMS: Könnten Sie ihn mir hier weiterleiten, sobald er ankommt?',
        live: 'LinkedIn Premium ist jetzt auf Ihrem Konto {email} aktiv, Sie können es nach der Anmeldung prüfen. Der offene Betrag ist {amount} (Bestellung {ref}). Sagen Sie mir, welche Zahlungsart Ihnen passt, dann schicke ich Ihnen die Angaben.',
        nudge: 'eine kurze Erinnerung zur Bestellung {ref}: Premium ist seit dem {date} aktiv, die Zahlung über {amount} ist bei uns noch nicht eingegangen. Sagen Sie mir gern, ob ich helfen kann.',
        paid: 'wir haben Ihre Zahlung über {amount} für die Bestellung {ref} erhalten, vielen Dank. Der Beleg ist per E-Mail unterwegs. Viel Erfolg mit LinkedIn Premium.',
        referral: 'Mit Ihrem Empfehlungscode {code} sparen andere 10 €, und Sie erhalten 10 € pro aktivierter Bestellung.',
        refunded: 'die Erstattung Ihrer Bestellung {ref} ({amount}) ist über Ihr ursprüngliches Zahlungsmittel veranlasst. Je nach Zahlungsmittel kommt sie in wenigen Minuten oder einigen Werktagen an.',
        sign: 'Ihr Kareer-Team'
    }
};
var WA_AUDIENCE = { fr: ['Étudiant', 'Salarié'], en: ['Student', 'Employee'], es: ['Estudiante', 'Asalariado'], de: ['Studierende', 'Angestellte'] };
var WA_LOCALE = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE' };

function waMessages(o) {
    var lang = WA_COPY[o.language] ? o.language : 'fr';
    var c = WA_COPY[lang];
    var aud = String(o.audience || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    var who = /^(student|etudiant)/.test(aud) ? WA_AUDIENCE[lang][0] : /^(salary|salarie)/.test(aud) ? WA_AUDIENCE[lang][1] : '';
    var vars = {
        ref: refOf(o),
        plan: planName(o) + (who ? ' · ' + who : ''),
        amount: new Intl.NumberFormat(WA_LOCALE[lang], { style: 'currency', currency: o.currency || 'EUR', minimumFractionDigits: Number.isInteger(o.amount) ? 0 : 2 }).format(o.amount || 0),
        email: o.linkedinEmail || o.customerEmail || '',
        code: o.referralCode || '',
        date: o.activatedAt ? new Intl.DateTimeFormat(WA_LOCALE[lang], { day: 'numeric', month: 'long' }).format(new Date(o.activatedAt)) : ''
    };
    function fill(text) { return text.replace(/\{(\w+)\}/g, function(_, k) { return vars[k]; }); }
    function msg(label, body, extra) {
        var first = lang === 'de' ? body : body.charAt(0).toUpperCase() + body.slice(1);
        return { label: label, text: c.hello + '\n\n' + fill(first) + (extra ? '\n\n' + fill(extra) : '') + '\n\n' + c.sign };
    }
    var s = o.status, list = [];
    if (s === 'pending' || s === 'pending_payment') list.push(msg('Accueil de la commande', c.newOrder, isStudent(o) && !o.studentVerified ? c.student : ''));
    if (s === 'awaiting_credentials' && !o.hasCredentials) list.push(msg('Lien envoyé', c.linkSent, needsStudentCheck(o) ? c.student : ''));
    if (s === 'activating' || (o.hasCredentials && s !== 'done' && s !== 'refunded')) list.push(msg('Code de vérification', c.activating));
    if (s === 'done' && !o.isPaid) {
        list.push(msg('Premium actif, paiement', c.live));
        list.push(msg('Relance de paiement', c.nudge));
    }
    if (s === 'done' && o.isPaid) list.push(msg('Paiement reçu', c.paid, o.referralCode ? c.referral : ''));
    if (s === 'refunded' && o.isPaid !== false && o.refundedAt) list.push(msg('Remboursement', c.refunded));
    return { lang: lang, list: list };
}
function isStudent(order) { return /etudiant|étudiant|student/i.test(String(order.audience || '') + ' ' + String(order.plan || '')); }
function isOpen(order) { return ['pending', 'pending_payment', 'awaiting_credentials', 'activating'].indexOf(order.status) >= 0; }
function needsStudentCheck(order) { return isStudent(order) && !order.studentVerified && isOpen(order); }
function canSendLink(order) { return ['pending', 'pending_payment', 'awaiting_credentials'].indexOf(order.status) >= 0 && !order.hasCredentials; }
function isLate(order) {
    if (!order.hasCredentials || order.status === 'done' || order.status === 'refunded') return false;
    var m = minutesSince(order.credentialsSubmittedAt);
    return m !== null && m > LATE_AFTER_MIN;
}

function statusBadge(order) {
    var s = order.status || 'pending_payment';
    return '<span class="st st-' + escapeHTML(s) + '">' + escapeHTML(STATUS_LABELS[s] || s) + '</span>';
}
function paymentBadge(order) {
    if (order.status === 'refunded') return '';
    if (order.isPaid) return '<span class="pay pay-paid">Payée</span>';
    if (order.paymentDue) return '<span class="pay pay-due">À encaisser</span>';
    return '<span class="pay pay-none">Non payée</span>';
}
function credentialNote(order) {
    if (order.hasCredentials) return 'Identifiants reçus ' + timeAgo(order.credentialsSubmittedAt);
    if (order.status === 'done' || order.status === 'refunded') return '';
    if (order.credentialLinkSentAt) return 'Lien envoyé ' + timeAgo(order.credentialLinkSentAt);
    return 'Lien pas encore envoyé';
}

// The one or two buttons that move an order to its next step.
function nextButtons(order) {
    var id = escapeHTML(order.sessionId);
    var s = order.status;
    if (s === 'refunded') return '';
    if (s === 'pending' || s === 'pending_payment') {
        return '<button type="button" class="btn btn-primary btn-small" data-action="send_link" data-id="' + id + '">Envoyer le lien</button>';
    }
    if (s !== 'done' && (order.hasCredentials || s === 'activating')) {
        return (order.hasCredentials ? '<button type="button" class="btn btn-small" data-action="copy_access" data-id="' + id + '">Copier les accès</button>' : '') +
            '<button type="button" class="btn btn-primary btn-small" data-action="mark_activated" data-id="' + id + '">Marquer activée</button>';
    }
    if (s === 'awaiting_credentials') {
        return '<button type="button" class="btn btn-small" data-action="send_link" data-id="' + id + '">Renvoyer le lien</button>';
    }
    if (s === 'done' && !order.isPaid) {
        return '<button type="button" class="btn btn-primary btn-small" data-action="mark_paid" data-id="' + id + '">Marquer payée</button>';
    }
    return '';
}
function nextHint(order) {
    var s = order.status;
    if (s === 'refunded') return 'Commande remboursée.';
    if (s === 'pending' || s === 'pending_payment') return 'Envoyez le lien sécurisé. Le client y saisira son mot de passe LinkedIn.';
    if (s !== 'done' && order.hasCredentials) return isLate(order)
        ? 'En retard : identifiants reçus il y a ' + formatDuration(minutesSince(order.credentialsSubmittedAt)) + '. Le site promet 30 minutes maximum.'
        : 'Copiez les accès, activez Premium sur le compte, puis marquez la commande activée.';
    if (s === 'activating') return 'Activez Premium sur le compte, puis marquez la commande activée.';
    if (s === 'awaiting_credentials') return 'Le client n\'a pas encore envoyé ses identifiants. Renvoyez le lien s\'il a expiré.';
    if (s === 'done' && !order.isPaid) return 'Premium est actif. Marquez la commande payée quand le règlement arrive sur WhatsApp.';
    return 'Rien à faire sur cette commande.';
}

// ===== Feedback =====
function showToast(message, type) {
    var box = $('toastContainer');
    if (!box) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'info');
    toast.textContent = message;
    box.appendChild(toast);
    requestAnimationFrame(function() { toast.classList.add('toast-show'); });
    setTimeout(function() {
        toast.classList.remove('toast-show');
        setTimeout(function() { toast.remove(); }, 250);
    }, 3500);
}
function copyText(text, okMessage) {
    if (!navigator.clipboard) { showToast('Copie impossible dans ce navigateur', 'error'); return Promise.resolve(false); }
    return navigator.clipboard.writeText(text).then(function() {
        showToast(okMessage || 'Copié', 'success');
        return true;
    }).catch(function() {
        showToast('Copie refusée par le navigateur', 'error');
        return false;
    });
}
function setResult(id, message, ok) {
    var el = $(id);
    if (!el) return;
    el.textContent = message;
    el.className = 'result' + (ok === true ? ' ok' : ok === false ? ' err' : '');
}
function playNotificationSound() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = 880; gain.gain.value = 0.25;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
}
function setConnected(ok) {
    var el = $('connectionDot');
    if (!el) return;
    el.classList.toggle('off', !ok);
    setText('connectionText', ok ? 'Connecté' : 'Hors ligne');
}

// ===== Shell =====
function showDashboard() {
    $('loginScreen').hidden = true;
    $('dashboard').hidden = false;
    setText('homeDate', new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
    loadStats();
    showSection(state.section);
    loadConfigCheck();
    loadInbox(true);
    startAutoRefresh();
}

function showSection(name) {
    state.section = name;
    document.querySelectorAll('.view').forEach(function(v) { v.classList.toggle('active', v.id === 'view-' + name); });
    document.querySelectorAll('.nav-item[data-section]').forEach(function(b) { b.classList.toggle('active', b.dataset.section === name); });
    var more = $('navMore');
    if (more) more.classList.toggle('active', ['promos', 'referrals', 'tools'].indexOf(name) >= 0);
    toggleMore(false);
    window.scrollTo(0, 0);
    if (name === 'home') loadHome();
    if (name === 'orders') loadOrders(1);
    if (name === 'inbox') loadInbox();
    if (name === 'analytics') loadAnalytics();
    if (name === 'promos') loadPromos();
    if (name === 'referrals') loadReferrals();
    if (name === 'tools') loadConfigCheck();
}
function toggleMore(open) {
    var sheet = $('moreSheet'), btn = $('navMore');
    if (!sheet || !btn) return;
    var next = typeof open === 'boolean' ? open : sheet.hidden;
    sheet.hidden = !next;
    btn.setAttribute('aria-expanded', next ? 'true' : 'false');
}
document.querySelectorAll('.nav-item[data-section]').forEach(function(btn) {
    btn.addEventListener('click', function() { showSection(btn.dataset.section); });
});
on('navMore', 'click', function(e) { e.stopPropagation(); toggleMore(); });
document.addEventListener('click', function(e) {
    var sheet = $('moreSheet');
    if (sheet && !sheet.hidden && !sheet.contains(e.target)) toggleMore(false);
});

function logout() {
    authToken = null;
    clearToken();
    if (refreshTimer) clearInterval(refreshTimer);
    closeDrawer();
    $('dashboard').hidden = true;
    $('loginScreen').hidden = false;
    var pw = $('loginPassword');
    if (pw) { pw.value = ''; pw.focus(); }
}
function logout401() {
    logout();
    showToast('Session expirée, reconnectez-vous.', 'error');
}
on('logoutBtn', 'click', logout);
on('logoutBtnMobile', 'click', logout);

function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function() {
        if (document.visibilityState !== 'visible' || !$('drawer').hidden) return;
        var active = document.activeElement;
        if (active && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
        loadStats();
        if (state.section === 'home') loadHome();
        if (state.section === 'orders') loadOrders(state.page, true);
    }, 30000);
}
document.querySelectorAll('[data-refresh]').forEach(function(btn) {
    btn.addEventListener('click', function() { loadStats(); loadHome(); });
});

// ===== Stats =====
async function loadStats() {
    try {
        var data = await api('/analytics?type=stats');
        if (!data) return;
        state.stats = data;
        var q = data.queues || {};

        $('kpiRevenue').innerHTML = euroHTML(data.totalRevenue);
        setText('kpiRevenueSub', data.todayRevenue ? 'dont ' + formatEuro(data.todayRevenue) + " aujourd'hui" : 'payé, hors remboursements');
        $('kpiDue').innerHTML = euroHTML(data.dueAmount);
        setText('kpiDueSub', data.dueCount ? data.dueCount + ' commande' + (data.dueCount > 1 ? 's' : '') + ' activée' + (data.dueCount > 1 ? 's' : '') + ', non payée' + (data.dueCount > 1 ? 's' : '') : 'rien en attente');
        setText('kpiOrders', data.totalOrders);
        setText('kpiOrdersSub', data.todayOrders ? '+' + data.todayOrders + " aujourd'hui" : "aucune aujourd'hui");

        var act = $('kpiActivation');
        if (act) {
            act.textContent = data.avgActivationMinutes == null ? '—' : formatDuration(data.avgActivationMinutes);
            act.classList.toggle('kpi-good', data.avgActivationMinutes != null && data.avgActivationMinutes <= LATE_AFTER_MIN);
            act.classList.toggle('kpi-bad', data.avgActivationMinutes != null && data.avgActivationMinutes > LATE_AFTER_MIN);
        }
        setText('kpiActivationSub', data.activationSamples
            ? 'sur ' + data.activationSamples + ' activation' + (data.activationSamples > 1 ? 's' : '') + ' (30 j), objectif 30 min'
            : 'objectif : 30 min max');

        setText('q_all', data.totalOrders);
        ['to_link', 'waiting_credentials', 'to_activate', 'to_collect', 'student_check'].forEach(function(name) {
            setText('q_' + name, q[name] || 0);
            var chip = document.querySelector('.queue-chip[data-view="' + name + '"]');
            if (chip) chip.classList.toggle('has-items', (q[name] || 0) > 0);
        });

        var todo = (q.to_link || 0) + (q.to_activate || 0);
        var badge = $('navCountHome');
        if (badge) { badge.hidden = !todo; badge.textContent = todo; }
        document.title = (todo ? '(' + todo + ') ' : '') + 'Kareer Admin';

        if (state.lastOrderCount >= 0 && data.totalOrders > state.lastOrderCount) {
            playNotificationSound();
            showToast('Nouvelle commande', 'success');
            if (state.section === 'home') loadHome();
        }
        state.lastOrderCount = data.totalOrders;
    } catch (err) {
        setConnected(false);
    }
}

// ===== Today =====
var TODO_GROUPS = [
    { key: 'late', title: 'En retard', cls: 'g-late', hint: 'Identifiants reçus il y a plus de 30 minutes. Le site promet 30 minutes maximum.',
      match: isLate },
    { key: 'activate', title: 'À activer', hint: 'Identifiants reçus : copiez les accès, activez Premium, puis marquez la commande activée.',
      match: function(o) { return o.status !== 'done' && o.status !== 'refunded' && (o.hasCredentials || o.status === 'activating') && !isLate(o); } },
    { key: 'link', title: 'Lien à envoyer', hint: 'Nouvelles commandes : envoyez le lien sécurisé pour les identifiants.',
      match: function(o) { return o.status === 'pending' || o.status === 'pending_payment'; } },
    { key: 'collect', title: 'À encaisser', hint: "Premium est actif, le client n'a pas encore payé.",
      match: function(o) { return !!o.paymentDue; } },
    { key: 'waiting', title: 'En attente du client', hint: "Lien envoyé, identifiants pas encore reçus. Renvoyez le lien s'il a expiré.",
      match: function(o) { return o.status === 'awaiting_credentials' && !o.hasCredentials; } }
];

async function loadHome() {
    var box = $('todoContainer');
    if (!box) return;
    try {
        var data = await api('/orders?limit=500');
        if (!data) return;
        state.homeOrders = data.orders || [];
        renderHome();
    } catch (err) {
        box.innerHTML = '<p class="empty">Impossible de charger les commandes.</p>';
    }
}

function renderHome() {
    var box = $('todoContainer');
    var html = '';
    var actionable = 0;
    TODO_GROUPS.forEach(function(group) {
        var items = state.homeOrders.filter(group.match);
        if (!items.length) return;
        if (group.key !== 'waiting') actionable += items.length;
        if (group.key === 'late' || group.key === 'activate') {
            items.sort(function(a, b) { return new Date(a.credentialsSubmittedAt || a.createdAt) - new Date(b.credentialsSubmittedAt || b.createdAt); });
        }
        html += '<section class="todo-group ' + (group.cls || '') + '">' +
            '<header class="todo-head"><h2 class="todo-title">' + group.title + '</h2><span class="todo-count">' + items.length + '</span>' +
            '<p class="todo-hint">' + group.hint + '</p></header>' +
            '<div class="todo-list">' + items.map(todoItem).join('') + '</div></section>';
    });
    if (!actionable) {
        html = '<div class="all-clear"><strong>Rien à traiter pour l\'instant.</strong>Les nouvelles commandes et les identifiants reçus apparaîtront ici.</div>' + html;
    }
    box.innerHTML = html;
}

function todoItem(order) {
    var when = order.hasCredentials ? 'identifiants ' + timeAgo(order.credentialsSubmittedAt)
        : order.status === 'done' ? 'activée ' + timeAgo(order.activatedAt || order.updatedAt)
        : 'commandée ' + timeAgo(order.createdAt);
    var student = needsStudentCheck(order) ? ' <span class="pill pill-violet">Justificatif à vérifier</span>' : '';
    return '<div class="todo-item" data-open="' + escapeHTML(order.sessionId) + '">' +
        '<div class="todo-main"><strong>' + escapeHTML(planName(order)) + student + '</strong><span><span class="ref">' + escapeHTML(refOf(order)) + '</span> · ' + escapeHTML(order.customerEmail || '-') + '</span></div>' +
        '<div class="todo-meta"><strong>' + euroHTML(order.amount) + '</strong><span>' + escapeHTML(when) + '</span></div>' +
        '<div class="todo-actions">' + nextButtons(order) + '</div>' +
    '</div>';
}

// ===== Orders =====
async function loadOrders(page, quiet) {
    state.page = page || 1;
    var body = $('ordersBody');
    if (!quiet) body.innerHTML = '<tr><td colspan="5" class="empty"><span class="spinner"></span>Chargement…</td></tr>';
    var qs = '?page=' + state.page + '&limit=20';
    if (state.status) qs += '&status=' + encodeURIComponent(state.status);
    if (state.view) qs += '&view=' + encodeURIComponent(state.view);
    if (state.payment) qs += '&payment=' + encodeURIComponent(state.payment);
    if (state.search) qs += '&search=' + encodeURIComponent(state.search);
    try {
        var data = await api('/orders' + qs);
        if (!data) return;
        state.orders = data.orders || [];
        setText('ordersCount', data.total ? data.total + ' commande' + (data.total > 1 ? 's' : '') : '');
        if (!state.orders.length) {
            var msg = state.search ? 'Aucun résultat pour « ' + escapeHTML(state.search) + ' ».' : state.view ? 'Rien dans cette file.' : 'Aucune commande.';
            body.innerHTML = '<tr><td colspan="5" class="empty">' + msg + '</td></tr>';
            $('pagination').innerHTML = '';
            return;
        }
        body.innerHTML = state.orders.map(orderRow).join('');
        renderPagination(data.page, data.totalPages);
    } catch (err) {
        body.innerHTML = '<tr><td colspan="5" class="empty">Erreur de chargement.</td></tr>';
    }
}

function orderRow(order) {
    var late = isLate(order);
    var linkedin = order.linkedinEmail && order.linkedinEmail !== order.customerEmail
        ? '<span class="cell-sub">LinkedIn : ' + escapeHTML(order.linkedinEmail) + '</span>' : '';
    var student = needsStudentCheck(order) ? '<span class="pill pill-violet">Justificatif à vérifier</span>' : '';
    var note = credentialNote(order);
    return '<tr data-id="' + escapeHTML(order.sessionId) + '"' + (late ? ' class="row-late"' : '') + '>' +
        '<td class="c-order"><span class="cell-main">' + escapeHTML(planName(order)) + '</span>' +
            '<span class="cell-sub"><span class="ref">' + escapeHTML(refOf(order)) + '</span> · ' + escapeHTML(formatAudience(order.audience)) + ' · ' + escapeHTML(shortDate(order.createdAt)) + '</span></td>' +
        '<td class="c-client"><span class="cell-main">' + escapeHTML(order.customerEmail || '-') + '</span>' + linkedin + '</td>' +
        '<td class="c-amount"><div class="cell-stack"><span class="cell-amount">' + euroHTML(order.amount) + '</span>' + paymentBadge(order) + '</div></td>' +
        '<td class="c-status"><div class="cell-stack">' + statusBadge(order) + (late ? '<span class="late">En retard</span>' : '') + student + '</div>' +
            (note ? '<span class="cell-sub">' + escapeHTML(note) + '</span>' : '') + '</td>' +
        '<td class="c-next"><div class="next">' + (nextButtons(order) || '<span class="muted">Rien à faire</span>') + '</div></td>' +
    '</tr>';
}

function renderPagination(current, total) {
    var box = $('pagination');
    if (!total || total <= 1) { box.innerHTML = ''; return; }
    var html = '';
    for (var i = 1; i <= total; i++) {
        if (i === 1 || i === total || Math.abs(i - current) <= 2) {
            html += '<button type="button" class="page-btn' + (i === current ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
        } else if (Math.abs(i - current) === 3) {
            html += '<span class="page-dots">…</span>';
        }
    }
    box.innerHTML = html;
}
on('pagination', 'click', function(e) {
    var b = e.target.closest('[data-page]');
    if (b) loadOrders(parseInt(b.dataset.page, 10));
});

function setView(view) {
    state.view = view || '';
    document.querySelectorAll('.queue-chip').forEach(function(c) { c.classList.toggle('active', c.dataset.view === state.view); });
    showSection('orders');
}
document.querySelectorAll('.queue-chip').forEach(function(chip) {
    chip.addEventListener('click', function() { setView(chip.dataset.view); });
});
document.querySelectorAll('.kpi-link').forEach(function(el) {
    el.addEventListener('click', function() { setView(el.dataset.view); });
});
on('filterStatus', 'change', function(e) { state.status = e.target.value; loadOrders(1); });
on('filterPayment', 'change', function(e) { state.payment = e.target.value; loadOrders(1); });
on('searchInput', 'input', function(e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { state.search = e.target.value.trim(); loadOrders(1); }, 350);
});
on('refreshBtn', 'click', function() { loadStats(); loadOrders(state.page); });

// Rows and to-do items open the order panel, except when a button inside was clicked.
document.addEventListener('click', function(e) {
    if (e.target.closest('button, a, select, input, textarea, label')) return;
    var row = e.target.closest('tr[data-id], [data-open]');
    if (row) openOrder(row.dataset.id || row.dataset.open);
});

// ===== Order actions =====
document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.preventDefault();
    runAction(btn.dataset.action, btn.dataset.id, btn);
});

async function runAction(action, id, btn) {
    if (btn) btn.disabled = true;
    try {
        var changed = false;
        if (action === 'open') { openOrder(id); return; }
        if (action === 'send_link') changed = await sendLink(id);
        if (action === 'copy_access') await copyAccess(id);
        if (action === 'mark_activated') changed = await setStatus(id, 'done', "Premium est actif sur le compte du client ?\n\nLe client reçoit l'e-mail de confirmation et ses identifiants sont supprimés.");
        if (action === 'mark_paid') changed = await markPaid(id, true);
        if (action === 'confirm_paid') changed = await confirmPaid(id);
        if (action === 'copy_wa') { var m = waMessages(state.drawerOrder || {}).list[Number(btn.dataset.index)]; if (m) await copyText(m.text, 'Message copié, collez-le dans WhatsApp'); return; }
        if (action === 'mark_unpaid') changed = await markPaid(id, false);
        if (action === 'reminder') await sendReminder(id);
        if (action === 'refund') changed = await refundOrder(id);
        if (action === 'delete') { if (await deleteOrder(id)) { closeDrawer(); afterChange(null); } return; }
        if (action === 'add_note') changed = await addNote(id);
        if (action === 'copy_id') await copyText(btn.dataset.value || id, 'Numéro de commande copié');
        if (action === 'promo_toggle') { await togglePromoStatus(btn.dataset.code, btn.dataset.active === 'true'); return; }
        if (action === 'promo_delete') { await deletePromo(btn.dataset.code); return; }
        if (changed) afterChange(id);
    } finally {
        if (btn && document.body.contains(btn)) btn.disabled = false;
    }
}

function afterChange(id) {
    loadStats();
    if (state.section === 'home') loadHome();
    if (state.section === 'orders') loadOrders(state.page, true);
    if (id && state.drawerId === id) openOrder(id, true);
}

async function sendLink(id) {
    var data = await api('/update-order', { method: 'POST', body: { action: 'credential_link', session_id: id } });
    if (!data) return false;
    if (!data.success) { showToast(data.error || 'Lien non envoyé', 'error'); return false; }
    if (data.link) await copyText(data.link, data.emailSent ? 'Lien envoyé au client par e-mail (et copié)' : 'E-mail non parti : lien copié, envoyez-le sur WhatsApp');
    else showToast(data.emailSent ? 'Lien envoyé par e-mail' : 'Lien créé', 'success');
    return true;
}

async function copyAccess(id) {
    if (!confirm('Afficher et copier le mot de passe LinkedIn de cette commande ?')) return;
    var data = await api('/update-order', { method: 'POST', body: { action: 'reveal_credentials', session_id: id } });
    if (!data) return;
    if (!data.success) return showToast(data.error || 'Accès indisponibles', 'error');
    await copyText('E-mail LinkedIn : ' + (data.linkedinEmail || '') + '\nMot de passe : ' + data.linkedinPassword, 'Accès copiés');
}

async function setStatus(id, status, question) {
    if (!status) return false;
    if (question && !confirm(question)) return false;
    var data = await api('/update-order', { method: 'PATCH', body: { session_id: id, status: status } });
    if (!data) return false;
    if (!data.success) { showToast(data.error || 'Statut non modifié', 'error'); return false; }
    showToast('Statut : ' + (STATUS_LABELS[status] || status) + (data.emailSent ? ' · e-mail envoyé au client' : ''), 'success');
    return true;
}

// "Marquer payée" opens the order on its payment form; the form records the method and sends the receipt.
async function markPaid(id, paid) {
    if (paid) {
        state.payFormFor = id;
        await openOrder(id, state.drawerId === id);
        var form = $('payForm');
        if (form) { form.hidden = false; form.scrollIntoView({ block: 'center', behavior: 'smooth' }); var m = $('payMethod'); if (m) m.focus(); }
        return false;
    }
    if (!confirm('Repasser cette commande en non payée ?')) return false;
    var data = await api('/update-order', { method: 'POST', body: { action: 'mark_paid', session_id: id, paid: false } });
    if (!data) return false;
    if (!data.success) { showToast(data.error || 'Échec', 'error'); return false; }
    showToast('Commande repassée en non payée', 'success');
    return true;
}

async function confirmPaid(id) {
    var select = $('payMethod'), other = $('payMethodOther'), receipt = $('payReceipt');
    var method = select ? select.value : '';
    if (method === 'other') method = other ? other.value.trim() : '';
    var data = await api('/update-order', { method: 'POST', body: { action: 'mark_paid', session_id: id, paid: true, method: method || undefined, notify: receipt ? receipt.checked : true } });
    if (!data) return false;
    if (!data.success) { showToast(data.error || 'Échec', 'error'); return false; }
    state.payFormFor = null;
    showToast(data.receiptSent ? 'Paiement enregistré, reçu envoyé au client' : 'Paiement enregistré', 'success');
    return true;
}

async function sendReminder(id) {
    var data = await api('/automation', { method: 'POST', body: { action: 'send_reminder', session_id: id } });
    if (!data) return;
    var result = data.result || {};
    var sent = data.success && result.sent !== false;
    var labels = { new_link: 'Nouveau lien envoyé par e-mail (l\'ancien ne marche plus)', payment: 'Rappel de paiement envoyé par e-mail', order: 'Relance envoyée par e-mail' };
    showToast(sent ? (labels[result.kind] || 'Rappel envoyé') : (data.error || result.reason || 'Rappel non envoyé'), sent ? 'success' : 'error');
}

async function refundOrder(id, reason) {
    if (!confirm('Le remboursement se fait hors du site, par le même moyen que le paiement.\n\nEnregistrer le remboursement et prévenir le client par e-mail ?')) return false;
    var data = await api('/refund', { method: 'POST', body: { session_id: id, reason: reason || 'requested_by_customer' } });
    if (!data) return false;
    if (!data.success) { showToast(data.error === 'Order is not paid' ? 'Cette commande n\'est pas payée' : (data.error || 'Échec'), 'error'); return false; }
    showToast(data.refund.manual ? 'Remboursement enregistré, client prévenu' : 'Remboursement effectué : ' + formatEuro(data.refund.amount), 'success');
    return data;
}

async function deleteOrder(id) {
    if (!confirm('Supprimer définitivement cette commande ? Cette action est irréversible.')) return false;
    var res = await fetch(API_BASE + '/update-order?session_id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
    if (res.status === 401) { logout401(); return false; }
    var data = await res.json();
    if (!data.success) { showToast(data.error || 'Échec', 'error'); return false; }
    showToast('Commande supprimée', 'success');
    return true;
}

async function addNote(id) {
    var input = $('noteInput');
    var text = input ? input.value.trim() : '';
    if (!text) { showToast('Écrivez la note avant de l\'ajouter', 'error'); return false; }
    var data = await api('/update-order', { method: 'POST', body: { action: 'add_note', session_id: id, text: text } });
    if (!data) return false;
    if (!data.success) { showToast(data.error || 'Note non enregistrée', 'error'); return false; }
    showToast('Note ajoutée', 'success');
    return true;
}

async function setStudentVerified(id, verified) {
    var data = await api('/update-order', { method: 'POST', body: { action: 'set_student_verified', session_id: id, verified: verified } });
    if (!data || !data.success) { showToast((data && data.error) || 'Échec', 'error'); return; }
    showToast(verified ? 'Justificatif marqué vérifié' : 'Justificatif marqué non vérifié', 'success');
    afterChange(id);
}

// ===== Order panel =====
async function fetchOrder(id) {
    var known = state.orders.concat(state.homeOrders).filter(function(o) { return o.sessionId === id; })[0];
    var data = await api('/orders?limit=5&search=' + encodeURIComponent(id));
    var found = data && data.orders ? data.orders.filter(function(o) { return o.sessionId === id; })[0] : null;
    return found || known || null;
}

async function openOrder(id, keepScroll) {
    var drawer = $('drawer'), body = $('drawerBody');
    var scroll = drawer.scrollTop;
    state.drawerId = id;
    drawer.hidden = false;
    $('drawerBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!keepScroll) body.innerHTML = '<p class="empty"><span class="spinner"></span>Chargement…</p>';
    var order = await fetchOrder(id);
    if (state.drawerId !== id) return;
    if (!order) { body.innerHTML = '<p class="empty">Commande introuvable.</p>'; return; }
    state.drawerOrder = order;
    body.innerHTML = renderDrawer(order);
    if (keepScroll) drawer.scrollTop = scroll;
    else { var close = body.querySelector('.icon-btn'); if (close) close.focus(); }
    var check = $('studentVerified');
    if (check) check.addEventListener('change', function() { setStudentVerified(order.sessionId, check.checked); });
    var status = $('drawerStatus');
    if (status) status.addEventListener('change', async function() {
        var value = status.value;
        status.value = '';
        var mails = { activating: 'Le client reçoit l\'e-mail « activation en cours ».', done: 'Le client reçoit l\'e-mail « Premium est actif » avec le montant à régler.', refunded: order.isPaid ? 'Le client reçoit l\'e-mail de remboursement.' : 'Le client reçoit l\'e-mail d\'annulation.' };
        var question = 'Passer la commande en « ' + (STATUS_LABELS[value] || value) + ' » ?' + (mails[value] ? '\n\n' + mails[value] : '');
        if (await setStatus(order.sessionId, value, question)) afterChange(order.sessionId);
    });
    var method = $('payMethod');
    if (method) method.addEventListener('change', function() { var other = $('payMethodOther'); if (other) other.hidden = method.value !== 'other'; });
}

function closeDrawer() {
    state.drawerId = null;
    state.payFormFor = null;
    var drawer = $('drawer');
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    $('drawerBackdrop').hidden = true;
    document.body.style.overflow = '';
}
on('drawerBackdrop', 'click', closeDrawer);
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeDrawer(); toggleMore(false); }
});
document.addEventListener('click', function(e) { if (e.target.closest('[data-close]')) closeDrawer(); });

function timelineHTML(o) {
    var late = isLate(o);
    var reached = {
        created: true,
        link: !!(o.credentialLinkSentAt || o.hasCredentials || ['awaiting_credentials', 'activating', 'done'].indexOf(o.status) >= 0),
        creds: !!(o.credentialsSubmittedAt || o.hasCredentials || ['activating', 'done'].indexOf(o.status) >= 0),
        active: !!(o.status === 'done' || o.activatedAt)
    };
    // A later step implies the earlier ones happened, even on older orders without timestamps.
    if (reached.active) reached.creds = true;
    if (reached.creds) reached.link = true;

    var activeNote = '';
    if (o.activatedAt && o.credentialsSubmittedAt) {
        activeNote = 'en ' + formatDuration(Math.max(0, Math.round((new Date(o.activatedAt) - new Date(o.credentialsSubmittedAt)) / 60000))) + ' après les identifiants';
    }
    var steps = [
        { key: 'created', label: 'Commande reçue', time: o.createdAt },
        { key: 'link', label: 'Lien sécurisé envoyé', time: o.credentialLinkSentAt, note: o.credentialLinkExpiresAt && !o.hasCredentials && o.status === 'awaiting_credentials' ? 'expire le ' + shortDate(o.credentialLinkExpiresAt) : '' },
        { key: 'creds', label: 'Identifiants reçus', time: o.credentialsSubmittedAt, note: o.credentialsDeletedAt ? 'supprimés le ' + shortDate(o.credentialsDeletedAt) : '' },
        { key: 'active', label: 'Premium activé', time: o.activatedAt, note: activeNote }
    ];
    var currentSet = false;
    var html = steps.map(function(step) {
        var done = reached[step.key];
        var cls = done ? 'done' : '';
        if (!done && !currentSet && o.status !== 'refunded') {
            cls = step.key === 'active' && late ? 'warn' : 'current';
            currentSet = true;
        }
        return tlStep(cls, step.label, step.note, step.time);
    }).join('');

    var payNote = o.paymentMethod ? o.paymentMethod : (o.isPaid && !o.paidAt ? 'réglée avant le lien (ancien parcours)' : '');
    if (o.receiptSentAt) payNote += (payNote ? ' · ' : '') + 'reçu envoyé';
    var reminders = (o.reminders || []).filter(function(r) { return r.status === 'done'; });
    if (!o.isPaid && reminders.length) payNote += (payNote ? ' · ' : '') + reminders.length + ' rappel' + (reminders.length > 1 ? 's' : '') + ' envoyé' + (reminders.length > 1 ? 's' : '');
    if (o.status !== 'refunded' || o.isPaid) {
        html += tlStep(o.isPaid ? 'done' : (o.paymentDue ? 'current' : ''), 'Payée', payNote, o.paidAt);
    }
    if (o.status === 'refunded') {
        html += tlStep('done', 'Remboursée', o.refundMethod === 'manual' ? 'hors site' : '', o.refundedAt);
    }
    return '<ol class="timeline">' + html + '</ol>';
}
function tlStep(cls, label, note, time) {
    return '<li class="tl-step ' + cls + '"><span class="tl-dot" aria-hidden="true"></span>' +
        '<span class="tl-label">' + escapeHTML(label) + (note ? '<span class="tl-note">' + escapeHTML(note) + '</span>' : '') + '</span>' +
        '<span class="tl-time">' + (time ? escapeHTML(shortDate(time)) : '') + '</span></li>';
}

function renderDrawer(o) {
    var id = escapeHTML(o.sessionId);
    var late = isLate(o);
    var badges = statusBadge(o) + paymentBadge(o) + (late ? '<span class="late">En retard</span>' : '') +
        (needsStudentCheck(o) ? '<span class="pill pill-violet">Justificatif à vérifier</span>' : '');
    var next = nextButtons(o).replace(/ btn-small/g, '');
    var showPay = o.status !== 'refunded' && !o.isPaid;
    var payOpen = showPay && (o.status === 'done' || state.payFormFor === o.sessionId);
    if (payOpen) next = next.replace(/<button[^>]*data-action="mark_paid"[^>]*>[^<]*<\/button>/, '');

    var kv = [
        ['E-mail client', '<a href="mailto:' + escapeHTML(o.customerEmail || '') + '">' + escapeHTML(o.customerEmail || '-') + '</a>'],
        ['Compte LinkedIn', escapeHTML(o.linkedinEmail || '-')],
        ['Offre', escapeHTML(planName(o)) + (o.audience ? ' · ' + escapeHTML(formatAudience(o.audience)) : '')],
        ['Montant', '<span class="mono">' + euroHTML(o.amount) + '</span>' + (o.originalAmount && o.originalAmount !== o.amount ? ' <span class="muted">au lieu de ' + escapeHTML(formatEuro(o.originalAmount)) + '</span>' : '')],
        ['Langue', escapeHTML((o.language || 'fr').toUpperCase())]
    ];
    if (o.promoCode) kv.push(['Code promo', '<span class="mono">' + escapeHTML(o.promoCode) + '</span>']);
    if (o.usedReferralCode) kv.push(['Code de parrainage', '<span class="mono">' + escapeHTML(o.usedReferralCode) + '</span>']);
    if (o.referralCode) kv.push(['Son code à partager', '<span class="mono">' + escapeHTML(o.referralCode) + '</span>']);
    if (o.expiresAt) kv.push(['Abonnement jusqu\'au', escapeHTML(new Date(o.expiresAt).toLocaleDateString('fr-FR'))]);
    kv.push(['Identifiant interne', '<span class="mono muted">' + escapeHTML(o.sessionId) + '</span>']);

    var pay = '';
    if (showPay) {
        pay = '<section class="d-section pay-form" id="payForm"' + (payOpen ? '' : ' hidden') + '><h3>Enregistrer le paiement</h3>' +
            '<div class="pay-row"><select class="input" id="payMethod" aria-label="Moyen de paiement">' +
                ['Virement bancaire', 'PayPal', 'Wise', 'Revolut', 'Espèces'].map(function(m) { return '<option value="' + m + '">' + m + '</option>'; }).join('') +
                '<option value="other">Autre…</option></select>' +
            '<input class="input" id="payMethodOther" placeholder="Moyen de paiement" hidden></div>' +
            '<label class="check"><input type="checkbox" id="payReceipt" checked><span>Envoyer le reçu au client<small>E-mail « Paiement reçu » avec le montant, la date et le moyen de paiement.</small></span></label>' +
            '<button type="button" class="btn btn-primary" data-action="confirm_paid" data-id="' + id + '">Confirmer : ' + escapeHTML(formatEuro(o.amount)) + ' reçus</button></section>';
    }

    var wa = waMessages(o);
    var waHTML = wa.list.length ? '<section class="d-section"><h3>Message WhatsApp <span class="muted">(' + wa.lang.toUpperCase() + ')</span></h3>' +
        wa.list.map(function(m, i) {
            return '<div class="wa-msg"><div class="wa-msg-head"><strong>' + escapeHTML(m.label) + '</strong>' +
                '<button type="button" class="btn btn-small" data-action="copy_wa" data-index="' + i + '">Copier</button></div>' +
                '<p>' + escapeHTML(m.text).replace(/\n/g, '<br>') + '</p></div>';
        }).join('') + '</section>' : '';

    var student = '';
    if (isStudent(o)) {
        student = '<section class="d-section"><h3>Tarif étudiant</h3>' +
            '<label class="check"><input type="checkbox" id="studentVerified"' + (o.studentVerified ? ' checked' : '') + '>' +
            '<span>Justificatif vérifié<small>' + (o.studentVerified && o.studentVerifiedAt ? 'Vérifié le ' + escapeHTML(shortDate(o.studentVerifiedAt)) : 'Carte étudiante ou attestation de diplôme reçue et contrôlée.') + '</small></span></label></section>';
    }

    var notes = (o.notes || []).map(function(n) {
        return '<li class="note">' + escapeHTML(n.text) + '<span class="note-meta">' + escapeHTML(shortDate(n.date)) + '</span></li>';
    }).join('');

    var others = '';
    if (o.hasCredentials && next.indexOf('copy_access') === -1) others += '<button type="button" class="btn" data-action="copy_access" data-id="' + id + '">Copier les accès</button>';
    if (canSendLink(o) && next.indexOf('send_link') === -1) others += '<button type="button" class="btn" data-action="send_link" data-id="' + id + '">' + (o.credentialLinkSentAt ? 'Renvoyer le lien' : 'Envoyer le lien') + '</button>';
    others += '<button type="button" class="btn" data-action="reminder" data-id="' + id + '">Envoyer un rappel</button>';
    if (o.status !== 'refunded') {
        if (o.isPaid) others += '<button type="button" class="btn" data-action="mark_unpaid" data-id="' + id + '">Repasser en non payée</button>';
        else if (next.indexOf('mark_paid') === -1 && !payOpen) others += '<button type="button" class="btn" data-action="mark_paid" data-id="' + id + '">Marquer payée</button>';
        if (o.isPaid) others += '<button type="button" class="btn btn-danger" data-action="refund" data-id="' + id + '">Rembourser</button>';
    }
    var statusOptions = Object.keys(STATUS_LABELS).filter(function(k) { return k !== 'pending'; }).map(function(k) {
        return '<option value="' + k + '">' + STATUS_LABELS[k] + '</option>';
    }).join('');

    return '<header class="d-head"><div>' +
            '<p class="d-eyebrow">' + escapeHTML(refOf(o)) + ' <button type="button" class="copy" data-action="copy_id" data-id="' + id + '" data-value="' + escapeHTML(refOf(o)) + '">copier</button></p>' +
            '<h2 class="d-title" id="drawerTitle">' + escapeHTML(planName(o)) + '</h2>' +
            '<p class="d-sub">' + escapeHTML(formatEuro(o.amount)) + ' · commandée ' + escapeHTML(timeAgo(o.createdAt)) + '</p>' +
        '</div><button type="button" class="icon-btn" data-close aria-label="Fermer"><svg aria-hidden="true"><use href="#i-close"/></svg></button></header>' +
        '<div class="d-badges">' + badges + '</div>' +
        '<div class="d-next">' + next + '<p>' + escapeHTML(nextHint(o)) + '</p></div>' +
        pay +
        waHTML +
        '<section class="d-section"><h3>Suivi</h3>' + timelineHTML(o) + '</section>' +
        '<section class="d-section"><h3>Client et commande</h3><dl class="kv">' +
            kv.map(function(r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') +
        '</dl></section>' +
        student +
        '<section class="d-section"><h3>Notes internes</h3>' +
            (notes ? '<ul class="notes">' + notes + '</ul>' : '') +
            '<div class="note-form"><textarea class="input" id="noteInput" placeholder="Ex. : client relancé sur WhatsApp, paiement promis demain" aria-label="Nouvelle note"></textarea>' +
            '<button type="button" class="btn" data-action="add_note" data-id="' + id + '">Ajouter la note</button></div>' +
        '</section>' +
        '<section class="d-section"><h3>Autres actions</h3><div class="d-actions">' + others +
            '<select class="input" id="drawerStatus" aria-label="Changer le statut" style="width:auto"><option value="">Changer le statut…</option>' + statusOptions + '</select>' +
        '</div></section>' +
        '<div class="d-danger"><button type="button" class="btn btn-danger" data-action="delete" data-id="' + id + '">Supprimer la commande</button></div>';
}

// ===== Analytics =====
async function loadAnalytics() {
    var period = $('analyticsPeriod') ? $('analyticsPeriod').value : '30';
    try {
        var data = await api('/analytics?period=' + period);
        if (!data) return;
        renderRevenueChart(data.revenue.daily || []);
        renderBreakdown('planBreakdown', data.revenue.byPlan || {}, data.orders.byPlan || {}, function(k) { return (PLAN_NAMES[k] || k) + (/student/.test(k) ? ' (étudiant)' : /salary/.test(k) ? ' (salarié)' : ''); });
        renderBreakdown('audienceBreakdown', data.revenue.byAudience || {}, data.orders.byAudience || {}, formatAudience);
        renderLanguageBreakdown(data.orders.byLanguage || {});
        renderKPIs(data);
    } catch (err) {
        showToast('Statistiques indisponibles', 'error');
    }
}
function renderRevenueChart(daily) {
    var box = $('revenueChart');
    if (!daily.length) { box.innerHTML = '<p class="empty">Aucune commande sur la période.</p>'; return; }
    var max = Math.max.apply(null, daily.map(function(d) { return d.revenue; })) || 1;
    box.innerHTML = '<div class="bars">' + daily.map(function(d) {
        var h = d.revenue ? Math.max(3, (d.revenue / max) * 100) : 1;
        return '<div class="bar-col' + (d.revenue ? '' : ' zero') + '" title="' + escapeHTML(d.date + ' : ' + formatEuro(d.revenue) + ' encaissés, ' + d.orders + ' commande(s)') + '">' +
            '<span class="bar-value">' + (d.revenue ? escapeHTML(d.revenue) : '') + '</span>' +
            '<span class="bar" style="height:' + h + '%"></span>' +
            '<span class="bar-label">' + escapeHTML(d.date.slice(8, 10) + '/' + d.date.slice(5, 7)) + '</span></div>';
    }).join('') + '</div>';
}
function renderBreakdown(id, revenueMap, ordersMap, nameFn) {
    var box = $(id);
    var keys = Object.keys(ordersMap).sort(function(a, b) { return (revenueMap[b] || 0) - (revenueMap[a] || 0) || ordersMap[b] - ordersMap[a]; });
    if (!keys.length) { box.innerHTML = '<p class="empty">Aucune donnée.</p>'; return; }
    var total = keys.reduce(function(s, k) { return s + (revenueMap[k] || 0); }, 0) || 1;
    box.innerHTML = keys.map(function(k) {
        var pct = ((revenueMap[k] || 0) / total) * 100;
        return '<div><div class="bd-head"><span>' + escapeHTML(nameFn(k)) + '</span><span class="bd-value">' + euroHTML(revenueMap[k] || 0) + ' · ' + ordersMap[k] + ' cmd</span></div>' +
            '<div class="bd-bar"><div class="bd-fill" style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    }).join('');
}
function renderLanguageBreakdown(map) {
    var box = $('languageBreakdown');
    var names = { fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand' };
    var keys = Object.keys(map).sort(function(a, b) { return map[b] - map[a]; });
    if (!keys.length) { box.innerHTML = '<p class="empty">Aucune donnée.</p>'; return; }
    var total = keys.reduce(function(s, k) { return s + map[k]; }, 0) || 1;
    box.innerHTML = keys.map(function(k) {
        var pct = (map[k] / total) * 100;
        return '<div><div class="bd-head"><span>' + escapeHTML(names[k] || k) + '</span><span class="bd-value">' + map[k] + ' · ' + pct.toFixed(0) + ' %</span></div>' +
            '<div class="bd-bar"><div class="bd-fill" style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    }).join('');
}
function renderKPIs(data) {
    var rows = [
        ['Encaissé', euroHTML(data.revenue.total), true],
        ['À encaisser', euroHTML(data.revenue.due), true],
        ['Commandes', data.orders.total],
        ['Panier moyen (payées)', escapeHTML(data.conversion.averageOrderValue.toFixed(2).replace('.', ',')) + '<span class="cur">€</span>', true],
        ['Commandes activées', data.conversion.completionRate.toFixed(0) + ' %']
    ];
    if (state.stats && state.stats.avgActivationMinutes != null) rows.push(['Délai d\'activation moyen (30 j)', formatDuration(state.stats.avgActivationMinutes)]);
    if (data.topPlans && data.topPlans.length) rows.push(['Offre la plus vendue', (PLAN_NAMES[data.topPlans[0].plan] || data.topPlans[0].plan)]);
    $('kpiSection').innerHTML = rows.map(function(r) {
        return '<div><dt>' + escapeHTML(r[0]) + '</dt><dd class="mono">' + (r[2] ? r[1] : escapeHTML(r[1])) + '</dd></div>';
    }).join('');
}
on('refreshAnalytics', 'click', loadAnalytics);
on('analyticsPeriod', 'change', loadAnalytics);

// ===== Messages =====
async function loadInbox(countOnly) {
    if (!countOnly) $('inboxList').innerHTML = '<p class="empty"><span class="spinner"></span>Chargement…</p>';
    try {
        var data = await api('/inbox?limit=80');
        if (!data) return;
        if (!data.success) throw new Error(data.error || 'Messagerie indisponible');
        state.inbox = data.items || [];
        updateInboxCount();
        if (countOnly) return;
        renderInboxList();
        if (state.inboxId) viewInboxMessage(state.inboxId);
    } catch (err) {
        if (!countOnly) $('inboxList').innerHTML = '<p class="empty">Messagerie indisponible.</p>';
    }
}
function updateInboxCount() {
    var unread = state.inbox.filter(function(m) { return !m.read; }).length;
    var badge = $('navCountInbox');
    if (badge) { badge.hidden = !unread; badge.textContent = unread; }
    setText('inboxCount', state.inbox.length + ' message' + (state.inbox.length > 1 ? 's' : '') + (unread ? ', ' + unread + ' non lu' + (unread > 1 ? 's' : '') : ''));
}
function renderInboxList() {
    var list = $('inboxList');
    if (!state.inbox.length) { list.innerHTML = '<p class="empty">Aucun message.</p>'; return; }
    list.innerHTML = state.inbox.map(function(m) {
        var cls = 'inbox-item' + (m.read ? '' : ' unread') + (m.id === state.inboxId ? ' active' : '');
        return '<div class="' + cls + '" data-message="' + escapeHTML(m.id) + '" tabindex="0">' +
            '<div class="inbox-item-top"><span class="inbox-from">' + escapeHTML(m.fromEmail || m.from || '-') + '</span><span class="inbox-date">' + escapeHTML(shortDate(m.receivedAt)) + '</span></div>' +
            '<div class="inbox-subject">' + escapeHTML(m.subject || '(sans objet)') + '</div>' +
            '<div class="inbox-preview">' + escapeHTML(m.preview || '') + '</div></div>';
    }).join('');
}
on('inboxList', 'click', function(e) {
    var item = e.target.closest('[data-message]');
    if (item) viewInboxMessage(item.dataset.message);
});
on('inboxList', 'keydown', function(e) {
    var item = e.target.closest('[data-message]');
    if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); viewInboxMessage(item.dataset.message); }
});

async function viewInboxMessage(id) {
    state.inboxId = id;
    renderInboxList();
    var detail = $('inboxDetail');
    detail.innerHTML = '<p class="empty"><span class="spinner"></span>Chargement…</p>';
    try {
        var data = await api('/inbox?id=' + encodeURIComponent(id));
        if (!data) return;
        if (!data.success) throw new Error(data.error || 'Message introuvable');
        renderInboxDetail(data.item);
        if (!data.item.read) markInboxRead(id, true);
        if (window.innerWidth < 860) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        detail.innerHTML = '<p class="empty">Impossible d\'ouvrir ce message.</p>';
    }
}
function renderInboxDetail(item) {
    var orders = (item.orderMatches || []).map(function(o) {
        return '<button type="button" class="inbox-badge" data-action="open" data-id="' + escapeHTML(o.sessionId) + '">Commande ' + escapeHTML(o.sessionId) + ' · ' + escapeHTML(STATUS_LABELS[o.status] || o.status) + '</button>';
    }).join(' ');
    var thread = (item.messages || []).map(function(m) {
        var label = (m.direction === 'outgoing' ? 'Réponse envoyée · ' : 'Reçu · ') + shortDate(m.createdAt);
        return '<div class="inbox-message ' + escapeHTML(m.direction || 'incoming') + '"><div class="inbox-message-label">' + escapeHTML(label) + '</div>' +
            '<div class="inbox-message-body">' + escapeHTML(m.text || '') + '</div></div>';
    }).join('');
    var box = item.mailbox || 'contact@kareer.pro';
    $('inboxDetail').innerHTML =
        '<div><h2>' + escapeHTML(item.subject || '(sans objet)') + '</h2>' +
        '<div class="inbox-meta"><span>De : ' + escapeHTML(item.from || '-') + '</span><span>À : ' + escapeHTML((item.to || []).join(', ')) + '</span><span>Reçu le ' + escapeHTML(safeDate(item.receivedAt)) + '</span></div>' +
        (orders ? '<div style="margin-top:8px">' + orders + '</div>' : '') + '</div>' +
        '<div class="inbox-thread">' + thread + '</div>' +
        '<div class="inbox-reply">' +
            '<textarea id="inboxReplyBody" class="input" placeholder="Votre réponse" aria-label="Réponse"></textarea>' +
            '<div class="row"><select id="inboxReplyFrom" class="input" aria-label="Envoyer depuis">' +
                '<option value="' + escapeHTML(box) + '">' + escapeHTML(box) + '</option>' +
                (box !== 'contact@kareer.pro' ? '<option value="contact@kareer.pro">contact@kareer.pro</option>' : '') +
                '<option value="notifications@kareer.pro">notifications@kareer.pro</option>' +
            '</select><button type="button" class="btn btn-primary" id="inboxReplyBtn" data-message-id="' + escapeHTML(item.id) + '">Répondre</button></div>' +
            '<p class="result" id="resultInboxReply"></p>' +
        '</div>';
    on('inboxReplyBtn', 'click', function() { replyInboxMessage(item.id); });
}
async function markInboxRead(id, silent) {
    var data = await api('/inbox', { method: 'POST', body: { action: 'mark_read', id: id } });
    if (data && data.success) {
        state.inbox.forEach(function(m) { if (m.id === id) m.read = true; });
        updateInboxCount();
        renderInboxList();
        if (!silent) showToast('Message marqué lu', 'success');
    }
}
async function replyInboxMessage(id) {
    var body = $('inboxReplyBody'), from = $('inboxReplyFrom');
    var message = body ? body.value.trim() : '';
    if (!message) return showToast('Écrivez votre réponse', 'error');
    setResult('resultInboxReply', 'Envoi…');
    var data = await api('/inbox', { method: 'POST', body: { action: 'reply', id: id, message: message, fromAddress: from ? from.value : undefined } });
    if (!data) return;
    if (!data.success) return setResult('resultInboxReply', data.error || 'Réponse non envoyée', false);
    showToast('Réponse envoyée', 'success');
    if (data.item) renderInboxDetail(data.item);
    loadInbox(true);
}
on('refreshInbox', 'click', function() { loadInbox(); });

// ===== Tools =====
async function loadConfigCheck() {
    try {
        var data = await api('/config-check');
        if (!data) return;
        var notUsed = { cfgStripe: true, cfgWebhook: true };
        [['cfgStripe', data.stripe], ['cfgWebhook', data.webhook], ['cfgResend', data.resend], ['cfgTelegram', data.telegram], ['cfgKV', data.kv], ['cfgCredentials', data.credentialsEncryption]].forEach(function(item) {
            var el = $(item[0]);
            if (!el) return;
            if (item[1]) { el.textContent = 'Actif'; el.className = 'pill pill-ok'; return; }
            if (notUsed[item[0]]) { el.textContent = 'Non utilisé'; el.className = 'pill'; el.title = 'Paiement sur WhatsApp : Stripe n\'est pas nécessaire'; return; }
            el.textContent = 'Non configuré';
            el.className = 'pill pill-bad';
        });
    } catch (err) {}
}

async function runTool(btn, resultId, body, describe) {
    btn.disabled = true;
    setResult(resultId, 'En cours…');
    try {
        var data = await api('/automation', { method: 'POST', body: body });
        if (!data) return;
        if (!data.success) return setResult(resultId, data.error || 'Échec', false);
        var msg = describe(data.result || {});
        setResult(resultId, msg, true);
        showToast(msg, 'success');
        afterChange(null);
    } catch (err) {
        setResult(resultId, 'Erreur réseau', false);
    } finally {
        btn.disabled = false;
    }
}
on('btnProcessPending', 'click', function() {
    runTool(this, 'resultProcessPending', { action: 'process_pending' }, function(r) { return (r.processed || 0) + ' commande(s) traitée(s)'; });
});
on('btnSendReminder', 'click', function() {
    var id = $('reminderSessionId').value.trim();
    if (!id) return showToast('Indiquez le numéro de commande', 'error');
    runTool(this, 'resultSendReminder', { action: 'send_reminder', session_id: id }, function(r) { return r.sent === false ? (r.reason || 'Non envoyé') : 'E-mail envoyé à ' + (r.email || 'client'); });
});
on('btnSendLegacyClientOffer', 'click', function() {
    var email = $('legacyClientEmail').value.trim(), firstName = $('legacyClientFirstName').value.trim();
    if (!email || !firstName) return showToast('Indiquez l\'e-mail et le prénom', 'error');
    if (!confirm('Envoyer l\'offre ancien client à ' + firstName + ' <' + email + '> ?')) return;
    runTool(this, 'resultLegacyClientOffer', { action: 'send_legacy_customer_offer', email: email, firstName: firstName }, function(r) {
        $('legacyClientEmail').value = ''; $('legacyClientFirstName').value = '';
        return 'Offre envoyée à ' + (r.email || email) + (r.promoCode ? ' avec le code ' + r.promoCode : '');
    });
});
on('btnBulkUpdate', 'click', function() {
    var from = $('bulkFrom').value, to = $('bulkTo').value;
    if (from === to) return showToast('Choisissez deux statuts différents', 'error');
    if (!confirm('Passer toutes les commandes « ' + STATUS_LABELS[from] + ' » en « ' + STATUS_LABELS[to] + ' » ?')) return;
    runTool(this, 'resultBulkUpdate', { action: 'bulk_update', from_status: from, to_status: to }, function(r) { return (r.updated || 0) + ' commande(s) mise(s) à jour'; });
});
on('btnCleanup', 'click', function() {
    var days = parseInt($('cleanupDays').value, 10);
    if (!days || days < 30) return showToast('Minimum 30 jours', 'error');
    if (!confirm('Supprimer les commandes activées ou remboursées depuis plus de ' + days + ' jours ?')) return;
    runTool(this, 'resultCleanup', { action: 'cleanup_old', days: days }, function(r) { return (r.cleaned || 0) + ' supprimée(s), ' + (r.totalRemaining || 0) + ' restante(s)'; });
});
on('btnRefund', 'click', async function() {
    var id = $('refundSessionId').value.trim();
    if (!id) return showToast('Indiquez le numéro de commande', 'error');
    this.disabled = true;
    var data = await refundOrder(id, $('refundReason').value);
    this.disabled = false;
    if (data) { setResult('resultRefund', 'Remboursement enregistré (' + formatEuro(data.refund.amount) + ')', true); afterChange(id); }
});
on('btnExport', 'click', async function() {
    var format = $('exportFormat').value, status = $('exportStatus').value;
    try {
        var res = await fetch(API_BASE + '/export?format=' + format + (status ? '&status=' + status : ''), { headers: authHeaders() });
        if (res.status === 401) return logout401();
        var blob = await res.blob();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'kareer-commandes.' + format;
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('Export téléchargé', 'success');
    } catch (err) { showToast('Export impossible', 'error'); }
});

// ===== Promo codes =====
async function authFetch(url, opts) {
    opts = opts || {};
    return fetch(url, Object.assign({}, opts, { headers: Object.assign(authHeaders(), opts.headers || {}) }));
}
function updatePromoValuePlaceholder() {
    var input = $('promoValue');
    if ($('promoType').value === 'percentage') { input.placeholder = '10 (pour 10 %)'; input.max = '100'; }
    else { input.placeholder = '10 (pour 10 €)'; input.removeAttribute('max'); }
}
async function createPromoCode(event) {
    event.preventDefault();
    var type = $('promoType').value;
    var value = parseFloat($('promoValue').value);
    if (!value || value <= 0) return showToast('Valeur invalide', 'error');
    if (type === 'percentage' && value > 100) return showToast('100 % maximum', 'error');
    var code = $('promoCode').value.trim().toUpperCase();
    try {
        var res = await authFetch('/api/rewards?type=promo', {
            method: 'POST',
            body: JSON.stringify({
                code: code || null,
                type: type,
                value: value,
                maxUses: parseInt($('promoMaxUses').value, 10) || null,
                minAmount: parseFloat($('promoMinAmount').value) || 0,
                description: $('promoDescription').value.trim(),
                expiresAt: $('promoExpiry').value || null,
                applicablePlans: $('promoPlans').value,
                autoGenerate: !code
            })
        });
        if (res.status === 401) return logout401();
        var data = await res.json();
        if (!data.success) return showToast(data.error || 'Code non créé', 'error');
        showToast('Code créé : ' + data.code, 'success');
        $('createPromoForm').reset();
        loadPromos();
    } catch (err) { showToast('Erreur réseau', 'error'); }
}
async function loadPromos() {
    var list = $('promosList');
    list.innerHTML = '<p class="empty"><span class="spinner"></span>Chargement…</p>';
    try {
        var res = await authFetch('/api/rewards?type=promo');
        if (res.status === 401) return logout401();
        var data = await res.json();
        var codes = data.codes || [];
        if (!codes.length) { list.innerHTML = '<p class="empty">Aucun code pour l\'instant. Créez le premier à gauche.</p>'; return; }
        var groups = [{ title: 'Actifs', items: [] }, { title: 'Expirés, épuisés ou désactivés', items: [] }];
        codes.forEach(function(p) {
            var expired = p.expiresAt && new Date(p.expiresAt) < new Date();
            var exhausted = p.maxUses && p.usedCount >= p.maxUses;
            var active = p.active && !expired && !exhausted;
            groups[active ? 0 : 1].items.push({ p: p, active: active, label: active ? 'Actif' : expired ? 'Expiré' : exhausted ? 'Épuisé' : 'Désactivé' });
        });
        list.innerHTML = groups.filter(function(g) { return g.items.length; }).map(function(g) {
            return '<h2 class="promo-group-title">' + g.title + ' (' + g.items.length + ')</h2>' + g.items.map(promoCard).join('');
        }).join('');
    } catch (err) {
        list.innerHTML = '<p class="empty">Impossible de charger les codes.</p>';
    }
}
function promoCard(item) {
    var p = item.p;
    var code = escapeHTML(p.code);
    var plans = p.applicablePlans === 'all' || !p.applicablePlans ? 'Toutes' : [].concat(p.applicablePlans).map(function(k) { return PLAN_NAMES[k] || k; }).filter(function(v, i, a) { return a.indexOf(v) === i; }).join(', ');
    return '<div class="promo' + (item.active ? '' : ' off') + '">' +
        '<div class="promo-head"><span class="promo-code">' + code + '</span><span class="pill ' + (item.active ? 'pill-ok' : item.label === 'Expiré' ? 'pill-bad' : '') + '">' + item.label + '</span></div>' +
        (p.description ? '<p class="promo-desc">' + escapeHTML(p.description) + '</p>' : '') +
        '<dl class="promo-meta">' +
            '<div><dt>Réduction</dt><dd>' + (p.type === 'percentage' ? escapeHTML('-' + p.value + ' %') : '-' + euroHTML(p.value)) + '</dd></div>' +
            '<div><dt>Utilisations</dt><dd>' + escapeHTML((p.usedCount || 0) + ' / ' + (p.maxUses ? p.maxUses : '∞')) + '</dd></div>' +
            '<div><dt>Expire</dt><dd>' + escapeHTML(p.expiresAt ? new Date(p.expiresAt).toLocaleDateString('fr-FR') : 'jamais') + '</dd></div>' +
            '<div><dt>Offres</dt><dd>' + escapeHTML(plans) + '</dd></div>' +
            (p.minAmount > 0 ? '<div><dt>Minimum</dt><dd>' + escapeHTML(formatEuro(p.minAmount)) + '</dd></div>' : '') +
        '</dl>' +
        '<div class="promo-actions">' +
            '<button type="button" class="btn btn-small" data-action="promo_toggle" data-code="' + code + '" data-active="' + (!p.active) + '">' + (p.active ? 'Désactiver' : 'Activer') + '</button>' +
            '<button type="button" class="btn btn-small btn-danger" data-action="promo_delete" data-code="' + code + '">Supprimer</button>' +
        '</div></div>';
}
async function togglePromoStatus(code, active) {
    var res = await authFetch('/api/rewards?type=promo', { method: 'PUT', body: JSON.stringify({ code: code, updates: { active: active } }) });
    if (res.status === 401) return logout401();
    var data = await res.json();
    showToast(data.success ? (active ? 'Code activé' : 'Code désactivé') : (data.error || 'Échec'), data.success ? 'success' : 'error');
    if (data.success) loadPromos();
}
async function deletePromo(code) {
    if (!confirm('Supprimer le code ' + code + ' ?')) return;
    var res = await authFetch('/api/rewards?type=promo&code=' + encodeURIComponent(code), { method: 'DELETE' });
    if (res.status === 401) return logout401();
    var data = await res.json();
    showToast(data.success ? 'Code supprimé' : (data.error || 'Échec'), data.success ? 'success' : 'error');
    if (data.success) loadPromos();
}

// ===== Referrals =====
async function loadReferrals() {
    var list = $('referralsList');
    list.innerHTML = '<p class="empty"><span class="spinner"></span>Chargement…</p>';
    try {
        var res = await authFetch('/api/rewards?type=referral');
        if (res.status === 401) return logout401();
        var data = await res.json();
        var refs = data.referrals || [];
        var total = refs.reduce(function(s, r) { return s + (r.referralCount || 0); }, 0);
        setText('totalReferrers', refs.length);
        setText('totalReferrals', total);
        setText('totalReferralEarnings', formatEuro(total * 10));
        if (!refs.length) { list.innerHTML = '<p class="empty">Aucun parrainage pour l\'instant. Chaque client activé reçoit un code à partager.</p>'; return; }
        refs.sort(function(a, b) { return (b.referralCount || 0) - (a.referralCount || 0); });
        list.innerHTML = refs.map(referralCard).join('');
    } catch (err) {
        list.innerHTML = '<p class="empty">Impossible de charger les parrainages.</p>';
    }
}
function referralCard(r) {
    var count = r.referralCount || 0;
    var html = '<div class="promo">' +
        '<div class="promo-head"><span class="promo-code">' + escapeHTML(r.code) + '</span><span class="pill pill-info">' + count + ' filleul' + (count > 1 ? 's' : '') + ' · ' + escapeHTML(formatEuro(count * 10)) + '</span></div>' +
        '<dl class="promo-meta">' +
            '<div><dt>Parrain</dt><dd>' + escapeHTML(r.referrerEmail || r.referrerName || '-') + '</dd></div>' +
            '<div><dt>Récompense</dt><dd>' + (r.rewardMode === 'transfer' ? 'Virement' : 'Codes promo') + '</dd></div>' +
            (r.rewardMode === 'transfer' ? '<div><dt>Solde à verser</dt><dd>' + escapeHTML(formatEuro(r.pendingBalance)) + '</dd></div>' : '') +
            '<div><dt>Depuis</dt><dd>' + escapeHTML(r.createdAt ? new Date(r.createdAt).toLocaleDateString('fr-FR') : '-') + '</dd></div>' +
        '</dl>';
    if (r.transferRequests && r.transferRequests.length) {
        html += '<div class="sublist"><p class="sublist-title">Demandes de virement</p>' + r.transferRequests.map(function(t) {
            var label = t.status === 'completed' ? 'Effectué' : t.status === 'rejected' ? 'Refusé' : 'En attente';
            var info = t.paymentInfo ? ' · ' + escapeHTML(t.paymentInfo.accountName || '') + ' · IBAN ' + escapeHTML(String(t.paymentInfo.iban || '').slice(0, 8)) + '…' : '';
            return '<div class="subitem"><span>' + escapeHTML(formatEuro(t.amount)) + ' · ' + escapeHTML(t.requestedAt ? new Date(t.requestedAt).toLocaleDateString('fr-FR') : '') + info + '</span><span class="pill ' + (t.status === 'completed' ? 'pill-ok' : t.status === 'rejected' ? 'pill-bad' : 'pill-warn') + '">' + label + '</span></div>';
        }).join('') + '</div>';
    }
    if (r.referrals && r.referrals.length) {
        html += '<div class="sublist"><p class="sublist-title">Filleuls</p>' + r.referrals.map(function(f) {
            return '<div class="subitem"><span>' + escapeHTML(f.name || f.email) + '</span><span class="mono">' + escapeHTML(f.usedAt ? new Date(f.usedAt).toLocaleDateString('fr-FR') : '') + '</span></div>';
        }).join('') + '</div>';
    }
    return html + '</div>';
}

// ===== Start =====
(function() {
    var saved = getToken();
    if (saved) {
        authToken = saved;
        showDashboard();
    } else {
        var pw = $('loginPassword');
        if (pw) pw.focus();
    }
})();
