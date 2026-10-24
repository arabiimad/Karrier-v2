// Behaviour for the public pages. Legal pages load this without i18n.js,
// so everything that needs translations checks for it first.

function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
}

function pageLang() {
    return window.currentLang || document.documentElement.lang || 'fr';
}

function moneyFormatter(withCents) {
    const locales = { fr: 'fr-FR', en: 'en-IE', es: 'es-ES', de: 'de-DE' };
    const digits = withCents ? 2 : 0;
    return new Intl.NumberFormat(locales[pageLang()] || 'fr-FR', {
        style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits
    });
}

function formatMoney(amount, withCents) {
    return moneyFormatter(withCents).format(amount);
}

// Big monospace prices: drop the space before the euro sign and set the sign smaller.
function formatAmountHTML(amount) {
    return moneyFormatter(false).formatToParts(amount).map(part => {
        if (part.type === 'currency') return '<span class="cur">' + part.value + '</span>';
        if (part.type === 'literal' && /^\s+$/.test(part.value)) return '';
        return part.value;
    }).join('');
}

// ----- Prices -----

const PLAN_IDS = {
    career: { student: 'career-student', salary: 'career-salary' },
    business: { student: 'business-student', salary: 'business-salary' },
    sales: { student: 'sales-nav', salary: 'sales-nav' },
    recruiter: { student: 'recruiter', salary: 'recruiter' }
};

let audience = safeGet('kareer_audience') === 'salary' ? 'salary' : 'student';

function renderPrices() {
    document.querySelectorAll('[data-money]').forEach(el => {
        const cents = el.hasAttribute('data-cents');
        el.textContent = el.getAttribute('data-money').split('|')
            .map(v => formatMoney(parseFloat(v), cents)).join(' / ');
    });

    const calcFmt = typeof tr === 'function' ? tr('calc_fmt') : '';
    document.querySelectorAll('.plan[data-plan]').forEach(plan => {
        const official = parseFloat(plan.dataset.official);
        const price = parseFloat(plan.dataset[audience]);
        const amountEl = plan.querySelector('[data-price]');
        const calcEl = plan.querySelector('[data-calc]');
        if (amountEl) amountEl.innerHTML = formatAmountHTML(price);
        if (calcEl && calcFmt) {
            calcEl.innerHTML = calcFmt
                .replace('{month}', formatMoney(price / 12, true))
                .replace('{saved}', formatMoney(official - price, true));
        }
    });

    document.querySelectorAll('[data-order]').forEach(link => {
        const ids = PLAN_IDS[link.dataset.order];
        if (ids) link.href = 'checkout.html?plan=' + ids[audience] + '&lang=' + pageLang();
    });
}

function setAudience(next) {
    audience = next === 'salary' ? 'salary' : 'student';
    safeSet('kareer_audience', audience);
    document.querySelectorAll('[data-audience]').forEach(btn => {
        btn.setAttribute('aria-pressed', btn.dataset.audience === audience ? 'true' : 'false');
    });
    renderPrices();
}

document.querySelectorAll('[data-audience]').forEach(btn => {
    btn.addEventListener('click', () => setAudience(btn.dataset.audience));
});

// Kept for any old link that still calls it.
window.allerCheckout = function (planType) {
    const ids = PLAN_IDS[planType];
    window.location.href = 'checkout.html?plan=' + (ids ? ids[audience] : planType) + '&lang=' + pageLang();
};

// ----- Language -----

document.querySelectorAll('button[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
        if (typeof setLanguage === 'function') setLanguage(btn.dataset.lang);
        const menu = btn.closest('details');
        if (menu) menu.open = false;
    });
});
document.addEventListener('kareer:lang', renderPrices);

// ----- Header and menu -----

const header = document.querySelector('.site-header');
if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
}

const menu = document.querySelector('.menu');
if (menu) {
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { menu.open = false; }));
    document.addEventListener('click', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.open = false; });
}

// ----- Cookie notice -----

const cookieNotice = document.getElementById('cookieNotice');
if (cookieNotice && !safeGet('kareer_cookie_consent')) {
    cookieNotice.hidden = false;
    cookieNotice.querySelectorAll('[data-cookie]').forEach(btn => {
        btn.addEventListener('click', () => {
            safeSet('kareer_cookie_consent', btn.dataset.cookie);
            cookieNotice.hidden = true;
        });
    });
}

setAudience(audience);

// A referral link (kareer.pro/?ref=CODE) is remembered for 30 days and prefilled at checkout.
(function rememberReferral() {
    try {
        const code = (new URLSearchParams(window.location.search).get('ref') || '').trim().toUpperCase();
        if (/^[A-Z0-9]{4,20}$/.test(code)) localStorage.setItem('kareer_ref', JSON.stringify({ code: code, at: Date.now() }));
    } catch (e) {}
})();
