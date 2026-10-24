// Every email a customer can receive, in FR / EN / ES / DE.
// Each builder returns { subject, html, text } or null when there is nothing to say.

const {
  formatCurrency,
  formatDate,
  formatOrderPlan,
  getSiteUrl,
  langOf,
  orderRef,
  renderEmail,
  trackingUrl,
  whatsappUrl
} = require('./_email');
const { isPaid } = require('./_payment');

const HOURS = {
  fr: 'lundi au vendredi 9 h à 20 h, samedi 10 h à 18 h',
  en: 'Monday to Friday 9am to 8pm, Saturday 10am to 6pm, Paris time',
  es: 'de lunes a viernes de 9:00 a 20:00 y sábados de 10:00 a 18:00, hora de París',
  de: 'Montag bis Freitag 9 bis 20 Uhr, Samstag 10 bis 18 Uhr, Pariser Zeit'
};

const L = {
  fr: {
    hello: 'Bonjour,',
    offer: 'Offre',
    account: 'Compte LinkedIn',
    amount: 'Montant',
    amountDue: 'Montant à régler',
    amountPaid: 'Montant réglé',
    afterActivation: 'à régler après activation',
    discount: 'Réduction',
    order: 'Commande',
    activatedOn: 'Activé le',
    validUntil: "Valable jusqu'au",
    paidOn: 'Réglé le',
    method: 'Moyen de paiement',
    refundedOn: 'Remboursé le',
    track: 'Suivre ma commande',
    trackLine: 'Suivre votre commande :',
    codeTitle: 'Code de vérification LinkedIn',
    codeText: 'Au moment de la connexion, LinkedIn peut vous envoyer un code par e-mail ou par SMS. Si c\'est le cas, envoyez-le-nous sur WhatsApp : nous en avons besoin pour terminer.',
    referralLabel: 'Votre code de parrainage',
    referralCaption: 'Une personne qui commande avec ce code paie 10 € de moins. Vous recevez 10 € dès que sa commande est activée.'
  },
  en: {
    hello: 'Hello,',
    offer: 'Offer',
    account: 'LinkedIn account',
    amount: 'Amount',
    amountDue: 'Amount due',
    amountPaid: 'Amount paid',
    afterActivation: 'payable after activation',
    discount: 'Discount',
    order: 'Order',
    activatedOn: 'Activated on',
    validUntil: 'Valid until',
    paidOn: 'Paid on',
    method: 'Payment method',
    refundedOn: 'Refunded on',
    track: 'Track my order',
    trackLine: 'Track your order:',
    codeTitle: 'LinkedIn verification code',
    codeText: 'When we sign in, LinkedIn may send you a code by email or text message. If it does, send it to us on WhatsApp: we need it to finish.',
    referralLabel: 'Your referral code',
    referralCaption: 'Anyone who orders with this code pays €10 less. You get €10 as soon as their order is activated.'
  },
  es: {
    hello: 'Hola:',
    offer: 'Oferta',
    account: 'Cuenta de LinkedIn',
    amount: 'Importe',
    amountDue: 'Importe a pagar',
    amountPaid: 'Importe pagado',
    afterActivation: 'a pagar tras la activación',
    discount: 'Descuento',
    order: 'Pedido',
    activatedOn: 'Activado el',
    validUntil: 'Válido hasta el',
    paidOn: 'Pagado el',
    method: 'Medio de pago',
    refundedOn: 'Reembolsado el',
    track: 'Seguir mi pedido',
    trackLine: 'Seguir tu pedido:',
    codeTitle: 'Código de verificación de LinkedIn',
    codeText: 'Al iniciar sesión, LinkedIn puede enviarte un código por correo o por SMS. Si ocurre, envíanoslo por WhatsApp: lo necesitamos para terminar.',
    referralLabel: 'Tu código de recomendación',
    referralCaption: 'Quien pida con este código paga 10 € menos. Tú recibes 10 € en cuanto se active su pedido.'
  },
  de: {
    hello: 'Guten Tag,',
    offer: 'Angebot',
    account: 'LinkedIn-Konto',
    amount: 'Betrag',
    amountDue: 'Offener Betrag',
    amountPaid: 'Bezahlter Betrag',
    afterActivation: 'zahlbar nach der Aktivierung',
    discount: 'Rabatt',
    order: 'Bestellung',
    activatedOn: 'Aktiviert am',
    validUntil: 'Gültig bis',
    paidOn: 'Bezahlt am',
    method: 'Zahlungsart',
    refundedOn: 'Erstattet am',
    track: 'Bestellung verfolgen',
    trackLine: 'Bestellung verfolgen:',
    codeTitle: 'LinkedIn-Bestätigungscode',
    codeText: 'Bei der Anmeldung kann LinkedIn Ihnen einen Code per E-Mail oder SMS senden. Schicken Sie ihn uns dann bitte auf WhatsApp, wir brauchen ihn für den Abschluss.',
    referralLabel: 'Ihr Empfehlungscode',
    referralCaption: 'Wer mit diesem Code bestellt, zahlt 10 € weniger. Sie erhalten 10 €, sobald diese Bestellung aktiviert ist.'
  }
};

function ctx(order) {
  const lang = langOf(order.language);
  return {
    lang,
    l: L[lang],
    ref: orderRef(order),
    plan: formatOrderPlan(order, lang),
    amount: formatCurrency(order.amount, order.currency || 'EUR', lang),
    email: order.linkedinEmail || order.customerEmail || ''
  };
}

// Greeting on its own line. German keeps a lowercase first word after the comma.
function greet(c, text) {
  const body = c.lang === 'de' ? text : text.charAt(0).toUpperCase() + text.slice(1);
  return [{ type: 'p', text: c.l.hello }, { type: 'p', text: body }];
}

function isStudent(order) {
  return /etudiant|étudiant|student/i.test(`${order.audience || ''} ${order.plan || ''}`);
}

function discountRow(order, c) {
  const total = (order.discounts || []).reduce((sum, d) => sum + Number(d.amount || 0), 0);
  if (!total) return null;
  const codes = (order.discounts || []).map(d => d.code).filter(Boolean).join(', ');
  return { label: c.l.discount, value: `-${formatCurrency(total, order.currency || 'EUR', c.lang)}${codes ? ` (${codes})` : ''}` };
}

// WhatsApp message the customer sends us, prefilled.
function waText(order, kind) {
  const c = ctx(order);
  const texts = {
    confirm: {
      fr: `Bonjour, je viens de passer la commande ${c.ref} (${c.plan}, ${c.amount}).`,
      en: `Hello, I have just placed order ${c.ref} (${c.plan}, ${c.amount}).`,
      es: `Hola, acabo de hacer el pedido ${c.ref} (${c.plan}, ${c.amount}).`,
      de: `Guten Tag, ich habe gerade die Bestellung ${c.ref} aufgegeben (${c.plan}, ${c.amount}).`
    },
    pay: {
      fr: `Bonjour, Premium est actif sur mon compte (commande ${c.ref}). Je souhaite régler les ${c.amount}.`,
      en: `Hello, Premium is live on my account (order ${c.ref}). I would like to pay the ${c.amount}.`,
      es: `Hola, Premium ya está activo en mi cuenta (pedido ${c.ref}). Quiero pagar los ${c.amount}.`,
      de: `Guten Tag, Premium ist auf meinem Konto aktiv (Bestellung ${c.ref}). Ich möchte die ${c.amount} bezahlen.`
    },
    help: {
      fr: `Bonjour, j'ai une question sur ma commande ${c.ref}.`,
      en: `Hello, I have a question about my order ${c.ref}.`,
      es: `Hola, tengo una pregunta sobre mi pedido ${c.ref}.`,
      de: `Guten Tag, ich habe eine Frage zu meiner Bestellung ${c.ref}.`
    }
  };
  return texts[kind][c.lang];
}

function build(order, parts) {
  const c = ctx(order);
  const rendered = renderEmail({
    lang: c.lang,
    title: parts.title,
    preheader: parts.preheader,
    reference: c.ref,
    blocks: parts.blocks
  });
  return { subject: parts.subject, html: rendered.html, text: rendered.text };
}

// 1. Order placed on the site.
function orderReceived(order) {
  const c = ctx(order);
  const t = {
    fr: {
      subject: `Commande ${c.ref} reçue`,
      preheader: 'Rien à payer maintenant. Vous réglez une fois Premium actif.',
      title: 'Votre commande est enregistrée',
      intro: 'merci pour votre commande. Rien n\'est à payer pour l\'instant : vous réglez une fois LinkedIn Premium actif sur votre compte.',
      stepsTitle: 'La suite',
      steps: [
        'Nous vous écrivons sur WhatsApp et vous envoyons par e-mail un lien sécurisé.',
        'Vous transmettez votre mot de passe LinkedIn par ce lien. Premium est actif 5 à 30 minutes plus tard, pendant nos horaires.',
        'Vous vérifiez que Premium est bien actif, puis vous réglez sur WhatsApp.'
      ],
      studentTitle: 'Tarif étudiant',
      student: 'Un justificatif peut vous être demandé : carte étudiante ou attestation de diplôme récente. Gardez-le sous la main, cela évite d\'attendre.',
      wa: 'Confirmer sur WhatsApp'
    },
    en: {
      subject: `Order ${c.ref} received`,
      preheader: 'Nothing to pay now. You pay once Premium is live.',
      title: 'Your order is in',
      intro: 'thank you for your order. There is nothing to pay yet: you pay once LinkedIn Premium is live on your account.',
      stepsTitle: 'What happens next',
      steps: [
        'We message you on WhatsApp and email you a secure link.',
        'You submit your LinkedIn password through that link. Premium is live 5 to 30 minutes later, during our opening hours.',
        'You check that Premium is live, then pay on WhatsApp.'
      ],
      studentTitle: 'Student price',
      student: 'We may ask for proof: a student card or a recent degree certificate. Having it ready saves time.',
      wa: 'Confirm on WhatsApp'
    },
    es: {
      subject: `Pedido ${c.ref} recibido`,
      preheader: 'No pagas nada ahora. Pagas cuando Premium esté activo.',
      title: 'Tu pedido está registrado',
      intro: 'gracias por tu pedido. Por ahora no tienes que pagar nada: pagas cuando LinkedIn Premium esté activo en tu cuenta.',
      stepsTitle: 'Próximos pasos',
      steps: [
        'Te escribimos por WhatsApp y te enviamos por correo un enlace seguro.',
        'Envías tu contraseña de LinkedIn a través de ese enlace. Premium queda activo entre 5 y 30 minutos después, en nuestro horario.',
        'Compruebas que Premium está activo y pagas por WhatsApp.'
      ],
      studentTitle: 'Precio para estudiantes',
      student: 'Podemos pedirte un justificante: carné de estudiante o un certificado de título reciente. Tenerlo a mano te ahorra tiempo.',
      wa: 'Confirmar por WhatsApp'
    },
    de: {
      subject: `Bestellung ${c.ref} eingegangen`,
      preheader: 'Jetzt ist nichts zu zahlen. Sie zahlen, sobald Premium aktiv ist.',
      title: 'Ihre Bestellung ist eingegangen',
      intro: 'vielen Dank für Ihre Bestellung. Zu zahlen ist noch nichts: Sie zahlen erst, wenn LinkedIn Premium auf Ihrem Konto aktiv ist.',
      stepsTitle: 'So geht es weiter',
      steps: [
        'Wir schreiben Ihnen auf WhatsApp und senden Ihnen per E-Mail einen sicheren Link.',
        'Über diesen Link übermitteln Sie Ihr LinkedIn-Passwort. Premium ist 5 bis 30 Minuten später aktiv, während unserer Öffnungszeiten.',
        'Sie prüfen, ob Premium aktiv ist, und zahlen dann per WhatsApp.'
      ],
      studentTitle: 'Studierendenpreis',
      student: 'Wir können einen Nachweis anfordern: Studierendenausweis oder ein aktuelles Abschlusszeugnis. Halten Sie ihn bereit, das spart Zeit.',
      wa: 'Auf WhatsApp bestätigen'
    }
  }[c.lang];

  return build(order, {
    subject: t.subject,
    preheader: t.preheader,
    title: t.title,
    blocks: [
      ...greet(c, t.intro),
      { type: 'details', rows: [
        { label: c.l.offer, value: c.plan },
        { label: c.l.account, value: order.linkedinEmail },
        discountRow(order, c),
        { label: c.l.amount, value: `${c.amount}, ${c.l.afterActivation}` },
        { label: c.l.order, value: c.ref, mono: true }
      ] },
      { type: 'steps', title: t.stepsTitle, items: t.steps },
      isStudent(order) ? { type: 'note', title: t.studentTitle, text: t.student, tone: 'highlight' } : null,
      { type: 'button', label: t.wa, href: whatsappUrl(waText(order, 'confirm')), variant: 'whatsapp' },
      { type: 'link', label: c.l.trackLine, href: trackingUrl(order) }
    ]
  });
}

// 2. Secure link to submit the LinkedIn password.
function credentialLink(order, link, expiresAt) {
  const c = ctx(order);
  const until = formatDate(expiresAt, c.lang);
  const t = {
    fr: {
      subject: `Commande ${c.ref} : transmettez votre mot de passe LinkedIn`,
      preheader: 'Lien sécurisé, valable 72 heures. Activation 5 à 30 minutes après réception.',
      title: 'Transmettez votre mot de passe LinkedIn',
      intro: 'pour activer Premium, nous avons besoin du mot de passe du compte LinkedIn ci-dessous. Passez par le lien sécurisé plutôt que par WhatsApp ou par e-mail.',
      linkUntil: 'Lien valable jusqu\'au',
      button: 'Transmettre mon mot de passe',
      safeTitle: 'Comment nous protégeons votre mot de passe',
      safe: 'Il est chiffré dès réception. Seule l\'équipe d\'activation peut le lire, et il est supprimé après l\'activation, au plus tard sous 7 jours. Vous pourrez le changer dès que Premium est actif.',
      timing: 'Activation : 5 à 30 minutes après réception, pendant nos horaires. Vous payez une fois Premium actif.',
      fallback: 'Si le bouton ne fonctionne pas, copiez ce lien :'
    },
    en: {
      subject: `Order ${c.ref}: send us your LinkedIn password`,
      preheader: 'Secure link, valid for 72 hours. Activation takes 5 to 30 minutes once we have it.',
      title: 'Send us your LinkedIn password',
      intro: 'to activate Premium we need the password of the LinkedIn account below. Please use the secure link rather than WhatsApp or email.',
      linkUntil: 'Link valid until',
      button: 'Send my password',
      safeTitle: 'How we protect your password',
      safe: 'It is encrypted as soon as it arrives. Only the activation team can read it, and it is deleted after activation, within 7 days at the latest. You can change it as soon as Premium is live.',
      timing: 'Activation: 5 to 30 minutes after we receive it, during our opening hours. You pay once Premium is live.',
      fallback: 'If the button does not work, copy this link:'
    },
    es: {
      subject: `Pedido ${c.ref}: envíanos tu contraseña de LinkedIn`,
      preheader: 'Enlace seguro, válido 72 horas. Activación entre 5 y 30 minutos tras recibirla.',
      title: 'Envíanos tu contraseña de LinkedIn',
      intro: 'para activar Premium necesitamos la contraseña de la cuenta de LinkedIn indicada abajo. Usa el enlace seguro en lugar de WhatsApp o del correo.',
      linkUntil: 'Enlace válido hasta el',
      button: 'Enviar mi contraseña',
      safeTitle: 'Cómo protegemos tu contraseña',
      safe: 'Se cifra en cuanto llega. Solo el equipo de activación puede leerla y se borra tras la activación, como muy tarde en 7 días. Podrás cambiarla en cuanto Premium esté activo.',
      timing: 'Activación: entre 5 y 30 minutos tras recibirla, en nuestro horario. Pagas cuando Premium esté activo.',
      fallback: 'Si el botón no funciona, copia este enlace:'
    },
    de: {
      subject: `Bestellung ${c.ref}: Ihr LinkedIn-Passwort`,
      preheader: 'Sicherer Link, 72 Stunden gültig. Aktivierung 5 bis 30 Minuten nach Eingang.',
      title: 'Übermitteln Sie Ihr LinkedIn-Passwort',
      intro: 'für die Aktivierung von Premium benötigen wir das Passwort des unten genannten LinkedIn-Kontos. Bitte nutzen Sie den sicheren Link statt WhatsApp oder E-Mail.',
      linkUntil: 'Link gültig bis',
      button: 'Passwort übermitteln',
      safeTitle: 'So schützen wir Ihr Passwort',
      safe: 'Es wird bei Eingang verschlüsselt. Nur das Aktivierungsteam kann es lesen, und es wird nach der Aktivierung gelöscht, spätestens nach 7 Tagen. Sie können es ändern, sobald Premium aktiv ist.',
      timing: 'Aktivierung: 5 bis 30 Minuten nach Eingang, während unserer Öffnungszeiten. Sie zahlen, sobald Premium aktiv ist.',
      fallback: 'Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link:'
    }
  }[c.lang];

  return build(order, {
    subject: t.subject,
    preheader: t.preheader,
    title: t.title,
    blocks: [
      ...greet(c, t.intro),
      { type: 'details', rows: [
        { label: c.l.account, value: order.linkedinEmail },
        { label: c.l.offer, value: c.plan },
        { label: t.linkUntil, value: until }
      ] },
      { type: 'button', label: t.button, href: link },
      { type: 'note', title: t.safeTitle, text: t.safe },
      { type: 'note', title: c.l.codeTitle, text: c.l.codeText, tone: 'highlight' },
      { type: 'p', text: t.timing },
      { type: 'link', label: t.fallback, href: link }
    ]
  });
}

// 3. Activation started, either because the password just arrived or because the team set it by hand.
function activationStarted(order, opts = {}) {
  const c = ctx(order);
  const t = {
    fr: {
      subject: `Commande ${c.ref} : activation en cours`,
      preheader: 'Premium sera actif dans 5 à 30 minutes, pendant nos horaires.',
      title: 'Activation en cours',
      received: 'nous avons bien reçu votre mot de passe et lancé l\'activation de LinkedIn Premium.',
      manual: 'nous lançons l\'activation de LinkedIn Premium sur votre compte.',
      timing: `Comptez 5 à 30 minutes pendant nos horaires (${HOURS.fr}). En dehors, nous la faisons dès la réouverture.`,
      next: 'Vous recevrez un e-mail dès que Premium est actif.'
    },
    en: {
      subject: `Order ${c.ref}: activation in progress`,
      preheader: 'Premium will be live in 5 to 30 minutes, during our opening hours.',
      title: 'Activation in progress',
      received: 'we have received your password and started activating LinkedIn Premium.',
      manual: 'we are starting the LinkedIn Premium activation on your account.',
      timing: `It takes 5 to 30 minutes during our opening hours (${HOURS.en}). Outside those hours, we do it as soon as we reopen.`,
      next: 'We will email you as soon as Premium is live.'
    },
    es: {
      subject: `Pedido ${c.ref}: activación en curso`,
      preheader: 'Premium estará activo en 5 a 30 minutos, en nuestro horario.',
      title: 'Activación en curso',
      received: 'hemos recibido tu contraseña y hemos empezado a activar LinkedIn Premium.',
      manual: 'empezamos la activación de LinkedIn Premium en tu cuenta.',
      timing: `Tarda entre 5 y 30 minutos en nuestro horario (${HOURS.es}). Fuera de ese horario, lo hacemos en cuanto volvemos a abrir.`,
      next: 'Te escribiremos en cuanto Premium esté activo.'
    },
    de: {
      subject: `Bestellung ${c.ref}: Aktivierung läuft`,
      preheader: 'Premium ist in 5 bis 30 Minuten aktiv, während unserer Öffnungszeiten.',
      title: 'Die Aktivierung läuft',
      received: 'wir haben Ihr Passwort erhalten und die Aktivierung von LinkedIn Premium gestartet.',
      manual: 'wir starten jetzt die Aktivierung von LinkedIn Premium auf Ihrem Konto.',
      timing: `Sie dauert 5 bis 30 Minuten während unserer Öffnungszeiten (${HOURS.de}). Außerhalb dieser Zeiten erledigen wir sie, sobald wir wieder erreichbar sind.`,
      next: 'Sobald Premium aktiv ist, erhalten Sie eine E-Mail.'
    }
  }[c.lang];

  return build(order, {
    subject: t.subject,
    preheader: t.preheader,
    title: t.title,
    blocks: [
      ...greet(c, `${opts.credentialsReceived ? t.received : t.manual} ${t.timing}`),
      { type: 'note', title: c.l.codeTitle, text: c.l.codeText, tone: 'highlight' },
      { type: 'details', rows: [
        { label: c.l.offer, value: c.plan },
        { label: c.l.account, value: order.linkedinEmail },
        isPaid(order) ? null : { label: c.l.amount, value: `${c.amount}, ${c.l.afterActivation}` }
      ] },
      { type: 'p', text: t.next },
      { type: 'button', label: c.l.track, href: trackingUrl(order), variant: 'ghost' }
    ]
  });
}

// 4. Premium is live. Asks for payment unless it is already recorded.
function activated(order) {
  const c = ctx(order);
  const paid = isPaid(order);
  const t = {
    fr: {
      subject: `Commande ${c.ref} : Premium est actif`,
      preheaderDue: `Vérifiez sur LinkedIn, puis réglez ${c.amount} sur WhatsApp.`,
      preheaderPaid: 'Vérifiez sur LinkedIn. Votre paiement est déjà enregistré.',
      title: 'LinkedIn Premium est actif',
      intro: `LinkedIn Premium est maintenant actif sur votre compte ${c.email}. Connectez-vous à LinkedIn pour le vérifier : les fonctionnalités Premium sont disponibles dès maintenant.`,
      pay: 'Le règlement se fait maintenant sur WhatsApp. Écrivez-nous avec le bouton ci-dessous, nous vous indiquons les moyens de paiement disponibles.',
      payButton: 'Régler sur WhatsApp',
      paid: `Votre paiement de ${c.amount} est déjà enregistré, vous n'avez rien d'autre à faire.`,
      password: 'Votre mot de passe a été supprimé de nos serveurs. Vous pouvez le changer dès maintenant si vous le souhaitez.'
    },
    en: {
      subject: `Order ${c.ref}: Premium is live`,
      preheaderDue: `Check on LinkedIn, then pay ${c.amount} on WhatsApp.`,
      preheaderPaid: 'Check on LinkedIn. Your payment is already recorded.',
      title: 'LinkedIn Premium is live',
      intro: `LinkedIn Premium is now live on your account ${c.email}. Sign in to LinkedIn to check: the Premium features are available right away.`,
      pay: 'Payment now happens on WhatsApp. Message us with the button below and we will send you the available payment methods.',
      payButton: 'Pay on WhatsApp',
      paid: `Your payment of ${c.amount} is already recorded. There is nothing else to do.`,
      password: 'Your password has been deleted from our servers. You can change it now if you like.'
    },
    es: {
      subject: `Pedido ${c.ref}: Premium está activo`,
      preheaderDue: `Compruébalo en LinkedIn y paga ${c.amount} por WhatsApp.`,
      preheaderPaid: 'Compruébalo en LinkedIn. Tu pago ya está registrado.',
      title: 'LinkedIn Premium está activo',
      intro: `LinkedIn Premium ya está activo en tu cuenta ${c.email}. Inicia sesión en LinkedIn para comprobarlo: las funciones Premium están disponibles desde ahora.`,
      pay: 'El pago se hace ahora por WhatsApp. Escríbenos con el botón de abajo y te indicamos los medios de pago disponibles.',
      payButton: 'Pagar por WhatsApp',
      paid: `Tu pago de ${c.amount} ya está registrado. No tienes que hacer nada más.`,
      password: 'Hemos borrado tu contraseña de nuestros servidores. Puedes cambiarla ahora si lo deseas.'
    },
    de: {
      subject: `Bestellung ${c.ref}: Premium ist aktiv`,
      preheaderDue: `Prüfen Sie es auf LinkedIn und zahlen Sie dann ${c.amount} per WhatsApp.`,
      preheaderPaid: 'Prüfen Sie es auf LinkedIn. Ihre Zahlung ist bereits verbucht.',
      title: 'LinkedIn Premium ist aktiv',
      intro: `LinkedIn Premium ist jetzt auf Ihrem Konto ${c.email} aktiv. Melden Sie sich bei LinkedIn an, um es zu prüfen: Die Premium-Funktionen stehen ab sofort zur Verfügung.`,
      pay: 'Die Zahlung erfolgt jetzt per WhatsApp. Schreiben Sie uns über die Schaltfläche unten, wir nennen Ihnen die verfügbaren Zahlungsmöglichkeiten.',
      payButton: 'Per WhatsApp bezahlen',
      paid: `Ihre Zahlung über ${c.amount} ist bereits verbucht. Sie müssen nichts weiter tun.`,
      password: 'Ihr Passwort wurde von unseren Servern gelöscht. Sie können es jetzt ändern, wenn Sie möchten.'
    }
  }[c.lang];

  return build(order, {
    subject: t.subject,
    preheader: paid ? t.preheaderPaid : t.preheaderDue,
    title: t.title,
    blocks: [
      ...greet(c, t.intro),
      { type: 'details', rows: [
        { label: c.l.offer, value: c.plan },
        { label: c.l.activatedOn, value: formatDate(order.activatedAt, c.lang, false) },
        { label: c.l.validUntil, value: formatDate(order.expiresAt, c.lang, false) },
        { label: paid ? c.l.amountPaid : c.l.amountDue, value: c.amount }
      ] },
      { type: 'p', text: paid ? t.paid : t.pay },
      paid ? null : { type: 'button', label: t.payButton, href: whatsappUrl(waText(order, 'pay')), variant: 'whatsapp' },
      { type: 'note', text: t.password },
      order.referralCode ? { type: 'code', label: c.l.referralLabel, code: order.referralCode, caption: c.l.referralCaption } : null,
      { type: 'link', label: c.l.trackLine, href: trackingUrl(order) }
    ]
  });
}

// 5. Payment recorded by the team: this is the customer's receipt.
function paymentReceived(order) {
  const c = ctx(order);
  const t = {
    fr: { subject: `Reçu de paiement, commande ${c.ref}`, preheader: `Paiement de ${c.amount} reçu. Merci.`, title: 'Paiement reçu, merci', intro: 'nous avons bien reçu votre paiement. Votre commande est soldée.', keep: 'Gardez cet e-mail, il vous sert de reçu.' },
    en: { subject: `Payment receipt, order ${c.ref}`, preheader: `Payment of ${c.amount} received. Thank you.`, title: 'Payment received, thank you', intro: 'we have received your payment. Your order is fully paid.', keep: 'Keep this email as your receipt.' },
    es: { subject: `Recibo de pago, pedido ${c.ref}`, preheader: `Pago de ${c.amount} recibido. Gracias.`, title: 'Pago recibido, gracias', intro: 'hemos recibido tu pago. Tu pedido está pagado por completo.', keep: 'Guarda este correo como recibo.' },
    de: { subject: `Zahlungsbestätigung, Bestellung ${c.ref}`, preheader: `Zahlung über ${c.amount} erhalten. Vielen Dank.`, title: 'Zahlung erhalten, vielen Dank', intro: 'wir haben Ihre Zahlung erhalten. Ihre Bestellung ist vollständig bezahlt.', keep: 'Bewahren Sie diese E-Mail als Beleg auf.' }
  }[c.lang];

  return build(order, {
    subject: t.subject,
    preheader: t.preheader,
    title: t.title,
    blocks: [
      ...greet(c, t.intro),
      { type: 'details', rows: [
        { label: c.l.order, value: c.ref, mono: true },
        { label: c.l.offer, value: c.plan },
        { label: c.l.account, value: order.linkedinEmail },
        { label: c.l.amountPaid, value: c.amount },
        { label: c.l.paidOn, value: formatDate(order.paidAt, c.lang) },
        { label: c.l.method, value: order.paymentMethod },
        { label: c.l.validUntil, value: formatDate(order.expiresAt, c.lang, false) }
      ] },
      { type: 'p', text: t.keep, small: true },
      order.referralCode ? { type: 'code', label: c.l.referralLabel, code: order.referralCode, caption: c.l.referralCaption } : null
    ]
  });
}

// 6. Reminder sent from the dashboard. What it says depends on where the order is stuck.
function reminder(order) {
  const c = ctx(order);
  if (order.status === 'done' && !isPaid(order)) {
    const since = formatDate(order.activatedAt || order.updatedAt, c.lang, false);
    const t = {
      fr: { subject: `Rappel : règlement de la commande ${c.ref}`, title: 'Votre règlement est en attente', a: `LinkedIn Premium est actif sur votre compte depuis le ${since}. Le règlement de ${c.amount} n'est pas encore enregistré de notre côté.`, b: 'Vous pouvez régler sur WhatsApp en quelques minutes. Si vous avez déjà payé, répondez à cet e-mail avec la preuve de paiement et nous mettons votre commande à jour.', button: 'Régler sur WhatsApp' },
      en: { subject: `Reminder: payment for order ${c.ref}`, title: 'Your payment is pending', a: `LinkedIn Premium has been live on your account since ${since}. We have not yet recorded the payment of ${c.amount}.`, b: 'You can pay on WhatsApp in a few minutes. If you have already paid, reply to this email with the proof of payment and we will update your order.', button: 'Pay on WhatsApp' },
      es: { subject: `Recordatorio: pago del pedido ${c.ref}`, title: 'Tu pago está pendiente', a: `LinkedIn Premium está activo en tu cuenta desde el ${since}. Todavía no hemos registrado el pago de ${c.amount}.`, b: 'Puedes pagar por WhatsApp en unos minutos. Si ya has pagado, responde a este correo con el comprobante y actualizamos tu pedido.', button: 'Pagar por WhatsApp' },
      de: { subject: `Erinnerung: Zahlung für Bestellung ${c.ref}`, title: 'Ihre Zahlung steht noch aus', a: `LinkedIn Premium ist seit dem ${since} auf Ihrem Konto aktiv. Die Zahlung über ${c.amount} ist bei uns noch nicht eingegangen.`, b: 'Sie können in wenigen Minuten per WhatsApp bezahlen. Falls Sie bereits bezahlt haben, antworten Sie bitte mit dem Zahlungsnachweis auf diese E-Mail, dann aktualisieren wir Ihre Bestellung.', button: 'Per WhatsApp bezahlen' }
    }[c.lang];
    return build(order, {
      subject: t.subject,
      preheader: t.a,
      title: t.title,
      blocks: [
        ...greet(c, t.a),
        { type: 'p', text: t.b },
        { type: 'button', label: t.button, href: whatsappUrl(waText(order, 'pay')), variant: 'whatsapp' },
        { type: 'details', rows: [
          { label: c.l.offer, value: c.plan },
          { label: c.l.amountDue, value: c.amount },
          { label: c.l.order, value: c.ref, mono: true }
        ] }
      ]
    });
  }

  if (order.status === 'pending' || order.status === 'pending_payment') {
    const t = {
      fr: { subject: `Commande ${c.ref} : il nous manque votre réponse`, title: 'Finalisons votre commande', a: `votre commande ${c.ref} est enregistrée, mais nous n'avons pas encore pu échanger avec vous sur WhatsApp. Écrivez-nous et nous vous envoyons le lien sécurisé pour l'activation.`, b: 'Vous ne payez qu\'une fois Premium actif.', button: 'Écrire sur WhatsApp' },
      en: { subject: `Order ${c.ref}: we are waiting to hear from you`, title: "Let's finish your order", a: `your order ${c.ref} is registered, but we have not been able to reach you on WhatsApp yet. Message us and we will send you the secure link for the activation.`, b: 'You only pay once Premium is live.', button: 'Message us on WhatsApp' },
      es: { subject: `Pedido ${c.ref}: esperamos tu respuesta`, title: 'Terminemos tu pedido', a: `tu pedido ${c.ref} está registrado, pero todavía no hemos podido hablar contigo por WhatsApp. Escríbenos y te enviamos el enlace seguro para la activación.`, b: 'Solo pagas cuando Premium esté activo.', button: 'Escribir por WhatsApp' },
      de: { subject: `Bestellung ${c.ref}: Wir warten auf Ihre Antwort`, title: 'Schließen wir Ihre Bestellung ab', a: `Ihre Bestellung ${c.ref} ist eingegangen, aber wir konnten Sie auf WhatsApp noch nicht erreichen. Schreiben Sie uns, dann senden wir Ihnen den sicheren Link für die Aktivierung.`, b: 'Sie zahlen erst, wenn Premium aktiv ist.', button: 'Auf WhatsApp schreiben' }
    }[c.lang];
    return build(order, {
      subject: t.subject,
      preheader: t.b,
      title: t.title,
      blocks: [
        ...greet(c, t.a),
        { type: 'p', text: t.b },
        { type: 'button', label: t.button, href: whatsappUrl(waText(order, 'confirm')), variant: 'whatsapp' },
        { type: 'details', rows: [
          { label: c.l.offer, value: c.plan },
          { label: c.l.amount, value: `${c.amount}, ${c.l.afterActivation}` },
          { label: c.l.order, value: c.ref, mono: true }
        ] }
      ]
    });
  }

  return null;
}

// 7. Refund of a paid order, or cancellation of an unpaid one.
function refunded(order, opts = {}) {
  const c = ctx(order);
  if (opts.cancelled) {
    const t = {
      fr: { subject: `Commande ${c.ref} annulée`, title: 'Commande annulée', a: `votre commande ${c.ref} est annulée. Vous n'avez rien payé, il n'y a rien à faire de votre côté.`, b: 'Si c\'est une erreur, répondez à cet e-mail ou écrivez-nous sur WhatsApp.' },
      en: { subject: `Order ${c.ref} cancelled`, title: 'Order cancelled', a: `your order ${c.ref} has been cancelled. You have not paid anything, so there is nothing for you to do.`, b: 'If this is a mistake, reply to this email or message us on WhatsApp.' },
      es: { subject: `Pedido ${c.ref} cancelado`, title: 'Pedido cancelado', a: `tu pedido ${c.ref} se ha cancelado. No has pagado nada, así que no tienes que hacer nada.`, b: 'Si es un error, responde a este correo o escríbenos por WhatsApp.' },
      de: { subject: `Bestellung ${c.ref} storniert`, title: 'Bestellung storniert', a: `Ihre Bestellung ${c.ref} wurde storniert. Sie haben nichts bezahlt und müssen nichts weiter tun.`, b: 'Falls das ein Irrtum ist, antworten Sie auf diese E-Mail oder schreiben Sie uns auf WhatsApp.' }
    }[c.lang];
    return build(order, {
      subject: t.subject,
      preheader: t.a,
      title: t.title,
      blocks: [
        ...greet(c, t.a),
        { type: 'p', text: t.b },
        { type: 'details', rows: [{ label: c.l.offer, value: c.plan }, { label: c.l.order, value: c.ref, mono: true }] }
      ]
    });
  }

  const t = {
    fr: { subject: `Commande ${c.ref} : remboursement effectué`, title: 'Remboursement effectué', a: `nous avons remboursé votre commande ${c.ref}. Le montant vous revient par le moyen utilisé pour le paiement : selon ce moyen, il arrive en quelques minutes ou en quelques jours ouvrés.`, b: 'S\'il n\'est pas arrivé d\'ici 5 jours ouvrés, répondez à cet e-mail.', amount: 'Montant remboursé' },
    en: { subject: `Order ${c.ref}: refund issued`, title: 'Refund issued', a: `we have refunded your order ${c.ref}. The money goes back through the method you paid with, so it arrives within minutes or a few business days depending on that method.`, b: 'If it has not arrived within 5 business days, reply to this email.', amount: 'Amount refunded' },
    es: { subject: `Pedido ${c.ref}: reembolso realizado`, title: 'Reembolso realizado', a: `hemos reembolsado tu pedido ${c.ref}. El importe vuelve por el medio con el que pagaste y, según ese medio, llega en unos minutos o en unos días hábiles.`, b: 'Si no ha llegado en 5 días hábiles, responde a este correo.', amount: 'Importe reembolsado' },
    de: { subject: `Bestellung ${c.ref}: Erstattung veranlasst`, title: 'Erstattung veranlasst', a: `wir haben Ihre Bestellung ${c.ref} erstattet. Der Betrag geht über das Zahlungsmittel zurück, mit dem Sie bezahlt haben, und kommt je nach Zahlungsmittel in wenigen Minuten oder einigen Werktagen an.`, b: 'Falls er nach 5 Werktagen nicht eingegangen ist, antworten Sie bitte auf diese E-Mail.', amount: 'Erstatteter Betrag' }
  }[c.lang];
  return build(order, {
    subject: t.subject,
    preheader: t.a,
    title: t.title,
    blocks: [
      ...greet(c, t.a),
      { type: 'details', rows: [
        { label: c.l.offer, value: c.plan },
        { label: t.amount, value: c.amount },
        { label: c.l.refundedOn, value: formatDate(order.refundedAt || new Date().toISOString(), c.lang, false) },
        { label: c.l.order, value: c.ref, mono: true }
      ] },
      { type: 'p', text: t.b }
    ]
  });
}

// 8. Sent about 30 days before the end of the 12 months.
function renewal(order) {
  const c = ctx(order);
  const end = formatDate(order.expiresAt, c.lang, false);
  const t = {
    fr: { subject: `Votre LinkedIn Premium se termine le ${end}`, title: 'Votre Premium arrive à échéance', a: `l'abonnement ${c.plan} activé sur votre compte ${c.email} se termine le ${end}. Pour le garder sans interruption, vous pouvez le renouveler dès maintenant.`, b: 'Le renouvellement se passe comme la première fois : vous ne payez qu\'une fois Premium actif.', button: 'Renouveler mon Premium' },
    en: { subject: `Your LinkedIn Premium ends on ${end}`, title: 'Your Premium is ending soon', a: `the ${c.plan} subscription on your account ${c.email} ends on ${end}. To keep it without a break, you can renew now.`, b: 'Renewing works like the first time: you only pay once Premium is live.', button: 'Renew my Premium' },
    es: { subject: `Tu LinkedIn Premium termina el ${end}`, title: 'Tu Premium termina pronto', a: `la suscripción ${c.plan} de tu cuenta ${c.email} termina el ${end}. Para no perderla, puedes renovarla ya.`, b: 'La renovación funciona igual que la primera vez: solo pagas cuando Premium esté activo.', button: 'Renovar mi Premium' },
    de: { subject: `Ihr LinkedIn Premium endet am ${end}`, title: 'Ihr Premium läuft bald ab', a: `das Abonnement ${c.plan} auf Ihrem Konto ${c.email} endet am ${end}. Damit es ohne Unterbrechung weitergeht, können Sie es jetzt verlängern.`, b: 'Der Ablauf ist wie beim ersten Mal: Sie zahlen erst, wenn Premium aktiv ist.', button: 'Premium verlängern' }
  }[c.lang];
  return build(order, {
    subject: t.subject,
    preheader: t.a,
    title: t.title,
    blocks: [
      ...greet(c, t.a),
      { type: 'p', text: t.b },
      { type: 'button', label: t.button, href: `${getSiteUrl()}/#tarifs` },
      order.referralCode ? { type: 'code', label: c.l.referralLabel, code: order.referralCode, caption: c.l.referralCaption } : null
    ]
  });
}

// 9. Referral rewards, sent to the person whose code was used.
const REFERRAL_FOOTER = {
  fr: 'Vous recevez cet e-mail au sujet de votre parrainage Kareer.',
  en: 'You are receiving this email about your Kareer referrals.',
  es: 'Recibes este correo por tus recomendaciones en Kareer.',
  de: 'Sie erhalten diese E-Mail zu Ihren Kareer-Empfehlungen.'
};

function referralReward({ language, code, mode, promoCode, balance }) {
  const lang = langOf(language);
  const t = {
    fr: { subject: 'Parrainage validé : 10 € pour vous', title: 'Votre parrainage est validé', a: `Une personne a commandé avec votre code ${code} et son LinkedIn Premium est maintenant actif. Comme prévu, vous recevez 10 €.`, codeLabel: 'Votre code de réduction', codeCaption: '10 € de moins sur votre prochaine commande. Valable une fois.', offers: 'Voir les offres', balance: 'Solde disponible', transfer: 'Vous pouvez demander un virement depuis votre page de parrainage. Une demande de virement remet votre solde à zéro.', page: 'Ma page de parrainage' },
    en: { subject: 'Referral confirmed: €10 for you', title: 'Your referral is confirmed', a: `Someone ordered with your code ${code} and their LinkedIn Premium is now live. As promised, you get €10.`, codeLabel: 'Your discount code', codeCaption: '€10 off your next order. Single use.', offers: 'See the offers', balance: 'Available balance', transfer: 'You can request a bank transfer from your referral page. Requesting a transfer resets your balance to zero.', page: 'My referral page' },
    es: { subject: 'Recomendación confirmada: 10 € para ti', title: 'Tu recomendación está confirmada', a: `Alguien ha pedido con tu código ${code} y su LinkedIn Premium ya está activo. Como prometimos, recibes 10 €.`, codeLabel: 'Tu código de descuento', codeCaption: '10 € menos en tu próximo pedido. Válido una vez.', offers: 'Ver las ofertas', balance: 'Saldo disponible', transfer: 'Puedes pedir una transferencia desde tu página de recomendaciones. Al pedirla, tu saldo vuelve a cero.', page: 'Mi página de recomendaciones' },
    de: { subject: 'Empfehlung bestätigt: 10 € für Sie', title: 'Ihre Empfehlung ist bestätigt', a: `Jemand hat mit Ihrem Code ${code} bestellt, und LinkedIn Premium ist dort jetzt aktiv. Wie versprochen erhalten Sie 10 €.`, codeLabel: 'Ihr Rabattcode', codeCaption: '10 € Rabatt auf Ihre nächste Bestellung. Einmal einlösbar.', offers: 'Angebote ansehen', balance: 'Verfügbares Guthaben', transfer: 'Sie können auf Ihrer Empfehlungsseite eine Überweisung anfordern. Danach steht Ihr Guthaben wieder auf null.', page: 'Meine Empfehlungsseite' }
  }[lang];
  const blocks = [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a }
  ];
  if (mode === 'transfer') {
    blocks.push({ type: 'details', rows: [{ label: t.balance, value: formatCurrency(balance || 0, 'EUR', lang) }] });
    blocks.push({ type: 'p', text: t.transfer });
    blocks.push({ type: 'button', label: t.page, href: `${getSiteUrl()}/parrainage.html` });
  } else {
    blocks.push({ type: 'code', label: t.codeLabel, code: promoCode, caption: t.codeCaption });
    blocks.push({ type: 'button', label: t.offers, href: `${getSiteUrl()}/#tarifs` });
  }
  const rendered = renderEmail({ lang, title: t.title, preheader: t.a, blocks, footer: REFERRAL_FOOTER[lang] });
  return { subject: t.subject, html: rendered.html, text: rendered.text };
}

function maskIban(iban) {
  const clean = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (clean.length < 8) return clean ? '••••' : '';
  return `${clean.slice(0, 4)} •••• ${clean.slice(-4)}`;
}

function transferRequested({ language, amount, iban, accountName }) {
  const lang = langOf(language);
  const sum = formatCurrency(amount, 'EUR', lang);
  const t = {
    fr: { subject: 'Demande de virement reçue', title: 'Demande de virement reçue', a: `Nous avons bien reçu votre demande de virement de ${sum}. Nous la traitons sous 48 heures ouvrées et vous écrivons une fois le virement envoyé.`, amount: 'Montant', holder: 'Titulaire', warn: 'Si vous n\'êtes pas à l\'origine de cette demande, répondez tout de suite à cet e-mail.' },
    en: { subject: 'Transfer request received', title: 'Transfer request received', a: `We have received your request for a transfer of ${sum}. We process it within 2 business days and will email you once the transfer is sent.`, amount: 'Amount', holder: 'Account holder', warn: 'If you did not make this request, reply to this email right away.' },
    es: { subject: 'Solicitud de transferencia recibida', title: 'Solicitud de transferencia recibida', a: `Hemos recibido tu solicitud de transferencia de ${sum}. La tramitamos en 48 horas hábiles y te escribimos cuando la enviemos.`, amount: 'Importe', holder: 'Titular', warn: 'Si no has hecho esta solicitud, responde a este correo enseguida.' },
    de: { subject: 'Überweisungsanfrage erhalten', title: 'Überweisungsanfrage erhalten', a: `Wir haben Ihre Anfrage über eine Überweisung von ${sum} erhalten. Wir bearbeiten sie innerhalb von 2 Werktagen und schreiben Ihnen, sobald die Überweisung unterwegs ist.`, amount: 'Betrag', holder: 'Kontoinhaber', warn: 'Falls Sie diese Anfrage nicht gestellt haben, antworten Sie bitte sofort auf diese E-Mail.' }
  }[lang];
  const rendered = renderEmail({
    lang,
    title: t.title,
    preheader: t.a,
    footer: REFERRAL_FOOTER[lang],
    blocks: [
      { type: 'p', text: L[lang].hello },
      { type: 'p', text: t.a },
      { type: 'details', rows: [
        { label: t.amount, value: sum },
        { label: t.holder, value: accountName },
        { label: 'IBAN', value: maskIban(iban), mono: true }
      ] },
      { type: 'note', text: t.warn, tone: 'highlight' }
    ]
  });
  return { subject: t.subject, html: rendered.html, text: rendered.text };
}

module.exports = {
  activated,
  activationStarted,
  credentialLink,
  maskIban,
  orderReceived,
  paymentReceived,
  referralReward,
  refunded,
  reminder,
  renewal,
  transferRequested,
  waText
};
