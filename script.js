// ===== Safe localStorage helper =====
function safeGet(key) {
    try { return localStorage.getItem(key); } catch(e) { return null; }
}
function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch(e) { /* private browsing */ }
}

// ===== Reduced motion check =====
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===== Shared utilities =====
const LOCALE_MAP = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE' };
function getCurrentLocale() {
    const lang = (typeof currentLang !== 'undefined') ? currentLang : 'fr';
    return LOCALE_MAP[lang] || 'fr-FR';
}
function getTrans(key) {
    const lang = (typeof currentLang !== 'undefined') ? currentLang : 'fr';
    return (typeof translations !== 'undefined' && translations[lang]) ? translations[lang][key] || '' : '';
}

// ===== Theme Toggle =====
(function() {
    // Handle FOUC: convert light-pending (set in <head>) to body.light
    if (document.documentElement.classList.contains('light-pending')) {
        document.body.classList.add('light');
        document.documentElement.classList.remove('light-pending');
    } else {
        const saved = safeGet('karrier_theme');
        if (saved === 'light') document.body.classList.add('light');
    }

    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            // Enable transition class for smooth switching
            if (!prefersReducedMotion) document.body.classList.add('theme-transitioning');
            document.body.classList.toggle('light');
            const isLight = document.body.classList.contains('light');
            safeSet('karrier_theme', isLight ? 'light' : 'dark');
            // Remove transition class after animation completes
            if (!prefersReducedMotion) setTimeout(() => document.body.classList.remove('theme-transitioning'), 500);
        });
    }
})();

// ===== Page Loader =====
window.addEventListener('load', () => {
    const loader = document.getElementById('loader');
    const waSticky = document.querySelector('.whatsapp-sticky');
    if (loader) {
        const delay = prefersReducedMotion ? 200 : 1400;
        setTimeout(() => {
            loader.classList.add('hidden');
            setTimeout(() => {
                loader.style.display = 'none';
                // Show sticky WA button only after loader is gone
                if (waSticky) waSticky.classList.add('ready');
            }, prefersReducedMotion ? 50 : 800);
        }, delay);
    } else {
        // No loader — show immediately
        if (waSticky) waSticky.classList.add('ready');
    }
});

// ===== Language Switcher =====
(function() {
    const langSwitcher = document.getElementById('langSwitcher');
    const langBtn = document.getElementById('langBtn');
    const langDropdown = document.getElementById('langDropdown');
    const langFlag = document.getElementById('langFlag');
    const langCodeEl = document.getElementById('langCode');

    if (langBtn && langDropdown) {
        langBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            langSwitcher.classList.toggle('open');
        });

        document.addEventListener('click', () => {
            langSwitcher.classList.remove('open');
        });

        langDropdown.querySelectorAll('.lang-option').forEach(option => {
            option.addEventListener('click', () => {
                const lang = option.getAttribute('data-lang');
                langDropdown.querySelectorAll('.lang-option').forEach(o => o.classList.remove('active'));
                option.classList.add('active');
                if (typeof langMeta !== 'undefined' && langMeta[lang]) {
                    langFlag.textContent = langMeta[lang].flag;
                    langCodeEl.textContent = langMeta[lang].code;
                }
                if (typeof setLanguage === 'function') setLanguage(lang);
                langSwitcher.classList.remove('open');
            });
        });
    }

    document.querySelectorAll('.mobile-lang-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const lang = btn.getAttribute('data-lang');
            document.querySelectorAll('.mobile-lang-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (typeof setLanguage === 'function') setLanguage(lang);
            if (langDropdown) {
                langDropdown.querySelectorAll('.lang-option').forEach(o => {
                    o.classList.toggle('active', o.getAttribute('data-lang') === lang);
                });
            }
            if (typeof langMeta !== 'undefined' && langMeta[lang]) {
                if (langFlag) langFlag.textContent = langMeta[lang].flag;
                if (langCodeEl) langCodeEl.textContent = langMeta[lang].code;
            }
        });
    });

    const savedLang = safeGet('karrier_lang');
    if (savedLang && savedLang !== 'fr') {
        if (typeof setLanguage === 'function') setLanguage(savedLang);
        if (langDropdown) {
            langDropdown.querySelectorAll('.lang-option').forEach(o => {
                o.classList.toggle('active', o.getAttribute('data-lang') === savedLang);
            });
        }
        if (typeof langMeta !== 'undefined' && langMeta[savedLang]) {
            if (langFlag) langFlag.textContent = langMeta[savedLang].flag;
            if (langCodeEl) langCodeEl.textContent = langMeta[savedLang].code;
        }
        document.querySelectorAll('.mobile-lang-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-lang') === savedLang);
        });
    }
})();

// ===== Particle Background =====
const canvas = document.getElementById('particles');
if (canvas && !prefersReducedMotion) {
    const ctx = canvas.getContext('2d');
    let particles = [];
    let mouseX = 0, mouseY = 0;
    let resizeTimer;

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resizeCanvas();
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resizeCanvas, 150);
    });

    document.addEventListener('mousemove', e => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    class Particle {
        constructor() { this.reset(); }
        reset() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 0.5;
            this.speedX = (Math.random() - 0.5) * 0.4;
            this.speedY = (Math.random() - 0.5) * 0.4;
            this.opacity = Math.random() * 0.5 + 0.1;
            this.color = Math.random() > 0.5 ? '21, 101, 192' : '0, 188, 212';
        }
        update() {
            this.x += this.speedX;
            this.y += this.speedY;
            const dx = mouseX - this.x;
            const dy = mouseY - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 200) {
                this.x += dx * 0.001;
                this.y += dy * 0.001;
            }
            if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
                this.reset();
            }
        }
        draw() {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${this.color}, ${this.opacity})`;
            ctx.fill();
        }
    }

    const isMobile = window.innerWidth < 768;
    const particleCount = isMobile ? Math.min(30, Math.floor(window.innerWidth / 25)) : Math.min(80, Math.floor(window.innerWidth / 15));
    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }

    function drawLines() {
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 150) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(21, 101, 192, ${0.06 * (1 - dist / 150)})`;
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
            }
        }
    }

    let particlesAnimId = null;
    let particlesPaused = false;

    function animateParticles() {
        if (particlesPaused) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });
        drawLines();
        particlesAnimId = requestAnimationFrame(animateParticles);
    }
    animateParticles();

    // Pause particles when tab is hidden (performance)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            particlesPaused = true;
            if (particlesAnimId) cancelAnimationFrame(particlesAnimId);
        } else {
            particlesPaused = false;
            animateParticles();
        }
    });
}

// ===== Scroll Animations =====
const observerOptions = { threshold: 0.15, rootMargin: '0px 0px -40px 0px' };
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

document.querySelectorAll('.animate-fade-in, .animate-fade-up, .animate-slide-left, .animate-slide-right').forEach(el => {
    observer.observe(el);
});

// ===== Header Scroll Effect + Progress Bar =====
const scrollProgress = document.getElementById('scrollProgress');
const headerEl = document.querySelector('.header');
const backToTopEl = document.getElementById('backToTop');
let scrollTicking = false;

window.addEventListener('scroll', () => {
    if (!scrollTicking) {
        requestAnimationFrame(() => {
            const y = window.scrollY;
            if (headerEl) headerEl.classList.toggle('scrolled', y > 50);
            if (backToTopEl) backToTopEl.classList.toggle('visible', y > 400);
            if (scrollProgress) {
                const docHeight = document.documentElement.scrollHeight - window.innerHeight;
                scrollProgress.style.width = (docHeight > 0 ? (y / docHeight) * 100 : 0) + '%';
            }
            scrollTicking = false;
        });
        scrollTicking = true;
    }
});

// ===== Back to Top =====
if (backToTopEl) {
    backToTopEl.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// ===== Mobile Menu =====
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const mobileMenu = document.getElementById('mobileMenu');
if (mobileMenuBtn && mobileMenu) {
    function closeMobileMenu() {
        mobileMenuBtn.classList.remove('open');
        mobileMenu.classList.remove('open');
        mobileMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }

    mobileMenuBtn.addEventListener('click', () => {
        const isOpen = mobileMenu.classList.toggle('open');
        mobileMenuBtn.classList.toggle('open');
        mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
        document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    mobileMenu.querySelectorAll('.mobile-link').forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });

    // Close menu on click outside
    document.addEventListener('click', (e) => {
        if (mobileMenu.classList.contains('open') && !mobileMenu.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
            closeMobileMenu();
        }
    });
}

// ===== ESC Key Handler =====
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close mobile menu
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        const mobileMenu = document.getElementById('mobileMenu');
        if (mobileMenu && mobileMenu.classList.contains('open')) {
            mobileMenuBtn.classList.remove('open');
            mobileMenu.classList.remove('open');
            document.body.style.overflow = '';
        }
        // Close language dropdown
        const langSwitcher = document.getElementById('langSwitcher');
        if (langSwitcher && langSwitcher.classList.contains('open')) {
            langSwitcher.classList.remove('open');
        }
        // Close compare table
        const compareTable = document.getElementById('compareTable');
        if (compareTable && compareTable.classList.contains('open')) {
            compareTable.classList.remove('open');
            const compareBtn = document.getElementById('compareBtn');
            if (compareBtn) {
                compareBtn.setAttribute('aria-expanded', 'false');
                const lang = (typeof currentLang !== 'undefined') ? currentLang : 'fr';
                const t = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : null;
                const openTxt = (t && t.compare_btn) ? t.compare_btn : 'Comparer toutes les offres';
                compareBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg> ' + openTxt;
            }
        }
    }
});

// Tabs désactivés — plus de distinction étudiant/pro

// ===== Stats Counter Animation =====
const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const statNumbers = entry.target.querySelectorAll('.stat-number');
            statNumbers.forEach(el => {
                const target = parseFloat(el.getAttribute('data-target'));
                const suffix = el.getAttribute('data-suffix') || '';
                const isDecimal = el.getAttribute('data-decimal') === 'true';
                const duration = 2000;
                let startTime = null;

                function animateStat(timestamp) {
                    if (!startTime) startTime = timestamp;
                    const progress = Math.min((timestamp - startTime) / duration, 1);
                    const eased = 1 - Math.pow(1 - progress, 3);
                    const current = target * eased;

                    const localeMap = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE' };
                    const locale = localeMap[(typeof currentLang !== 'undefined') ? currentLang : 'fr'] || 'fr-FR';
                    if (isDecimal) {
                        el.textContent = current.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + suffix;
                    } else {
                        el.textContent = Math.floor(current).toLocaleString(locale) + suffix;
                    }

                    if (progress < 1) requestAnimationFrame(animateStat);
                }
                requestAnimationFrame(animateStat);
            });
            statsObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.3 });

const statsSection = document.querySelector('.stats-section');
if (statsSection) statsObserver.observe(statsSection);

// ===== FAQ Accordion =====
document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
        const item = btn.parentElement;
        const isOpen = item.classList.contains('open');

        document.querySelectorAll('.faq-item').forEach(faq => {
            faq.classList.remove('open');
            const qBtn = faq.querySelector('.faq-question');
            if (qBtn) qBtn.setAttribute('aria-expanded', 'false');
        });

        if (!isOpen) {
            item.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
        }
    });
});

// ===== Comparison Table Toggle =====
const compareBtn = document.getElementById('compareBtn');
const compareTable = document.getElementById('compareTable');
if (compareBtn && compareTable) {
    compareBtn.addEventListener('click', () => {
        const isOpen = compareTable.classList.toggle('open');
        compareBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        const lang = (typeof currentLang !== 'undefined') ? currentLang : 'fr';
        const t = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : null;
        const openTxt = (t && t.compare_btn) ? t.compare_btn : 'Comparer toutes les offres';
        const hideText = (t && t.compare_hide) ? t.compare_hide : 'Masquer la comparaison';
        compareBtn.innerHTML = isOpen
            ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg> ' + hideText
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg> ' + openTxt;
    });
}

// ===== Smooth scroll for anchor links =====
document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
        const href = link.getAttribute('href');
        if (href === '#') return;
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});

// ===== Card hover (subtle) =====
document.querySelectorAll('.pricing-card').forEach(card => {
    card.addEventListener('mouseleave', () => {
        const isPopular = card.classList.contains('popular');
        card.style.transform = isPopular ? 'scale(1.03)' : '';
    });
});

// ===== Counter animation for prices =====
function animateValue(el, start, end, duration) {
    let startTime = null;
    function step(timestamp) {
        if (!startTime) startTime = timestamp;
        const progress = Math.min((timestamp - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.floor(start + (end - start) * eased);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

const priceObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const el = entry.target;
            const finalValue = parseInt(el.getAttribute('data-value') || el.textContent);
            animateValue(el, 0, finalValue, 1200);
            priceObserver.unobserve(el);
        }
    });
}, { threshold: 0.5 });

document.querySelectorAll('.price-amount').forEach(el => {
    priceObserver.observe(el);
});

// ===== Contact Form =====
const contactForm = document.getElementById('contactForm');
if (contactForm) {
    const formSuccess = document.getElementById('formSuccess');
    const submitBtn = document.getElementById('submitBtn');
    const sendAnother = document.getElementById('sendAnother');

    function validateEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function clearErrors() {
        contactForm.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
    }

    function showError(fieldId) {
        const field = document.getElementById(fieldId);
        if (field) field.classList.add('error');
    }

    contactForm.addEventListener('submit', function(e) {
        e.preventDefault();
        clearErrors();

        const name = document.getElementById('name');
        const email = document.getElementById('email');
        const subject = document.getElementById('subject');
        const message = document.getElementById('message');
        let valid = true;

        if (!name.value.trim()) { showError('name'); valid = false; }
        if (!email.value.trim() || !validateEmail(email.value)) { showError('email'); valid = false; }
        if (!subject.value) { showError('subject'); valid = false; }
        if (!message.value.trim()) { showError('message'); valid = false; }

        if (!valid) return;

        const btnText = submitBtn.querySelector('.btn-text');
        const btnLoader = submitBtn.querySelector('.btn-loader');
        btnText.style.display = 'none';
        btnLoader.style.display = 'inline-flex';
        submitBtn.disabled = true;

        setTimeout(() => {
            const mailtoSubject = encodeURIComponent(`[Karrier] ${subject.options[subject.selectedIndex].text}`);
            const mailtoBody = encodeURIComponent(
                `Nom: ${name.value}\nEmail: ${email.value}\n\n${message.value}`
            );

            window.location.href = `mailto:contact@karrier.pro?subject=${mailtoSubject}&body=${mailtoBody}`;

            contactForm.style.display = 'none';
            formSuccess.style.display = 'block';

            btnText.style.display = 'inline';
            btnLoader.style.display = 'none';
            submitBtn.disabled = false;
        }, 800);
    });

    ['name', 'email', 'subject', 'message'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => el.classList.remove('error'));
            el.addEventListener('change', () => el.classList.remove('error'));
        }
    });

    if (sendAnother) {
        sendAnother.addEventListener('click', () => {
            contactForm.reset();
            contactForm.style.display = 'flex';
            formSuccess.style.display = 'none';
        });
    }
}

// ===== Keyboard navigation for FAQ =====
document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            btn.click();
        }
    });
});

// ===== Promo Code =====
window.appliedPromo = null;

async function applyPromoCode() {
    const input = document.getElementById('promoCodeInput');
    const result = document.getElementById('promoResult');
    const code = (input ? input.value || '' : '').trim().toUpperCase();
    if (!code) return;

    const btn = document.getElementById('promoApplyBtn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    if (result) { result.className = 'promo-result'; result.textContent = ''; }

    try {
        const r = await fetch('/api/order-status?action=validate-promo&code=' + encodeURIComponent(code) + '&amount=100');
        const data = await r.json();
        if (data.valid) {
            window.appliedPromo = { code: data.code, discount: data.discount };
            if (result) {
                result.className = 'promo-result valid';
                result.textContent = 'Code appliqué ! -' + data.discount + '€ sur votre commande';
            }
            updatePricesWithPromo(data.discount);
        } else {
            window.appliedPromo = null;
            if (result) {
                result.className = 'promo-result invalid';
                result.textContent = data.error || 'Code invalide';
            }
            updatePricesWithPromo(0);
        }
    } catch (e) {
        if (result) {
            result.className = 'promo-result invalid';
            result.textContent = 'Erreur de connexion';
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Appliquer'; }
    }
}

function updatePricesWithPromo(discount) {
    // Save original prices on first call
    document.querySelectorAll('.price-amount').forEach(function(el) {
        if (!el.dataset.originalPrice) {
            el.dataset.originalPrice = el.textContent.trim();
        }
    });

    // Remove existing promo UI
    document.querySelectorAll('.promo-discount-badge, .promo-original-price').forEach(function(el) { el.remove(); });

    document.querySelectorAll('.price-amount').forEach(function(el) {
        var original = parseInt(el.dataset.originalPrice, 10);
        if (isNaN(original)) return;

        if (discount > 0) {
            var discounted = Math.max(0, original - discount);
            // Show struck-through original
            var oldPriceEl = document.createElement('span');
            oldPriceEl.className = 'promo-original-price';
            oldPriceEl.style.cssText = 'font-size:0.55em;color:#9ca3af;text-decoration:line-through;margin-right:4px;vertical-align:middle;font-weight:600';
            oldPriceEl.textContent = original;
            el.parentNode.insertBefore(oldPriceEl, el);
            // Update displayed price
            el.textContent = discounted;
            el.style.color = '#10b981';
            // Green badge
            var badge = document.createElement('span');
            badge.className = 'promo-discount-badge';
            badge.style.cssText = 'display:inline-block;background:#10b981;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px;vertical-align:middle';
            badge.textContent = '-' + discount + '\u20ac';
            el.parentNode.insertBefore(badge, el.nextSibling);
        } else {
            // Restore original
            el.textContent = el.dataset.originalPrice;
            el.style.color = '';
        }
    });
}

// commanderWhatsApp — sends discounted price if promo applied
function commanderWhatsApp(planLabel) {
    const phone = '212651064637';
    var msg;
    if (window.appliedPromo) {
        // Extract amount from planLabel (e.g. "LinkedIn Career 1 an — 100€")
        var match = planLabel.match(/(\d+)\u20ac/);
        var original = match ? parseInt(match[1], 10) : 0;
        var discounted = Math.max(0, original - window.appliedPromo.discount);
        var discountedLabel = original > 0 ? planLabel.replace(original + '\u20ac', discounted + '\u20ac') : planLabel;
        msg = encodeURIComponent('Bonjour, je souhaite commander : ' + discountedLabel + ' \u2014 Code promo: ' + window.appliedPromo.code + ' (-' + window.appliedPromo.discount + '\u20ac)');
    } else {
        msg = encodeURIComponent('Bonjour, je souhaite commander : ' + planLabel);
    }
    window.open('https://wa.me/' + phone + '?text=' + msg, '_blank');
}

// Allow Enter key to apply promo
(function() {
    var input = document.getElementById('promoCodeInput');
    if (input) {
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') applyPromoCode();
        });
    }
})();

// commanderWhatsApp defined above in Promo Code section

// ===== Stripe Checkout (for plans that support it) =====
async function commanderStripe(plan, audience, language) {
    try {
        const body = { plan, audience, language: language || 'fr' };
        if (window.appliedPromo) body.promoCode = window.appliedPromo.code;
        const r = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await r.json();
        if (data.url) {
            window.location.href = data.url;
        } else {
            console.error('Checkout error:', data.error);
        }
    } catch (e) {
        console.error('Checkout fetch error:', e);
    }
}


// ===== Ripple Effect on CTA Buttons =====
document.querySelectorAll('.cta-button').forEach(btn => {
    btn.addEventListener('click', function(e) {
        const ripple = document.createElement('span');
        ripple.classList.add('ripple');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
        this.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
    });
});

// ===== Cookie Banner RGPD =====
(function() {
    const banner = document.getElementById('cookieBanner');
    if (!banner) return;

    const consent = safeGet('karrier_cookie_consent');
    if (consent) return; // Already decided

    // Show after short delay
    setTimeout(() => banner.classList.add('visible'), 1200);

    document.getElementById('cookieAccept').addEventListener('click', () => {
        safeSet('karrier_cookie_consent', 'accepted');
        banner.classList.remove('visible');
        setTimeout(() => banner.remove(), 400);
    });

    document.getElementById('cookieDecline').addEventListener('click', () => {
        safeSet('karrier_cookie_consent', 'declined');
        banner.classList.remove('visible');
        setTimeout(() => banner.remove(), 400);
    });
})();

// ===== Urgency Countdown =====
(function() {
    const el = document.getElementById('urgencyCountdown');
    if (!el) return;

    // Store deadline in sessionStorage so it persists on reload within same tab session
    // but resets on new sessions (realistic urgency)
    const KEY = 'karrier_urgency_end';
    let end = parseInt(safeGet(KEY) || '0');
    const now = Date.now();

    if (!end || end < now) {
        // Set deadline to end of current day (midnight)
        const tomorrow = new Date();
        tomorrow.setHours(23, 59, 59, 999);
        end = tomorrow.getTime();
        safeSet(KEY, String(end));
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    function tick() {
        const remaining = Math.max(0, end - Date.now());
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        el.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
        if (remaining > 0) requestAnimationFrame(tick);
    }
    tick();
})();

