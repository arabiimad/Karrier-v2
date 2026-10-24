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
    nothingDue: 'rien à régler',
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
    referralCaption: 'Une personne qui commande avec ce code paie 10 € de moins. Vous gagnez 10 € dès qu\'elle a réglé sa commande.'
  },
  en: {
    hello: 'Hello,',
    offer: 'Offer',
    account: 'LinkedIn account',
    amount: 'Amount',
    amountDue: 'Amount due',
    amountPaid: 'Amount paid',
    afterActivation: 'payable after activation',
    nothingDue: 'nothing to pay',
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
    referralCaption: 'Anyone who orders with this code pays €10 less. You earn €10 as soon as they have paid.'
  },
  es: {
    hello: 'Hola:',
    offer: 'Oferta',
    account: 'Cuenta de LinkedIn',
    amount: 'Importe',
    amountDue: 'Importe a pagar',
    amountPaid: 'Importe pagado',
    afterActivation: 'a pagar tras la activación',
    nothingDue: 'nada que pagar',
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
    referralCaption: 'Quien pida con este código paga 10 € menos. Tú ganas 10 € en cuanto haya pagado su pedido.'
  },
  de: {
    hello: 'Guten Tag,',
    offer: 'Angebot',
    account: 'LinkedIn-Konto',
    amount: 'Betrag',
    amountDue: 'Offener Betrag',
    amountPaid: 'Bezahlter Betrag',
    afterActivation: 'zahlbar nach der Aktivierung',
    nothingDue: 'nichts zu zahlen',
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
    referralCaption: 'Wer mit diesem Code bestellt, zahlt 10 € weniger. Sie verdienen 10 €, sobald die Bestellung bezahlt ist.'
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
      wa: 'Confirmer sur WhatsApp',
      freeIntro: 'merci pour votre commande. Votre code couvre tout le montant : vous n\'aurez rien à régler.',
      freeStep: 'Vous vérifiez que Premium est bien actif. Rien à régler.'
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
      wa: 'Confirm on WhatsApp',
      freeIntro: 'thank you for your order. Your code covers the full amount: there will be nothing to pay.',
      freeStep: 'You check that Premium is live. Nothing to pay.'
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
      wa: 'Confirmar por WhatsApp',
      freeIntro: 'gracias por tu pedido. Tu código cubre todo el importe: no tendrás que pagar nada.',
      freeStep: 'Compruebas que Premium está activo. Nada que pagar.'
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
      wa: 'Auf WhatsApp bestätigen',
      freeIntro: 'vielen Dank für Ihre Bestellung. Ihr Code deckt den gesamten Betrag: Sie müssen nichts zahlen.',
      freeStep: 'Sie prüfen, ob Premium aktiv ist. Nichts zu zahlen.'
    }
  }[c.lang];
  const free = Number(order.amount) === 0;

  return build(order, {
    subject: t.subject,
    preheader: t.preheader,
    title: t.title,
    blocks: [
      ...greet(c, free ? t.freeIntro : t.intro),
      { type: 'details', rows: [
        { label: c.l.offer, value: c.plan },
        { label: c.l.account, value: order.linkedinEmail },
        discountRow(order, c),
        { label: c.l.amount, value: `${c.amount}, ${free ? c.l.nothingDue : c.l.afterActivation}` },
        { label: c.l.order, value: c.ref, mono: true }
      ] },
      { type: 'steps', title: t.stepsTitle, items: free ? t.steps.slice(0, 2).concat([t.freeStep]) : t.steps },
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
      free: 'Votre commande est entièrement couverte par votre code : rien à régler.',
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
      free: 'Your order is fully covered by your code: nothing to pay.',
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
      free: 'Tu pedido está cubierto por completo por tu código: nada que pagar.',
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
      free: 'Ihre Bestellung ist vollständig durch Ihren Code gedeckt: nichts zu zahlen.',
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
        { label: Number(order.amount) === 0 ? c.l.amount : paid ? c.l.amountPaid : c.l.amountDue, value: c.amount }
      ] },
      { type: 'p', text: Number(order.amount) === 0 ? t.free : paid ? t.paid : t.pay },
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

// 9. Referral (customers) and ambassador (anyone accepted by the team) programmes.
// Both share the balance, the transfer and the balance code; the wording and the page differ.
const PROGRAMS = {
  referral: {
    path: '/parrainage',
    footer: {
      fr: 'Vous recevez cet e-mail au sujet de votre parrainage Kareer.',
      en: 'You are receiving this email about your Kareer referrals.',
      es: 'Recibes este correo por tus recomendaciones en Kareer.',
      de: 'Sie erhalten diese E-Mail zu Ihren Kareer-Empfehlungen.'
    },
    name: { fr: 'Parrainage', en: 'Referral', es: 'Recomendación', de: 'Empfehlung' },
    page: { fr: 'Mon espace parrainage', en: 'My referral page', es: 'Mi página de recomendaciones', de: 'Meine Empfehlungsseite' },
    space: { fr: 'votre espace parrainage', en: 'your referral page', es: 'tu página de recomendaciones', de: 'Ihre Empfehlungsseite' },
    balance: { fr: 'votre solde de parrainage', en: 'your referral balance', es: 'tu saldo de recomendaciones', de: 'Ihr Empfehlungsguthaben' }
  },
  ambassador: {
    path: '/ambassadeur',
    footer: {
      fr: 'Vous recevez cet e-mail au sujet de votre compte ambassadeur Kareer.',
      en: 'You are receiving this email about your Kareer ambassador account.',
      es: 'Recibes este correo por tu cuenta de embajador de Kareer.',
      de: 'Sie erhalten diese E-Mail zu Ihrem Kareer-Botschafterkonto.'
    },
    name: { fr: 'Ambassadeur', en: 'Ambassador', es: 'Embajador', de: 'Botschafter' },
    page: { fr: 'Mon espace ambassadeur', en: 'My ambassador page', es: 'Mi página de embajador', de: 'Meine Botschafterseite' },
    space: { fr: 'votre espace ambassadeur', en: 'your ambassador page', es: 'tu página de embajador', de: 'Ihre Botschafterseite' },
    balance: { fr: 'votre solde ambassadeur', en: 'your ambassador balance', es: 'tu saldo de embajador', de: 'Ihr Botschafterguthaben' }
  }
};

function programOf(program) {
  return PROGRAMS[program] || PROGRAMS.referral;
}

function programPage(program) {
  return `${getSiteUrl()}${programOf(program).path}`;
}

function buildProgramMail(program, lang, t, blocks, opts = {}) {
  const rendered = renderEmail({
    lang,
    title: t.title,
    preheader: t.a,
    blocks,
    footer: programOf(program).footer[lang],
    signature: opts.signature
  });
  return { subject: t.subject, html: rendered.html, text: rendered.text };
}

// Sent when an order placed with the code is paid.
function programReward({ program, language, code, amount, balance }) {
  const lang = langOf(language);
  const p = programOf(program);
  const sum = formatCurrency(amount || 0, 'EUR', lang);
  const t = {
    fr: { subject: `${p.name.fr} : ${sum} de plus sur votre solde`, title: `Vous avez gagné ${sum}`, a: `Une personne a commandé avec votre code ${code} et vient de régler sa commande. Votre solde augmente de ${sum}.`, balance: 'Solde disponible', use: `Vous pouvez vous le faire virer, ou l'utiliser pour payer votre propre abonnement LinkedIn Premium, depuis ${p.space.fr}.` },
    en: { subject: `${p.name.en}: ${sum} added to your balance`, title: `You earned ${sum}`, a: `Someone ordered with your code ${code} and has just paid. Your balance goes up by ${sum}.`, balance: 'Available balance', use: `You can have it transferred to you, or use it to pay for your own LinkedIn Premium subscription, from ${p.space.en}.` },
    es: { subject: `${p.name.es}: ${sum} más en tu saldo`, title: `Has ganado ${sum}`, a: `Alguien ha pedido con tu código ${code} y acaba de pagar. Tu saldo aumenta en ${sum}.`, balance: 'Saldo disponible', use: `Puedes pedir que te lo transfiramos o usarlo para pagar tu propia suscripción a LinkedIn Premium, desde ${p.space.es}.` },
    de: { subject: `${p.name.de}: ${sum} mehr Guthaben`, title: `Sie haben ${sum} verdient`, a: `Jemand hat mit Ihrem Code ${code} bestellt und gerade bezahlt. Ihr Guthaben erhöht sich um ${sum}.`, balance: 'Verfügbares Guthaben', use: `Auf ${p.space.de} können Sie sich das Guthaben überweisen lassen oder damit Ihr eigenes LinkedIn-Premium-Abo bezahlen.` }
  }[lang];
  return buildProgramMail(program, lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    { type: 'details', rows: [{ label: t.balance, value: formatCurrency(balance || 0, 'EUR', lang) }] },
    { type: 'p', text: t.use },
    { type: 'button', label: p.page[lang], href: programPage(program) }
  ]);
}

// Ambassador application, sent right after the form.
function ambassadorApplicationReceived({ language, name, code }) {
  const lang = langOf(language);
  const t = {
    fr: { subject: 'Votre demande d\'ambassadeur est bien reçue', title: 'Demande reçue', a: `Merci ${name}. Nous regardons votre demande et vous répondons par e-mail, en général sous 48 heures ouvrées.`, label: 'Code proposé', b: 'Ce code est réservé pour vous. Il ne donne pas encore de réduction : il fonctionnera dès que votre demande sera acceptée. Nous pouvons être amenés à l\'ajuster, par exemple s\'il ressemble trop à un autre code.' },
    en: { subject: 'Your ambassador application has been received', title: 'Application received', a: `Thank you, ${name}. We review your application and reply by email, usually within 2 business days.`, label: 'Proposed code', b: 'This code is reserved for you. It does not give a discount yet: it will work as soon as your application is accepted. We may adjust it, for example if it looks too much like another code.' },
    es: { subject: 'Hemos recibido tu solicitud de embajador', title: 'Solicitud recibida', a: `Gracias, ${name}. Revisamos tu solicitud y te respondemos por correo, normalmente en 48 horas hábiles.`, label: 'Código propuesto', b: 'Este código queda reservado para ti. Todavía no da descuento: funcionará en cuanto se acepte tu solicitud. Puede que lo ajustemos, por ejemplo si se parece demasiado a otro código.' },
    de: { subject: 'Ihre Botschafter-Bewerbung ist eingegangen', title: 'Bewerbung eingegangen', a: `Vielen Dank, ${name}. Wir prüfen Ihre Bewerbung und antworten per E-Mail, in der Regel innerhalb von 2 Werktagen.`, label: 'Vorgeschlagener Code', b: 'Dieser Code ist für Sie reserviert. Er gibt noch keinen Rabatt, sondern funktioniert, sobald Ihre Bewerbung angenommen ist. Eventuell passen wir ihn an, etwa wenn er einem anderen Code zu ähnlich ist.' }
  }[lang];
  return buildProgramMail('ambassador', lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    code ? { type: 'code', label: t.label, code } : null,
    { type: 'p', text: t.b }
  ]);
}

// Accepted, changed by the team, or active again after a pause.
function ambassadorApproved({ language, name, code, discount, reward, variant = 'approved', previousCode }) {
  const lang = langOf(language);
  const off = formatCurrency(discount || 0, 'EUR', lang);
  const gain = formatCurrency(reward || 0, 'EUR', lang);
  const url = `${getSiteUrl()}/?ref=${encodeURIComponent(code)}`;
  const intro = {
    approved: {
      fr: { subject: `Votre code ambassadeur ${code} est actif`, title: 'Bienvenue dans le programme ambassadeur', a: `Bonne nouvelle, ${name} : votre demande est acceptée et votre code fonctionne dès maintenant.` },
      en: { subject: `Your ambassador code ${code} is active`, title: 'Welcome to the ambassador programme', a: `Good news, ${name}: your application is accepted and your code works from now on.` },
      es: { subject: `Tu código de embajador ${code} está activo`, title: 'Te damos la bienvenida al programa de embajadores', a: `Buenas noticias, ${name}: tu solicitud está aceptada y tu código ya funciona.` },
      de: { subject: `Ihr Botschafter-Code ${code} ist aktiv`, title: 'Willkommen im Botschafterprogramm', a: `Gute Nachricht, ${name}: Ihre Bewerbung wurde angenommen, Ihr Code funktioniert ab sofort.` }
    },
    updated: {
      fr: { subject: 'Votre compte ambassadeur a été mis à jour', title: 'Vos conditions ont changé', a: `${name}, nous avons mis à jour votre compte ambassadeur. Voici ce qui s'applique à partir de maintenant.` },
      en: { subject: 'Your ambassador account has been updated', title: 'Your terms have changed', a: `${name}, we have updated your ambassador account. Here is what applies from now on.` },
      es: { subject: 'Hemos actualizado tu cuenta de embajador', title: 'Tus condiciones han cambiado', a: `${name}, hemos actualizado tu cuenta de embajador. Esto es lo que se aplica a partir de ahora.` },
      de: { subject: 'Ihr Botschafterkonto wurde aktualisiert', title: 'Ihre Konditionen haben sich geändert', a: `${name}, wir haben Ihr Botschafterkonto aktualisiert. Ab sofort gilt Folgendes.` }
    },
    resumed: {
      fr: { subject: `Votre code ambassadeur ${code} fonctionne de nouveau`, title: 'Votre code est de nouveau actif', a: `${name}, votre code ambassadeur est de nouveau actif : il donne la réduction dès maintenant.` },
      en: { subject: `Your ambassador code ${code} works again`, title: 'Your code is active again', a: `${name}, your ambassador code is active again and gives the discount from now on.` },
      es: { subject: `Tu código de embajador ${code} vuelve a funcionar`, title: 'Tu código vuelve a estar activo', a: `${name}, tu código de embajador vuelve a estar activo y da el descuento desde ahora.` },
      de: { subject: `Ihr Botschafter-Code ${code} funktioniert wieder`, title: 'Ihr Code ist wieder aktiv', a: `${name}, Ihr Botschafter-Code ist wieder aktiv und gibt ab sofort den Rabatt.` }
    }
  }[variant] || {};
  const t = {
    fr: { label: 'Votre code ambassadeur', off: 'Réduction pour la personne qui commande', gain: 'Votre gain par commande réglée', how: 'Comment ça marche', share: `Partagez votre code ou votre lien : ${url}`, s2: `La personne qui commande avec ce code paie ${off} de moins.`, s3: `Dès qu'elle a réglé sa commande, ${gain} s'ajoutent à votre solde.`, s4: 'Vous vous faites virer votre solde, ou vous l\'utilisez pour votre propre abonnement.', old: `L'ancien code ${previousCode} ne fonctionne plus.` },
    en: { label: 'Your ambassador code', off: 'Discount for the person ordering', gain: 'Your earnings per paid order', how: 'How it works', share: `Share your code or your link: ${url}`, s2: `Whoever orders with this code pays ${off} less.`, s3: `As soon as they have paid, ${gain} is added to your balance.`, s4: 'Have your balance transferred to you, or use it for your own subscription.', old: `The old code ${previousCode} no longer works.` },
    es: { label: 'Tu código de embajador', off: 'Descuento para quien pide', gain: 'Lo que ganas por pedido pagado', how: 'Cómo funciona', share: `Comparte tu código o tu enlace: ${url}`, s2: `Quien pida con este código paga ${off} menos.`, s3: `En cuanto haya pagado, se suman ${gain} a tu saldo.`, s4: 'Pide la transferencia de tu saldo o úsalo para tu propia suscripción.', old: `El código anterior ${previousCode} ya no funciona.` },
    de: { label: 'Ihr Botschafter-Code', off: 'Rabatt für die bestellende Person', gain: 'Ihr Verdienst pro bezahlter Bestellung', how: 'So funktioniert es', share: `Teilen Sie Ihren Code oder Ihren Link: ${url}`, s2: `Wer mit diesem Code bestellt, zahlt ${off} weniger.`, s3: `Sobald die Person bezahlt hat, werden Ihrem Guthaben ${gain} gutgeschrieben.`, s4: 'Lassen Sie sich Ihr Guthaben überweisen oder nutzen Sie es für Ihr eigenes Abo.', old: `Der alte Code ${previousCode} funktioniert nicht mehr.` }
  }[lang];
  const head = intro[lang] || intro.fr || {};
  const rows = [
    discount > 0 ? { label: t.off, value: `-${off}` } : null,
    reward > 0 ? { label: t.gain, value: gain } : null
  ].filter(Boolean);
  const steps = [t.share, discount > 0 ? t.s2 : null, reward > 0 ? t.s3 : null, reward > 0 ? t.s4 : null].filter(Boolean);
  return buildProgramMail('ambassador', lang, { ...head }, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: head.a },
    { type: 'code', label: t.label, code },
    previousCode && previousCode !== code ? { type: 'note', text: t.old, tone: 'highlight' } : null,
    rows.length ? { type: 'details', rows } : null,
    { type: 'steps', title: t.how, items: steps },
    { type: 'button', label: PROGRAMS.ambassador.page[lang], href: programPage('ambassador') }
  ]);
}

function ambassadorPaused({ language, name, code }) {
  const lang = langOf(language);
  const t = {
    fr: { subject: `Votre code ambassadeur ${code} est en pause`, title: 'Votre code est en pause', a: `${name}, votre code ${code} est en pause : pour l'instant, il ne donne plus de réduction sur les nouvelles commandes. Les commandes déjà passées avec votre code vous rapportent toujours votre gain une fois réglées.`, b: 'Votre solde reste à vous : vous pouvez toujours vous le faire virer ou l\'utiliser depuis votre espace ambassadeur. Pour toute question, répondez à cet e-mail.' },
    en: { subject: `Your ambassador code ${code} is paused`, title: 'Your code is paused', a: `${name}, your code ${code} is paused: for now it gives no discount on new orders. Orders already placed with your code still earn you your reward once they are paid.`, b: 'Your balance is still yours: you can have it transferred or use it from your ambassador page. If you have any questions, reply to this email.' },
    es: { subject: `Tu código de embajador ${code} está en pausa`, title: 'Tu código está en pausa', a: `${name}, tu código ${code} está en pausa: por ahora no da descuento en los pedidos nuevos. Los pedidos ya hechos con tu código te siguen dando tu ganancia en cuanto se paguen.`, b: 'Tu saldo sigue siendo tuyo: puedes pedir la transferencia o usarlo desde tu página de embajador. Si tienes alguna pregunta, responde a este correo.' },
    de: { subject: `Ihr Botschafter-Code ${code} ist pausiert`, title: 'Ihr Code ist pausiert', a: `${name}, Ihr Code ${code} ist pausiert: Er gibt vorerst keinen Rabatt auf neue Bestellungen. Bestellungen, die bereits mit Ihrem Code aufgegeben wurden, bringen Ihnen Ihren Verdienst weiterhin, sobald sie bezahlt sind.`, b: 'Ihr Guthaben gehört weiterhin Ihnen: Sie können es sich auf Ihrer Botschafterseite überweisen lassen oder dort nutzen. Bei Fragen antworten Sie einfach auf diese E-Mail.' }
  }[lang];
  return buildProgramMail('ambassador', lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    { type: 'p', text: t.b },
    { type: 'button', label: PROGRAMS.ambassador.page[lang], href: programPage('ambassador'), variant: 'ghost' }
  ]);
}

function ambassadorRejected({ language, name }) {
  const lang = langOf(language);
  const t = {
    fr: { subject: 'Votre demande d\'ambassadeur', title: 'Votre demande n\'a pas été retenue', a: `Merci ${name} pour votre intérêt. Nous ne pouvons pas donner suite à votre demande pour le moment, et le code proposé est libéré.`, b: 'Si vous pensez qu\'il manque une information, répondez simplement à cet e-mail.' },
    en: { subject: 'Your ambassador application', title: 'We cannot accept your application', a: `Thank you for your interest, ${name}. We are not able to accept your application at the moment, and the proposed code has been released.`, b: 'If you think some information is missing, just reply to this email.' },
    es: { subject: 'Tu solicitud de embajador', title: 'No podemos aceptar tu solicitud', a: `Gracias por tu interés, ${name}. Por ahora no podemos aceptar tu solicitud y el código propuesto queda libre.`, b: 'Si crees que falta algún dato, responde a este correo.' },
    de: { subject: 'Ihre Botschafter-Bewerbung', title: 'Wir können Ihre Bewerbung nicht annehmen', a: `Vielen Dank für Ihr Interesse, ${name}. Wir können Ihre Bewerbung derzeit leider nicht annehmen, der vorgeschlagene Code wurde freigegeben.`, b: 'Falls Ihrer Meinung nach eine Angabe fehlt, antworten Sie einfach auf diese E-Mail.' }
  }[lang];
  return buildProgramMail('ambassador', lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    { type: 'p', text: t.b }
  ]);
}

// The owner turned (part of) their balance into a single-use discount code.
function balanceCode({ program, language, promoCode, amount, balanceLeft }) {
  const lang = langOf(language);
  const sum = formatCurrency(amount, 'EUR', lang);
  const t = {
    fr: { subject: `Votre code de ${sum} pour LinkedIn Premium`, title: 'Votre solde devient un code', a: `Voici votre code de ${sum}, à saisir au moment de commander. Il fonctionne une fois, sur l'offre de votre choix. S'il couvre tout le prix, vous n'avez rien à payer.`, label: 'Code de réduction', left: 'Solde restant', button: 'Choisir mon abonnement', note: 'Si le code vaut plus que l\'offre choisie, la différence n\'est pas conservée.' },
    en: { subject: `Your ${sum} code for LinkedIn Premium`, title: 'Your balance is now a code', a: `Here is your ${sum} code to enter when you order. It works once, on the offer of your choice. If it covers the whole price, there is nothing to pay.`, label: 'Discount code', left: 'Remaining balance', button: 'Choose my subscription', note: 'If the code is worth more than the offer you choose, the difference is not kept.' },
    es: { subject: `Tu código de ${sum} para LinkedIn Premium`, title: 'Tu saldo ahora es un código', a: `Aquí tienes tu código de ${sum} para usar al hacer el pedido. Funciona una vez, en la oferta que elijas. Si cubre todo el precio, no tienes nada que pagar.`, label: 'Código de descuento', left: 'Saldo restante', button: 'Elegir mi suscripción', note: 'Si el código vale más que la oferta elegida, la diferencia no se conserva.' },
    de: { subject: `Ihr Code über ${sum} für LinkedIn Premium`, title: 'Ihr Guthaben als Code', a: `Hier ist Ihr Code über ${sum}, den Sie bei der Bestellung eingeben. Er gilt einmal, für ein Angebot Ihrer Wahl. Deckt er den ganzen Preis, zahlen Sie nichts.`, label: 'Rabattcode', left: 'Restguthaben', button: 'Abo auswählen', note: 'Ist der Code mehr wert als das gewählte Angebot, verfällt die Differenz.' }
  }[lang];
  return buildProgramMail(program, lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    { type: 'code', label: t.label, code: promoCode },
    { type: 'details', rows: [{ label: t.left, value: formatCurrency(balanceLeft || 0, 'EUR', lang) }] },
    { type: 'button', label: t.button, href: `${getSiteUrl()}/#tarifs` },
    { type: 'p', text: t.note, small: true }
  ]);
}

// The team marked the transfer as sent.
function transferSent({ program, language, amount, iban }) {
  const lang = langOf(language);
  const p = programOf(program);
  const sum = formatCurrency(amount, 'EUR', lang);
  const t = {
    fr: { subject: `Virement envoyé : ${sum}`, title: 'Votre virement est parti', a: `Nous avons envoyé le virement de ${sum} correspondant à ${p.balance.fr}. Selon votre banque, il arrive sous 1 à 3 jours ouvrés.`, amount: 'Montant' },
    en: { subject: `Transfer sent: ${sum}`, title: 'Your transfer is on its way', a: `We have sent the transfer of ${sum} for ${p.balance.en}. Depending on your bank, it arrives within 1 to 3 business days.`, amount: 'Amount' },
    es: { subject: `Transferencia enviada: ${sum}`, title: 'Tu transferencia está en camino', a: `Hemos enviado la transferencia de ${sum} de ${p.balance.es}. Según tu banco, llega en 1 a 3 días hábiles.`, amount: 'Importe' },
    de: { subject: `Überweisung gesendet: ${sum}`, title: 'Ihre Überweisung ist unterwegs', a: `Wir haben die Überweisung über ${sum} für ${p.balance.de} veranlasst. Je nach Bank kommt sie innerhalb von 1 bis 3 Werktagen an.`, amount: 'Betrag' }
  }[lang];
  return buildProgramMail(program, lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    { type: 'details', rows: [{ label: t.amount, value: sum }, { label: 'IBAN', value: maskIban(iban), mono: true }] }
  ]);
}

function maskIban(iban) {
  const clean = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (clean.length < 8) return clean ? '••••' : '';
  return `${clean.slice(0, 4)} •••• ${clean.slice(-4)}`;
}

function transferRequested({ program, language, amount, iban, accountName }) {
  const lang = langOf(language);
  const sum = formatCurrency(amount, 'EUR', lang);
  const t = {
    fr: { subject: 'Demande de virement reçue', title: 'Demande de virement reçue', a: `Nous avons bien reçu votre demande de virement de ${sum}. Nous la traitons sous 48 heures ouvrées et vous écrivons une fois le virement envoyé.`, amount: 'Montant', holder: 'Titulaire', warn: 'Si vous n\'êtes pas à l\'origine de cette demande, répondez tout de suite à cet e-mail.' },
    en: { subject: 'Transfer request received', title: 'Transfer request received', a: `We have received your request for a transfer of ${sum}. We process it within 2 business days and will email you once the transfer is sent.`, amount: 'Amount', holder: 'Account holder', warn: 'If you did not make this request, reply to this email right away.' },
    es: { subject: 'Solicitud de transferencia recibida', title: 'Solicitud de transferencia recibida', a: `Hemos recibido tu solicitud de transferencia de ${sum}. La tramitamos en 48 horas hábiles y te escribimos cuando la enviemos.`, amount: 'Importe', holder: 'Titular', warn: 'Si no has hecho esta solicitud, responde a este correo enseguida.' },
    de: { subject: 'Überweisungsanfrage erhalten', title: 'Überweisungsanfrage erhalten', a: `Wir haben Ihre Anfrage über eine Überweisung von ${sum} erhalten. Wir bearbeiten sie innerhalb von 2 Werktagen und schreiben Ihnen, sobald die Überweisung unterwegs ist.`, amount: 'Betrag', holder: 'Kontoinhaber', warn: 'Falls Sie diese Anfrage nicht gestellt haben, antworten Sie bitte sofort auf diese E-Mail.' }
  }[lang];
  return buildProgramMail(program, lang, t, [
    { type: 'p', text: L[lang].hello },
    { type: 'p', text: t.a },
    { type: 'details', rows: [
      { label: t.amount, value: sum },
      { label: t.holder, value: accountName },
      { label: 'IBAN', value: maskIban(iban), mono: true }
    ] },
    { type: 'note', text: t.warn, tone: 'highlight' }
  ]);
}

// 10. Sign-in code for the referral or ambassador page.
function accessCode({ program, language, code }) {
  const lang = langOf(language);
  const p = programOf(program);
  const t = {
    fr: { subject: `${code} est votre code Kareer`, title: 'Votre code d\'accès', a: `Voici le code pour ouvrir ${p.space.fr}. Il est valable 15 minutes.`, label: 'Code', warn: 'Si vous n\'avez pas demandé ce code, ignorez cet e-mail : sans lui, personne ne peut ouvrir votre espace.' },
    en: { subject: `${code} is your Kareer code`, title: 'Your access code', a: `Here is the code to open ${p.space.en}. It is valid for 15 minutes.`, label: 'Code', warn: 'If you did not ask for this code, ignore this email: nobody can open your page without it.' },
    es: { subject: `${code} es tu código de Kareer`, title: 'Tu código de acceso', a: `Este es el código para abrir ${p.space.es}. Es válido durante 15 minutos.`, label: 'Código', warn: 'Si no has pedido este código, ignora este correo: sin él nadie puede abrir tu página.' },
    de: { subject: `${code} ist Ihr Kareer-Code`, title: 'Ihr Zugangscode', a: `Mit diesem Code öffnen Sie ${p.space.de}. Er ist 15 Minuten gültig.`, label: 'Code', warn: 'Falls Sie diesen Code nicht angefordert haben, ignorieren Sie diese E-Mail: Ohne ihn kann niemand Ihre Seite öffnen.' }
  }[lang];
  return buildProgramMail(program, lang, t, [
    { type: 'p', text: t.a },
    { type: 'code', label: t.label, code },
    { type: 'p', text: t.warn, small: true }
  ], { signature: false });
}

module.exports = {
  accessCode,
  activated,
  activationStarted,
  ambassadorApplicationReceived,
  ambassadorApproved,
  ambassadorPaused,
  ambassadorRejected,
  balanceCode,
  credentialLink,
  maskIban,
  orderReceived,
  paymentReceived,
  programReward,
  refunded,
  reminder,
  renewal,
  transferRequested,
  transferSent,
  waText
};
