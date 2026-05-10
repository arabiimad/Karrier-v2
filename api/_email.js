// Shared email utilities: labels, escaping and a Gmail-friendly template.

const PLAN_NAMES = {
  fr: {
    'career': 'LinkedIn Career',
    'career-student': 'LinkedIn Career',
    'career-salary': 'LinkedIn Career',
    'business': 'LinkedIn Business',
    'business-student': 'LinkedIn Business',
    'business-salary': 'LinkedIn Business',
    'sales-nav': 'Sales Navigator Core',
    'recruiter': 'LinkedIn Recruiter Lite',
    'coursera': 'Coursera Plus'
  },
  en: {
    'career': 'LinkedIn Career',
    'career-student': 'LinkedIn Career',
    'career-salary': 'LinkedIn Career',
    'business': 'LinkedIn Business',
    'business-student': 'LinkedIn Business',
    'business-salary': 'LinkedIn Business',
    'sales-nav': 'Sales Navigator Core',
    'recruiter': 'LinkedIn Recruiter Lite',
    'coursera': 'Coursera Plus'
  },
  es: {
    'career': 'LinkedIn Career',
    'career-student': 'LinkedIn Career',
    'career-salary': 'LinkedIn Career',
    'business': 'LinkedIn Business',
    'business-student': 'LinkedIn Business',
    'business-salary': 'LinkedIn Business',
    'sales-nav': 'Sales Navigator Core',
    'recruiter': 'LinkedIn Recruiter Lite',
    'coursera': 'Coursera Plus'
  },
  de: {
    'career': 'LinkedIn Career',
    'career-student': 'LinkedIn Career',
    'career-salary': 'LinkedIn Career',
    'business': 'LinkedIn Business',
    'business-student': 'LinkedIn Business',
    'business-salary': 'LinkedIn Business',
    'sales-nav': 'Sales Navigator Core',
    'recruiter': 'LinkedIn Recruiter Lite',
    'coursera': 'Coursera Plus'
  }
};

const AUDIENCE_NAMES = {
  fr: {
    student: 'Étudiant',
    etudiant: 'Étudiant',
    'étudiant': 'Étudiant',
    salary: 'Salarié',
    salarie: 'Salarié',
    'salarié': 'Salarié',
    professional: 'Professionnel',
    professionnel: 'Professionnel',
    'tous profils': 'Tous profils'
  },
  en: {
    student: 'Student',
    etudiant: 'Student',
    salary: 'Employee',
    salarie: 'Employee',
    professional: 'Professional',
    professionnel: 'Professional',
    'tous profils': 'All profiles'
  },
  es: {
    student: 'Estudiante',
    etudiant: 'Estudiante',
    salary: 'Empleado',
    salarie: 'Empleado',
    professional: 'Profesional',
    professionnel: 'Profesional',
    'tous profils': 'Todos los perfiles'
  },
  de: {
    student: 'Student',
    etudiant: 'Student',
    salary: 'Angestellt',
    salarie: 'Angestellt',
    professional: 'Professionell',
    professionnel: 'Professionell',
    'tous profils': 'Alle Profile'
  }
};

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

function formatAudience(audience, lang = 'fr') {
  const map = AUDIENCE_NAMES[lang] || AUDIENCE_NAMES.fr;
  const key = String(audience || '').trim().toLowerCase();
  return map[key] || audience || '';
}

function formatPlan(plan, audience, lang = 'fr') {
  const names = PLAN_NAMES[lang] || PLAN_NAMES.fr;
  const planLabel = names[plan] || names[String(plan || '').replace(/-(student|salary|pro|professional)$/, '')] || plan || 'Kareer';
  const audienceLabel = formatAudience(audience, lang);
  return audienceLabel ? `${planLabel} · ${audienceLabel}` : planLabel;
}

function formatCurrency(amount, currency = 'EUR', lang = 'fr') {
  const locale = lang === 'en' ? 'en-US' : lang === 'de' ? 'de-DE' : lang === 'es' ? 'es-ES' : 'fr-FR';
  const numeric = Number(amount || 0);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(numeric);
  } catch (e) {
    return `${numeric.toFixed(2)} ${currency}`;
  }
}

function emailButton(label, href, options = {}) {
  const color = options.color || '#1565C0';
  return `
    <div style="text-align:center;margin:28px 0">
      <a href="${escapeHtml(href)}" style="background:${color};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:9px;font-size:15px;font-weight:800;display:inline-block">${escapeHtml(label)}</a>
    </div>
  `;
}

function detailTable(rows) {
  const safeRows = rows.filter(row => row && row.value !== undefined && row.value !== null && row.value !== '');
  if (!safeRows.length) return '';

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:22px 0;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px">
      ${safeRows.map((row, index) => {
        const border = index === safeRows.length - 1 ? '' : 'border-bottom:1px solid #e5e7eb;';
        return `
          <tr>
            <td style="padding:12px 14px;color:#64748b;font-size:13px;${border}">${escapeHtml(row.label)}</td>
            <td align="right" style="padding:12px 14px;color:#111827;font-size:13px;font-weight:700;${border}">${escapeHtml(row.value)}</td>
          </tr>
        `;
      }).join('')}
    </table>
  `;
}

function stepsBox(title, steps, note) {
  return `
    <div style="background:#f0f7ff;border:1px solid #dbeafe;border-radius:10px;padding:18px;margin:24px 0">
      <h3 style="color:#1565C0;margin:0 0 12px;font-size:15px">${escapeHtml(title)}</h3>
      ${steps.map((step, index) => `
        <p style="margin:7px 0;color:#1f2937;font-size:14px;line-height:1.5">
          <strong>${index + 1}.</strong> ${escapeHtml(step)}
        </p>
      `).join('')}
      ${note ? `<p style="margin:12px 0 0;color:#64748b;font-size:13px;line-height:1.5;font-style:italic">${escapeHtml(note)}</p>` : ''}
    </div>
  `;
}

function buildEmailHtml({ siteUrl, headerColor, title, preheader, content, footer, lang = 'fr' }) {
  const url = (siteUrl || getSiteUrl()).replace(/\/$/, '');
  const color = headerColor || '#1565C0';
  const pre = preheader || '';
  const foot = footer || (lang === 'fr'
    ? 'Vous recevez cet email car vous avez passé une commande sur kareer.pro.'
    : 'You are receiving this email because you placed an order on kareer.pro.');

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(title)}</title>
  <style>
    @media only screen and (max-width:600px){
      .email-shell{width:100%!important;border-radius:0!important}
      .email-body{padding:24px 20px!important}
      .email-header{padding:30px 20px!important}
      .email-button{width:100%!important;display:block!important;text-align:center!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(pre)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;margin:0;padding:28px 12px">
    <tr>
      <td align="center">
        <table class="email-shell" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
          <tr>
            <td class="email-header" align="center" style="background:${color};padding:30px 28px">
              <img src="${url}/kareer-logo.png" width="56" height="56" alt="Kareer" style="display:block;width:56px;height:56px;border:0;margin:0 auto 14px">
              <p style="margin:0;color:rgba(255,255,255,0.82);font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">KAREER</p>
              <h1 style="margin:10px 0 0;color:#ffffff;font-size:24px;line-height:1.3;font-weight:800">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td class="email-body" style="padding:30px 32px">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e5e7eb;text-align:center">
              <p style="margin:0 0 6px;color:#64748b;font-size:12px;line-height:1.5">${escapeHtml(foot)}</p>
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5">
                <a href="${url}" style="color:#64748b;text-decoration:none">kareer.pro</a>
                &nbsp;·&nbsp;
                <a href="mailto:contact@kareer.pro" style="color:#64748b;text-decoration:none">contact@kareer.pro</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  buildEmailHtml,
  detailTable,
  emailButton,
  escapeHtml,
  formatAudience,
  formatCurrency,
  formatPlan,
  getSiteUrl,
  stepsBox
};
