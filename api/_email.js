// Shared email utilities — formatters + template builder

const PLAN_NAMES = {
  fr: {
    'career':    'LinkedIn Career Premium',
    'business':  'LinkedIn Business Premium',
    'sales-nav': 'LinkedIn Sales Navigator',
    'recruiter': 'LinkedIn Recruiter Lite',
    'coursera':  'Coursera Plus'
  },
  en: {
    'career':    'LinkedIn Career Premium',
    'business':  'LinkedIn Business Premium',
    'sales-nav': 'LinkedIn Sales Navigator',
    'recruiter': 'LinkedIn Recruiter Lite',
    'coursera':  'Coursera Plus'
  }
};

const AUDIENCE_NAMES = {
  fr: { student: 'Étudiant', professional: 'Professionnel', étudiant: 'Étudiant', professionnel: 'Professionnel' },
  en: { student: 'Student', professional: 'Professional' },
  es: { student: 'Estudiante', professional: 'Profesional' },
  de: { student: 'Student', professional: 'Professionell' }
};

/**
 * Format plan + audience into human-readable string
 * e.g. formatPlan('career', 'student', 'fr') → 'LinkedIn Career Premium · Étudiant'
 */
function formatPlan(plan, audience, lang) {
  lang = lang || 'fr';
  // Handle legacy "career-student" style plans
  const basePlan = (plan || '').replace(/-(student|pro|professional)$/, '');
  const names = PLAN_NAMES[lang] || PLAN_NAMES.fr;
  const planLabel = names[basePlan] || names[plan] || plan;

  const audienceMap = AUDIENCE_NAMES[lang] || AUDIENCE_NAMES.fr;
  const audienceKey = (audience || '').toLowerCase();
  const audienceLabel = audienceMap[audienceKey];

  return audienceLabel ? `${planLabel} · ${audienceLabel}` : planLabel;
}

function getSiteUrl() {
  return process.env.SITE_URL || 'https://www.kareer.pro';
}

/**
 * Build a full, anti-spam-friendly HTML email
 * Uses table-based layout for maximum email client compatibility
 */
function buildEmailHtml({ siteUrl, headerColor, title, preheader, content, footer }) {
  const color = headerColor || '#1565C0';
  const pre = preheader || '';
  const foot = footer || `Vous recevez cet email car vous avez passé une commande sur kareer.pro.`;

  return `<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <style>
    @media only screen and (max-width:600px){
      .email-wrap{width:100%!important;border-radius:0!important}
      .email-body{padding:24px 20px!important}
      .email-header{padding:28px 20px!important}
      .btn-cta{width:100%!important;display:block!important;text-align:center!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <!-- Preheader (hidden) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f3f4f6">${pre}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6">
    <tr><td align="center" style="padding:32px 16px">
      <table class="email-wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

        <!-- Header -->
        <tr><td class="email-header" align="center" style="background:${color};padding:36px 32px">
          <img src="${siteUrl}/kareer-logo.png" alt="Kareer" width="52" height="52" style="display:block;margin:0 auto 12px;border-radius:10px;border:0" onerror="this.style.display='none'">
          <p style="margin:0;color:rgba(255,255,255,0.85);font-size:13px;font-weight:600;letter-spacing:2px;text-transform:uppercase">KAREER</p>
          <h1 style="margin:10px 0 0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3">${title}</h1>
        </td></tr>

        <!-- Body -->
        <tr><td class="email-body" style="padding:32px">
          ${content}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb">
          <p style="margin:0 0 6px;color:#9ca3af;font-size:12px;text-align:center;line-height:1.5">${foot}</p>
          <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center">
            <a href="${siteUrl}" style="color:#6b7280;text-decoration:none">kareer.pro</a>
            &nbsp;·&nbsp;
            <a href="mailto:contact@kareer.pro" style="color:#6b7280;text-decoration:none">contact@kareer.pro</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { formatPlan, getSiteUrl, buildEmailHtml };
