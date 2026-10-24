// Shared email layer: one layout for every message Kareer sends, labels in
// four languages, and a sender that reports failures instead of hiding them.

const fs = require('fs');
const path = require('path');

const FROM = 'Kareer <notifications@kareer.pro>';
const REPLY_TO = 'contact@kareer.pro';
const WHATSAPP_NUMBER = '212651064637';
const WHATSAPP_DISPLAY = '+212 6 51 06 46 37';
const LANGS = ['fr', 'en', 'es', 'de'];
const LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE' };
const TIME_ZONE = 'Europe/Paris';

const C = {
  paper: '#EEF1F4',
  card: '#FFFFFF',
  rule: '#DDE2E8',
  ink: '#16181B',
  ink2: '#3D434C',
  ink3: '#6A717C',
  blue: '#1B4DB8',
  wa: '#1E7A4C',
  soft: '#F4F6F9',
  hl: '#FFE36E'
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

const PLAN_NAMES = {
  career: 'LinkedIn Career',
  business: 'LinkedIn Business',
  'sales-nav': 'Sales Navigator Core',
  recruiter: 'LinkedIn Recruiter Lite',
  coursera: 'Coursera Plus'
};

const AUDIENCE_NAMES = {
  fr: { student: 'Étudiant', salary: 'Salarié' },
  en: { student: 'Student', salary: 'Employee' },
  es: { student: 'Estudiante', salary: 'Asalariado' },
  de: { student: 'Studierende', salary: 'Angestellte' }
};

const FOOTER = {
  fr: {
    why: 'Vous recevez cet e-mail au sujet de votre commande sur kareer.pro.',
    hours: 'Horaires : lundi au vendredi 9 h à 20 h, samedi 10 h à 18 h.',
    legal: 'Kareer est un service indépendant, sans lien avec LinkedIn Corporation.',
    order: 'Commande',
    reply: 'Vous pouvez répondre directement à cet e-mail.'
  },
  en: {
    why: 'You are receiving this email about your order on kareer.pro.',
    hours: 'Hours: Monday to Friday 9am to 8pm, Saturday 10am to 6pm (Paris time).',
    legal: 'Kareer is an independent service, not affiliated with LinkedIn Corporation.',
    order: 'Order',
    reply: 'You can reply to this email directly.'
  },
  es: {
    why: 'Recibes este correo por tu pedido en kareer.pro.',
    hours: 'Horario: de lunes a viernes de 9:00 a 20:00, sábados de 10:00 a 18:00 (hora de París).',
    legal: 'Kareer es un servicio independiente, sin relación con LinkedIn Corporation.',
    order: 'Pedido',
    reply: 'Puedes responder directamente a este correo.'
  },
  de: {
    why: 'Sie erhalten diese E-Mail zu Ihrer Bestellung auf kareer.pro.',
    hours: 'Erreichbar: Montag bis Freitag 9 bis 20 Uhr, Samstag 10 bis 18 Uhr (Pariser Zeit).',
    legal: 'Kareer ist ein unabhängiger Dienst ohne Verbindung zur LinkedIn Corporation.',
    order: 'Bestellung',
    reply: 'Sie können direkt auf diese E-Mail antworten.'
  }
};

function langOf(value) {
  const lang = String(value || '').slice(0, 2).toLowerCase();
  return LANGS.includes(lang) ? lang : 'fr';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSiteUrl() {
  return (process.env.SITE_URL || 'https://kareer.pro').replace(/\/$/, '');
}

function audienceKey(audience) {
  const key = String(audience || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/^(student|etudiant|estudiante)/.test(key)) return 'student';
  if (/^(salary|salarie|employee|asalariado|angestellt)/.test(key)) return 'salary';
  return null;
}

function formatAudience(audience, lang = 'fr') {
  const key = audienceKey(audience);
  if (!key) return '';
  return (AUDIENCE_NAMES[langOf(lang)] || AUDIENCE_NAMES.fr)[key];
}

function planName(plan, planLabel) {
  const base = String(plan || '').replace(/-(student|salary|pro|professional)$/, '');
  return PLAN_NAMES[plan] || PLAN_NAMES[base] || planLabel || plan || 'LinkedIn Premium';
}

// "LinkedIn Business · Étudiant". Offers open to everyone show the name alone.
function formatPlan(plan, audience, lang = 'fr', planLabel) {
  const name = planName(plan, planLabel);
  const who = formatAudience(audience, lang);
  return who ? `${name} · ${who}` : name;
}

function formatOrderPlan(order, lang) {
  return formatPlan(order.plan, order.audience, lang || order.language, order.planLabel);
}

function formatCurrency(amount, currency = 'EUR', lang = 'fr') {
  const numeric = Number(amount || 0);
  const whole = Number.isInteger(numeric);
  try {
    return new Intl.NumberFormat(LOCALES[langOf(lang)], {
      style: 'currency',
      currency: currency || 'EUR',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2
    }).format(numeric);
  } catch (e) {
    return `${numeric} ${currency}`;
  }
}

function formatDate(value, lang = 'fr', withTime = true) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const options = { day: 'numeric', month: 'long', year: 'numeric', timeZone: TIME_ZONE };
  if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat(LOCALES[langOf(lang)], options).format(date);
}

function orderRef(order) {
  return (order && (order.reference || order.sessionId)) || '';
}

function trackingUrl(order) {
  return `${getSiteUrl()}/suivi?id=${encodeURIComponent(order.reference || order.sessionId)}`;
}

function whatsappUrl(text) {
  return `https://wa.me/${WHATSAPP_NUMBER}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

// ---------- HTML pieces ----------

function paragraph(text, opts = {}) {
  const size = opts.small ? 13 : 15;
  const color = opts.small ? C.ink3 : C.ink2;
  const html = opts.html ? text : escapeHtml(text).replace(/\n/g, '<br>');
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color}">${html}</p>`;
}

function detailTable(rows) {
  const safe = (rows || []).filter(row => row && row.value !== undefined && row.value !== null && row.value !== '');
  if (!safe.length) return '';
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:4px 0 22px;border-top:1px solid ${C.rule}">
      ${safe.map(row => `
        <tr>
          <td style="padding:11px 0;border-bottom:1px solid ${C.rule};font-family:${FONT};font-size:14px;color:${C.ink3};vertical-align:top">${escapeHtml(row.label)}</td>
          <td align="right" style="padding:11px 0 11px 16px;border-bottom:1px solid ${C.rule};font-family:${row.mono ? MONO : FONT};font-size:14px;font-weight:600;color:${C.ink};vertical-align:top">${escapeHtml(row.value)}</td>
        </tr>`).join('')}
    </table>`;
}

function emailButton(label, href, options = {}) {
  const bg = options.variant === 'whatsapp' ? C.wa : options.variant === 'ghost' ? C.card : (options.color || C.blue);
  const fg = options.variant === 'ghost' ? C.ink : '#FFFFFF';
  const border = options.variant === 'ghost' ? `1.5px solid ${C.ink}` : `1.5px solid ${bg}`;
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 22px">
      <tr>
        <td style="border-radius:6px;background:${bg};border:${border}">
          <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:700;color:${fg};text-decoration:none;border-radius:6px">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

function stepsBox(title, steps, note) {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px 0 22px">
      ${title ? `<tr><td colspan="2" style="padding:0 0 10px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.ink3}">${escapeHtml(title)}</td></tr>` : ''}
      ${steps.map((step, index) => `
        <tr>
          <td width="30" style="padding:0 0 10px;vertical-align:top;font-family:${MONO};font-size:14px;font-weight:600;color:${C.blue}">${index + 1}.</td>
          <td style="padding:0 0 10px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink2}">${escapeHtml(step)}</td>
        </tr>`).join('')}
      ${note ? `<tr><td colspan="2" style="padding:4px 0 0;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.ink3}">${escapeHtml(note)}</td></tr>` : ''}
    </table>`;
}

function noteBox(text, opts = {}) {
  const border = opts.tone === 'highlight' ? C.hl : C.blue;
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px 0 22px">
      <tr>
        <td style="background:${C.soft};border-left:3px solid ${border};padding:13px 16px;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink2}">
          ${opts.title ? `<strong style="display:block;margin-bottom:4px;color:${C.ink}">${escapeHtml(opts.title)}</strong>` : ''}${escapeHtml(text)}
        </td>
      </tr>
    </table>`;
}

function codeBox(label, code, caption) {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px 0 22px;border:1.5px dashed ${C.ink};border-radius:6px">
      <tr>
        <td style="padding:14px 16px">
          <div style="font-family:${FONT};font-size:13px;color:${C.ink3};margin-bottom:6px">${escapeHtml(label)}</div>
          <div style="font-family:${MONO};font-size:22px;font-weight:600;letter-spacing:.08em;color:${C.ink}">${escapeHtml(code)}</div>
          ${caption ? `<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.ink3};margin-top:6px">${escapeHtml(caption)}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

function linkLine(label, href) {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.ink3}">${escapeHtml(label)}<br><a href="${escapeHtml(href)}" style="color:${C.blue};word-break:break-all">${escapeHtml(href)}</a></p>`;
}

function buildEmailHtml({ siteUrl, title, preheader, content, footer, lang = 'fr', reference }) {
  const url = (siteUrl || getSiteUrl()).replace(/\/$/, '');
  const l = langOf(lang);
  const f = FOOTER[l];
  const why = footer || f.why;
  return `<!doctype html>
<html lang="${l}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(title)}</title>
  <style>
    @media only screen and (max-width:600px){
      .k-shell{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important}
      .k-pad{padding-left:20px!important;padding-right:20px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${C.paper};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader || '')}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.paper}">
    <tr>
      <td align="center" style="padding:28px 12px">
        <table class="k-shell" role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.rule};border-radius:8px">
          <tr>
            <td class="k-pad" style="padding:24px 32px 0">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align:middle">
                    <a href="${url}" style="text-decoration:none;color:${C.ink}">
                      <img src="${url}/kareer-logo.png" width="28" height="28" alt="" style="display:inline-block;vertical-align:middle;border:0;border-radius:6px">
                      <span style="display:inline-block;vertical-align:middle;margin-left:8px;font-family:${FONT};font-size:17px;font-weight:800;color:${C.ink}">Kareer</span>
                    </a>
                  </td>
                  ${reference ? `<td align="right" style="vertical-align:middle;font-family:${FONT};font-size:12px;color:${C.ink3}">${escapeHtml(f.order)} <span style="font-family:${MONO};color:${C.ink}">${escapeHtml(reference)}</span></td>` : ''}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="k-pad" style="padding:26px 32px 8px">
              <h1 style="margin:0 0 16px;font-family:${FONT};font-size:23px;line-height:1.3;font-weight:800;color:${C.ink}">${escapeHtml(title)}</h1>
              ${content}
            </td>
          </tr>
          <tr>
            <td class="k-pad" style="padding:18px 32px 24px;border-top:1px solid ${C.rule}">
              <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:1.55;color:${C.ink3}">
                <a href="${whatsappUrl()}" style="color:${C.ink2};text-decoration:none">WhatsApp ${WHATSAPP_DISPLAY}</a>
                &nbsp;·&nbsp;
                <a href="mailto:contact@kareer.pro" style="color:${C.ink2};text-decoration:none">contact@kareer.pro</a>
                &nbsp;·&nbsp;
                <a href="${url}" style="color:${C.ink2};text-decoration:none">kareer.pro</a>
              </p>
              <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:1.55;color:${C.ink3}">${escapeHtml(f.hours)}</p>
              <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.55;color:${C.ink3}">${escapeHtml(why)} ${escapeHtml(f.legal)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------- Block renderer: one description, an HTML part and a text part ----------

function renderBlocks(blocks, lang = 'fr') {
  const sep = langOf(lang) === 'fr' ? ' : ' : ': ';
  const html = [];
  const text = [];
  (blocks || []).filter(Boolean).forEach(block => {
    switch (block.type) {
      case 'p':
        html.push(paragraph(block.text, block));
        text.push(block.text);
        break;
      case 'details':
        html.push(detailTable(block.rows));
        text.push(block.rows.filter(r => r && r.value !== undefined && r.value !== null && r.value !== '').map(r => `${r.label}${sep}${r.value}`).join('\n'));
        break;
      case 'button':
        html.push(emailButton(block.label, block.href, block));
        text.push(`${block.label}${sep}${block.href}`);
        break;
      case 'steps':
        html.push(stepsBox(block.title, block.items, block.note));
        text.push([block.title, ...block.items.map((item, i) => `${i + 1}. ${item}`), block.note].filter(Boolean).join('\n'));
        break;
      case 'note':
        html.push(noteBox(block.text, block));
        text.push([block.title, block.text].filter(Boolean).join('\n'));
        break;
      case 'code':
        html.push(codeBox(block.label, block.code, block.caption));
        text.push([`${block.label}${sep}${block.code}`, block.caption].filter(Boolean).join('\n'));
        break;
      case 'link':
        html.push(linkLine(block.label, block.href));
        text.push(`${block.label}\n${block.href}`);
        break;
      case 'html':
        html.push(block.html);
        if (block.text) text.push(block.text);
        break;
      default:
        break;
    }
  });
  return { html: html.join('\n'), text: text.join('\n\n') };
}

function renderEmail({ lang = 'fr', title, preheader, reference, blocks, footer, signature = true }) {
  const l = langOf(lang);
  const body = renderBlocks(blocks, l);
  const sign = { fr: "L'équipe Kareer", en: 'The Kareer team', es: 'El equipo de Kareer', de: 'Ihr Kareer-Team' }[l];
  const signHtml = signature ? paragraph(`${FOOTER[l].reply}\n${sign}`, { small: false }) : '';
  const html = buildEmailHtml({ title, preheader, content: body.html + signHtml, footer, lang: l, reference });
  const f = FOOTER[l];
  const text = [
    title,
    reference ? `${f.order} ${reference}` : '',
    body.text,
    signature ? `${f.reply}\n${sign}` : '',
    '--',
    `Kareer · WhatsApp ${WHATSAPP_DISPLAY} · contact@kareer.pro · ${getSiteUrl().replace(/^https?:\/\//, '')}`,
    f.hours
  ].filter(Boolean).join('\n\n');
  return { html, text };
}

// ---------- Sending ----------

function writeOutbox(payload) {
  const dir = process.env.EMAIL_OUTBOX_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(payload.subject || 'email').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const base = path.join(dir, `${Date.now()}-${slug}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...payload, html: undefined }, null, 2));
  fs.writeFileSync(`${base}.html`, payload.html || '');
}

// Never throws. Resend answers errors in the response body, so check it.
async function sendEmail({ to, subject, html, text, replyTo = REPLY_TO, from = FROM, headers }) {
  if (!to) return { sent: false, reason: 'no_recipient' };
  const payload = { from, to, subject, html, text, reply_to: replyTo };
  if (headers) payload.headers = headers;

  try {
    if (process.env.EMAIL_OUTBOX_DIR) {
      writeOutbox(payload);
      return { sent: true, id: 'outbox' };
    }
    if (!process.env.RESEND_API_KEY) {
      console.log(`[Email] Not sent (RESEND_API_KEY missing): ${subject}`);
      return { sent: false, reason: 'not_configured' };
    }
    const { Resend } = require('resend');
    const result = await new Resend(process.env.RESEND_API_KEY).emails.send(payload);
    if (result && result.error) {
      console.error(`[Email] Rejected "${subject}":`, result.error.message || result.error);
      return { sent: false, reason: 'rejected', error: result.error.message || String(result.error) };
    }
    return { sent: true, id: result && result.data ? result.data.id : null };
  } catch (error) {
    console.error(`[Email] Failed "${subject}":`, error.message);
    return { sent: false, reason: 'error', error: error.message };
  }
}

function adminEmail() {
  return process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com';
}

// Short internal alert on Telegram when the bot is configured. Never throws.
async function notifyTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
    });
    return res.ok;
  } catch (error) {
    console.error('[Telegram] Failed:', error.message);
    return false;
  }
}

module.exports = {
  FROM,
  REPLY_TO,
  WHATSAPP_NUMBER,
  WHATSAPP_DISPLAY,
  adminEmail,
  buildEmailHtml,
  codeBox,
  detailTable,
  emailButton,
  escapeHtml,
  formatAudience,
  formatCurrency,
  formatDate,
  formatOrderPlan,
  formatPlan,
  getSiteUrl,
  langOf,
  noteBox,
  notifyTelegram,
  orderRef,
  paragraph,
  planName,
  renderEmail,
  sendEmail,
  stepsBox,
  trackingUrl,
  whatsappUrl
};
