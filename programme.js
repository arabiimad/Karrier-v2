// Shared by parrainage.html and ambassadeur.html: sign-in with an emailed code, balance,
// transfer, balance code and history. Each page sets window.KAREER_PROGRAMME = { program, strings }.
(function () {
    var config = window.KAREER_PROGRAMME || {};
    var PROGRAM = config.program === 'ambassador' ? 'ambassador' : 'referral';
    var SHARED = {
        fr: {
            emailLabel: 'Adresse e-mail', sendCode: 'Recevoir un code', sending: 'Envoi…',
            codeSent: "Un code vient d'être envoyé à {email}. Il est valable 15 minutes. Pensez à regarder dans les spams.",
            codeLabel: 'Code reçu par e-mail', verify: 'Valider', resend: 'Renvoyer le code', change: "Changer d'adresse",
            errEmail: 'Adresse e-mail invalide.', errLength: 'Le code contient 6 chiffres.', errCode: 'Code incorrect. Essais restants : {n}.', errExpired: 'Ce code a expiré. Demandez-en un nouveau.',
            errTooMany: 'Trop de tentatives. Patientez quelques minutes avant de réessayer.', errNetwork: 'Connexion impossible. Réessayez.', sessionExpired: 'Votre session a expiré. Demandez un nouveau code.',
            signedAs: 'Connecté : {email}', logout: 'Se déconnecter',
            copy: 'Copier le code', copyShort: 'Copier', copied: 'Code copié', copyLink: 'Copier le lien', linkCopied: 'Lien copié', shareWa: 'Partager sur WhatsApp', shareMail: 'Partager par e-mail',
            terms: 'La personne qui commande avec ce code paie {discount} de moins. Vous gagnez {reward} par commande réglée.',
            termsNoDiscount: 'Vous gagnez {reward} par commande réglée avec ce code.',
            statEarned: 'Gains totaux', statBalance: 'Solde disponible',
            walletTitle: 'Votre solde', walletText: '{reward} par commande réglée avec votre code.', tabTransfer: 'Recevoir par virement', tabSubscription: 'Payer un abonnement',
            transferHint: 'Le solde entier vous est viré, sans minimum. Nous traitons les demandes sous 48 heures ouvrées.',
            bankTitle: 'Coordonnées bancaires', holder: 'Titulaire du compte', ibanSaved: 'IBAN enregistré : {iban}. Saisissez-en un nouveau pour le remplacer.',
            save: 'Enregistrer', saved: 'Coordonnées enregistrées', fillBoth: "Renseignez l'IBAN et le titulaire.", badIban: 'IBAN ou titulaire invalide.',
            transferBtn: 'Demander le virement de {amount}', transferEmpty: 'Rien à virer pour le moment', confirmTransfer: 'Demander le virement de {amount} ? Votre solde repassera à 0.',
            transferSent: 'Demande envoyée. Nous la traitons sous 48 heures ouvrées.', noBank: "Enregistrez d'abord vos coordonnées bancaires.",
            subHint: "Transformez votre solde en code de réduction, à saisir au moment de commander. Si le code couvre tout le prix, l'abonnement est gratuit : par exemple 60 € pour LinkedIn Career au tarif étudiant.",
            amountLabel: 'Montant', createCode: 'Créer mon code', yourCode: 'Votre code de réduction', chooseOffer: 'Choisir mon offre',
            badAmount: 'Choisissez un montant entre 1 € et votre solde.', codeCreated: 'Code créé, il vous a aussi été envoyé par e-mail.', confirmCode: 'Créer un code de {amount} ? Ce montant sera retiré de votre solde.',
            historyTitle: 'Historique', hTransferPending: 'Virement demandé · en cours', hTransferDone: 'Virement envoyé le {date}', hCode: 'Code {code}',
            reversed: 'annulé (commande remboursée)', paidOn: 'réglée le {date}',
            failed: "L'opération n'a pas abouti. Réessayez.",
            shareText: 'LinkedIn Premium moins cher avec Kareer : avec mon code {code}, tu paies {discount} de moins. {url}',
            shareTextPlain: 'LinkedIn Premium avec Kareer, commande avec mon code {code} : {url}',
            mailSubject: '{discount} de réduction sur LinkedIn Premium', mailBody: 'Bonjour,\n\nsi tu veux LinkedIn Premium, commande chez Kareer avec mon code {code} : tu paies {discount} de moins.\n\n{url}',
            mailSubjectPlain: 'LinkedIn Premium avec Kareer', mailBodyPlain: 'Bonjour,\n\nsi tu veux LinkedIn Premium, commande chez Kareer avec mon code {code}.\n\n{url}'
        },
        en: {
            emailLabel: 'Email address', sendCode: 'Send me a code', sending: 'Sending…',
            codeSent: 'A code has just been sent to {email}. It is valid for 15 minutes. Check your spam folder too.',
            codeLabel: 'Code from the email', verify: 'Confirm', resend: 'Send a new code', change: 'Use another address',
            errEmail: 'Invalid email address.', errLength: 'The code has 6 digits.', errCode: 'Wrong code. Attempts left: {n}.', errExpired: 'This code has expired. Ask for a new one.',
            errTooMany: 'Too many attempts. Wait a few minutes before trying again.', errNetwork: 'Connection failed. Try again.', sessionExpired: 'Your session has expired. Ask for a new code.',
            signedAs: 'Signed in: {email}', logout: 'Sign out',
            copy: 'Copy the code', copyShort: 'Copy', copied: 'Code copied', copyLink: 'Copy the link', linkCopied: 'Link copied', shareWa: 'Share on WhatsApp', shareMail: 'Share by email',
            terms: 'Whoever orders with this code pays {discount} less. You earn {reward} per paid order.',
            termsNoDiscount: 'You earn {reward} per order paid with this code.',
            statEarned: 'Total earned', statBalance: 'Available balance',
            walletTitle: 'Your balance', walletText: '{reward} per order paid with your code.', tabTransfer: 'Get a bank transfer', tabSubscription: 'Pay for a subscription',
            transferHint: 'The whole balance is transferred to you, with no minimum. We process requests within 2 business days.',
            bankTitle: 'Bank details', holder: 'Account holder', ibanSaved: 'Saved IBAN: {iban}. Enter a new one to replace it.',
            save: 'Save', saved: 'Bank details saved', fillBoth: 'Fill in the IBAN and the account holder.', badIban: 'Invalid IBAN or account holder.',
            transferBtn: 'Request a transfer of {amount}', transferEmpty: 'Nothing to transfer yet', confirmTransfer: 'Request the transfer of {amount}? Your balance goes back to 0.',
            transferSent: 'Request sent. We process it within 2 business days.', noBank: 'Save your bank details first.',
            subHint: 'Turn your balance into a discount code to enter when you order. If the code covers the whole price, the subscription is free: for example €60 for LinkedIn Career at the student price.',
            amountLabel: 'Amount', createCode: 'Create my code', yourCode: 'Your discount code', chooseOffer: 'Choose my offer',
            badAmount: 'Choose an amount between €1 and your balance.', codeCreated: 'Code created. We also emailed it to you.', confirmCode: 'Create a {amount} code? This amount will be taken from your balance.',
            historyTitle: 'History', hTransferPending: 'Transfer requested · in progress', hTransferDone: 'Transfer sent on {date}', hCode: 'Code {code}',
            reversed: 'cancelled (order refunded)', paidOn: 'paid on {date}',
            failed: 'That did not work. Try again.',
            shareText: 'LinkedIn Premium for less with Kareer: with my code {code} you pay {discount} less. {url}',
            shareTextPlain: 'LinkedIn Premium with Kareer, order with my code {code}: {url}',
            mailSubject: '{discount} off LinkedIn Premium', mailBody: 'Hi,\n\nif you want LinkedIn Premium, order from Kareer with my code {code}: you pay {discount} less.\n\n{url}',
            mailSubjectPlain: 'LinkedIn Premium with Kareer', mailBodyPlain: 'Hi,\n\nif you want LinkedIn Premium, order from Kareer with my code {code}.\n\n{url}'
        },
        es: {
            emailLabel: 'Correo electrónico', sendCode: 'Recibir un código', sending: 'Enviando…',
            codeSent: 'Acabamos de enviar un código a {email}. Es válido 15 minutos. Revisa también el spam.',
            codeLabel: 'Código del correo', verify: 'Confirmar', resend: 'Enviar otro código', change: 'Usar otro correo',
            errEmail: 'Correo no válido.', errLength: 'El código tiene 6 cifras.', errCode: 'Código incorrecto. Intentos restantes: {n}.', errExpired: 'Este código ha caducado. Pide uno nuevo.',
            errTooMany: 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.', errNetwork: 'No hay conexión. Inténtalo de nuevo.', sessionExpired: 'Tu sesión ha caducado. Pide un código nuevo.',
            signedAs: 'Sesión: {email}', logout: 'Cerrar sesión',
            copy: 'Copiar el código', copyShort: 'Copiar', copied: 'Código copiado', copyLink: 'Copiar el enlace', linkCopied: 'Enlace copiado', shareWa: 'Compartir por WhatsApp', shareMail: 'Compartir por correo',
            terms: 'Quien pida con este código paga {discount} menos. Tú ganas {reward} por cada pedido pagado.',
            termsNoDiscount: 'Ganas {reward} por cada pedido pagado con este código.',
            statEarned: 'Total ganado', statBalance: 'Saldo disponible',
            walletTitle: 'Tu saldo', walletText: '{reward} por cada pedido pagado con tu código.', tabTransfer: 'Recibir por transferencia', tabSubscription: 'Pagar una suscripción',
            transferHint: 'Te transferimos todo el saldo, sin mínimo. Tramitamos las solicitudes en 48 horas hábiles.',
            bankTitle: 'Datos bancarios', holder: 'Titular de la cuenta', ibanSaved: 'IBAN guardado: {iban}. Escribe uno nuevo para cambiarlo.',
            save: 'Guardar', saved: 'Datos guardados', fillBoth: 'Completa el IBAN y el titular.', badIban: 'IBAN o titular no válido.',
            transferBtn: 'Pedir la transferencia de {amount}', transferEmpty: 'Nada que transferir por ahora', confirmTransfer: '¿Pedir la transferencia de {amount}? Tu saldo volverá a 0.',
            transferSent: 'Solicitud enviada. La tramitamos en 48 horas hábiles.', noBank: 'Guarda primero tus datos bancarios.',
            subHint: 'Convierte tu saldo en un código de descuento para usar al hacer el pedido. Si el código cubre todo el precio, la suscripción es gratis: por ejemplo 60 € para LinkedIn Career con precio de estudiante.',
            amountLabel: 'Importe', createCode: 'Crear mi código', yourCode: 'Tu código de descuento', chooseOffer: 'Elegir mi oferta',
            badAmount: 'Elige un importe entre 1 € y tu saldo.', codeCreated: 'Código creado. También te lo hemos enviado por correo.', confirmCode: '¿Crear un código de {amount}? Ese importe se descontará de tu saldo.',
            historyTitle: 'Historial', hTransferPending: 'Transferencia pedida · en curso', hTransferDone: 'Transferencia enviada el {date}', hCode: 'Código {code}',
            reversed: 'anulado (pedido reembolsado)', paidOn: 'pagado el {date}',
            failed: 'No ha funcionado. Inténtalo de nuevo.',
            shareText: 'LinkedIn Premium más barato con Kareer: con mi código {code} pagas {discount} menos. {url}',
            shareTextPlain: 'LinkedIn Premium con Kareer, pide con mi código {code}: {url}',
            mailSubject: '{discount} de descuento en LinkedIn Premium', mailBody: 'Hola:\n\nsi quieres LinkedIn Premium, pide en Kareer con mi código {code}: pagas {discount} menos.\n\n{url}',
            mailSubjectPlain: 'LinkedIn Premium con Kareer', mailBodyPlain: 'Hola:\n\nsi quieres LinkedIn Premium, pide en Kareer con mi código {code}.\n\n{url}'
        },
        de: {
            emailLabel: 'E-Mail-Adresse', sendCode: 'Code anfordern', sending: 'Wird gesendet…',
            codeSent: 'Wir haben gerade einen Code an {email} gesendet. Er ist 15 Minuten gültig. Prüfen Sie auch den Spam-Ordner.',
            codeLabel: 'Code aus der E-Mail', verify: 'Bestätigen', resend: 'Neuen Code senden', change: 'Andere Adresse',
            errEmail: 'Ungültige E-Mail-Adresse.', errLength: 'Der Code hat 6 Ziffern.', errCode: 'Falscher Code. Verbleibende Versuche: {n}.', errExpired: 'Dieser Code ist abgelaufen. Fordern Sie einen neuen an.',
            errTooMany: 'Zu viele Versuche. Bitte warten Sie einige Minuten.', errNetwork: 'Keine Verbindung. Bitte erneut versuchen.', sessionExpired: 'Ihre Sitzung ist abgelaufen. Fordern Sie einen neuen Code an.',
            signedAs: 'Angemeldet: {email}', logout: 'Abmelden',
            copy: 'Code kopieren', copyShort: 'Kopieren', copied: 'Code kopiert', copyLink: 'Link kopieren', linkCopied: 'Link kopiert', shareWa: 'Auf WhatsApp teilen', shareMail: 'Per E-Mail teilen',
            terms: 'Wer mit diesem Code bestellt, zahlt {discount} weniger. Sie verdienen {reward} pro bezahlter Bestellung.',
            termsNoDiscount: 'Sie verdienen {reward} pro Bestellung, die mit diesem Code bezahlt wird.',
            statEarned: 'Insgesamt verdient', statBalance: 'Verfügbares Guthaben',
            walletTitle: 'Ihr Guthaben', walletText: '{reward} pro bezahlter Bestellung mit Ihrem Code.', tabTransfer: 'Per Überweisung erhalten', tabSubscription: 'Ein Abo bezahlen',
            transferHint: 'Das gesamte Guthaben wird überwiesen, ohne Mindestbetrag. Wir bearbeiten Anfragen innerhalb von 2 Werktagen.',
            bankTitle: 'Bankverbindung', holder: 'Kontoinhaber', ibanSaved: 'Gespeicherte IBAN: {iban}. Geben Sie eine neue ein, um sie zu ersetzen.',
            save: 'Speichern', saved: 'Bankverbindung gespeichert', fillBoth: 'Bitte IBAN und Kontoinhaber angeben.', badIban: 'Ungültige IBAN oder ungültiger Kontoinhaber.',
            transferBtn: 'Überweisung von {amount} anfordern', transferEmpty: 'Noch nichts zu überweisen', confirmTransfer: 'Überweisung von {amount} anfordern? Ihr Guthaben wird auf 0 gesetzt.',
            transferSent: 'Anfrage gesendet. Wir bearbeiten sie innerhalb von 2 Werktagen.', noBank: 'Speichern Sie zuerst Ihre Bankverbindung.',
            subHint: 'Machen Sie aus Ihrem Guthaben einen Rabattcode, den Sie bei der Bestellung eingeben. Deckt der Code den ganzen Preis, ist das Abo kostenlos: zum Beispiel 60 € für LinkedIn Career zum Studierendenpreis.',
            amountLabel: 'Betrag', createCode: 'Code erstellen', yourCode: 'Ihr Rabattcode', chooseOffer: 'Angebot wählen',
            badAmount: 'Wählen Sie einen Betrag zwischen 1 € und Ihrem Guthaben.', codeCreated: 'Code erstellt. Wir haben ihn Ihnen auch per E-Mail geschickt.', confirmCode: 'Einen Code über {amount} erstellen? Der Betrag wird von Ihrem Guthaben abgezogen.',
            historyTitle: 'Verlauf', hTransferPending: 'Überweisung angefordert · in Bearbeitung', hTransferDone: 'Überweisung gesendet am {date}', hCode: 'Code {code}',
            reversed: 'storniert (Bestellung erstattet)', paidOn: 'bezahlt am {date}',
            failed: 'Das hat nicht geklappt. Bitte erneut versuchen.',
            shareText: 'LinkedIn Premium günstiger mit Kareer: Mit meinem Code {code} zahlst du {discount} weniger. {url}',
            shareTextPlain: 'LinkedIn Premium mit Kareer, bestell mit meinem Code {code}: {url}',
            mailSubject: '{discount} Rabatt auf LinkedIn Premium', mailBody: 'Hallo,\n\nwenn du LinkedIn Premium möchtest, bestell bei Kareer mit meinem Code {code}: Du zahlst {discount} weniger.\n\n{url}',
            mailSubjectPlain: 'LinkedIn Premium mit Kareer', mailBodyPlain: 'Hallo,\n\nwenn du LinkedIn Premium möchtest, bestell bei Kareer mit meinem Code {code}.\n\n{url}'
        }
    };
    var T = {};
    Object.keys(SHARED).forEach(function (l) {
        T[l] = {};
        [SHARED[l], (config.strings || {})[l] || {}].forEach(function (src) { Object.keys(src).forEach(function (k) { T[l][k] = src[k]; }); });
    });

    var LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE' };
    // One session for both pages: it proves the email, not the programme.
    var TOKEN_KEY = 'kareer_referral_session';
    var STATE_BOXES = ['signin', 'noCodeBox', 'applyBox', 'pendingBox', 'rejectedBox', 'dashboard'].filter(function (id) { return document.getElementById(id); });
    var lang = pickLang();
    var t = T[lang];
    var email = '';
    var data = null;
    var panel = 'transfer';

    function $(id) { return document.getElementById(id); }
    function fill(text, map) { return String(text || '').replace(/\{(\w+)\}/g, function (_, k) { return map[k] != null ? map[k] : ''; }); }
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function money(n) { return new Intl.NumberFormat(LOCALES[lang], { style: 'currency', currency: 'EUR', minimumFractionDigits: Number.isInteger(Number(n || 0)) ? 0 : 2 }).format(n || 0); }
    function day(v) { return v ? new Date(v).toLocaleDateString(LOCALES[lang]) : ''; }
    function pickLang() {
        var c = [new URLSearchParams(location.search).get('lang')];
        try { c.push(localStorage.getItem('kareer_lang')); } catch (e) {}
        c.push((navigator.language || '').slice(0, 2));
        for (var i = 0; i < c.length; i++) if (c[i] && T[c[i]]) return c[i];
        return 'fr';
    }
    function getToken() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
    function setToken(v) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }
    function showToast(text) {
        var toast = $('toast');
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(function () { toast.classList.remove('show'); }, 3200);
    }
    function message(text, isError) {
        var el = $('signinMsg');
        el.textContent = text || '';
        el.className = 'signin-msg' + (isError ? ' error' : '');
    }
    function show(box) {
        STATE_BOXES.forEach(function (id) { $(id).hidden = id !== box; });
        $('sessionBar').hidden = box === 'signin';
        $('signedAs').textContent = fill(t.signedAs, { email: email });
        // Explanations for people who are not signed in yet.
        document.querySelectorAll('[data-signed-out]').forEach(function (el) { el.hidden = box !== 'signin'; });
    }

    function api(path, options) {
        options = options || {};
        var headers = { 'Content-Type': 'application/json' };
        var token = getToken();
        if (token) headers.Authorization = 'Bearer ' + token;
        return fetch('/api/rewards?type=' + PROGRAM + path, { method: options.method || 'GET', headers: headers, body: options.body ? JSON.stringify(options.body) : undefined })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, ok: res.ok, data: body }; }); });
    }

    function applyLang() {
        document.documentElement.lang = lang;
        document.title = t.pageTitle;
        document.querySelectorAll('[data-t]').forEach(function (el) { var v = t[el.getAttribute('data-t')]; if (v != null) el.textContent = v; });
        document.querySelectorAll('[data-t-placeholder]').forEach(function (el) { var v = t[el.getAttribute('data-t-placeholder')]; if (v != null) el.placeholder = v; });
        document.querySelectorAll('.ref-langs button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.lang === lang ? 'true' : 'false'); });
        document.querySelectorAll('a[data-keep-lang]').forEach(function (a) { a.href = a.getAttribute('data-keep-lang') + '?lang=' + lang; });
        $('holderInput').placeholder = t.holder;
        if (email && !$('codeForm').hidden) $('codeSent').textContent = fill(t.codeSent, { email: email });
        $('signedAs').textContent = fill(t.signedAs, { email: email });
        if (data) render();
        else if ($('noCodeBox') && !$('noCodeBox').hidden) $('noCodeText').textContent = fill(t.noCodeText, { email: email });
    }

    // ----- sign-in -----
    function sendCode() {
        var value = $('emailInput').value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { message(t.errEmail, true); return; }
        email = value;
        $('sendBtn').disabled = true;
        $('sendBtn').textContent = t.sending;
        message('');
        api('&action=send_code', { method: 'POST', body: { email: email, lang: lang } }).then(function (r) {
            if (r.status === 429) { message(t.errTooMany, true); return; }
            if (!r.ok) { message(r.data.error === 'invalid_email' ? t.errEmail : t.failed, true); return; }
            $('emailForm').hidden = true;
            $('codeForm').hidden = false;
            $('codeSent').textContent = fill(t.codeSent, { email: email });
            $('codeInput').value = '';
            $('codeInput').focus();
        }).catch(function () { message(t.errNetwork, true); })
          .finally(function () { $('sendBtn').disabled = false; $('sendBtn').textContent = t.sendCode; });
    }

    function verifyCode() {
        var code = $('codeInput').value.replace(/\D/g, '');
        if (code.length !== 6) { message(t.errLength, true); return; }
        $('verifyBtn').disabled = true;
        api('&action=verify_code', { method: 'POST', body: { email: email, code: code } }).then(function (r) {
            if (r.ok && r.data.token) { setToken(r.data.token); message(''); load(); return; }
            var err = r.data.error;
            if (err === 'code_expired') message(t.errExpired, true);
            else if (err === 'too_many_attempts' || r.status === 429) message(t.errTooMany, true);
            else message(fill(t.errCode, { n: r.data.attemptsLeft != null ? r.data.attemptsLeft : '…' }), true);
        }).catch(function () { message(t.errNetwork, true); })
          .finally(function () { $('verifyBtn').disabled = false; });
    }

    function showSignin(note) {
        setToken(null);
        data = null;
        show('signin');
        $('codeForm').hidden = true;
        $('emailForm').hidden = false;
        if (email) $('emailInput').value = email;
        message(note || '', !!note);
    }

    // ----- signed in -----
    function load() {
        api('&me=1').then(function (r) {
            if (r.status === 401) { showSignin(getToken() ? t.sessionExpired : ''); return; }
            if (r.status === 404) {
                email = r.data.email || email;
                data = null;
                if ($('applyBox')) { show('applyBox'); return; }
                show('noCodeBox');
                $('noCodeText').textContent = fill(t.noCodeText, { email: email });
                return;
            }
            if (!r.ok) { showSignin(t.failed); return; }
            data = r.data;
            email = data.email || email;
            render();
        }).catch(function () { showSignin(t.errNetwork); });
    }

    function render() {
        if (data.status === 'pending' && $('pendingBox')) {
            show('pendingBox');
            $('pendingText').textContent = fill(t.pendingText, { name: data.name || (data.application && data.application.name) || '', code: data.code || '' });
            return;
        }
        if (data.status === 'rejected' && $('rejectedBox')) { show('rejectedBox'); return; }
        show('dashboard');
        var balance = Number(data.pendingBalance || 0);
        var discount = Number(data.discount || 0);
        var reward = Number(data.reward || 0);
        var refs = data.referrals || [];
        var counted = refs.filter(function (r) { return !r.reversed; });
        var earned = counted.reduce(function (sum, r) { return sum + (r.reward != null ? Number(r.reward) : reward); }, 0);
        if ($('pausedNote')) $('pausedNote').hidden = data.status !== 'paused';
        $('referralCode').textContent = data.code;
        $('codeTerms').textContent = fill(discount > 0 ? t.terms : t.termsNoDiscount, { discount: money(discount), reward: money(reward) });
        $('referralCount').textContent = counted.length || 0;
        $('totalEarned').textContent = money(earned);
        $('balance').textContent = money(balance);
        $('walletText').textContent = fill(t.walletText, { reward: money(reward) });

        document.querySelectorAll('.wallet-tabs button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.panel === panel ? 'true' : 'false'); });
        $('panelTransfer').hidden = panel !== 'transfer';
        $('panelSubscription').hidden = panel !== 'subscription';

        var info = data.paymentInfo || null;
        $('ibanSaved').hidden = !(info && info.ibanMasked);
        if (info && info.ibanMasked) $('ibanSaved').textContent = fill(t.ibanSaved, { iban: info.ibanMasked });
        if (info && info.accountName && !$('holderInput').value) $('holderInput').value = info.accountName;
        $('transferBtn').textContent = balance > 0 ? fill(t.transferBtn, { amount: money(balance) }) : t.transferEmpty;
        $('transferBtn').disabled = !(balance > 0);
        var amountInput = $('amountInput');
        amountInput.max = balance;
        if (!amountInput.value || Number(amountInput.value) > balance) amountInput.value = balance > 0 ? balance : '';
        $('useBalanceBtn').disabled = !(balance > 0);

        var history = [];
        (data.transferRequests || []).forEach(function (r) {
            history.push({ at: r.completedAt || r.requestedAt, left: money(r.amount), right: r.status === 'completed' ? fill(t.hTransferDone, { date: day(r.completedAt) }) : t.hTransferPending });
        });
        (data.balanceCodes || []).forEach(function (c) {
            history.push({ at: c.createdAt, left: money(c.amount), right: fill(t.hCode, { code: c.code }) + ' · ' + day(c.createdAt) });
        });
        history.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
        $('historyBox').hidden = !history.length;
        $('historyList').innerHTML = history.map(function (h) { return '<div class="history-row"><span>' + esc(h.left) + '</span><span>' + esc(h.right) + '</span></div>'; }).join('');

        $('listBox').hidden = !refs.length;
        $('referralList').innerHTML = refs.slice().reverse().map(function (r) {
            var note = r.reversed ? t.reversed : r.paidAt ? fill(t.paidOn, { date: day(r.paidAt) }) : day(r.usedAt);
            var gain = '+' + esc(money(r.reward != null ? r.reward : reward));
            return '<div class="referral-item"><div class="referral-item-info"><div class="referral-item-avatar" aria-hidden="true">·</div>' +
                '<div class="referral-item-details"><h4>' + esc(r.who || '') + '</h4><p>' + esc(note) + '</p></div></div>' +
                '<div class="referral-item-reward">' + (r.reversed ? '<s>' + gain + '</s>' : gain) + (r.promoCode ? '<small>' + esc(fill(t.hCode, { code: r.promoCode })) + '</small>' : '') + '</div></div>';
        }).join('');
    }

    function update(body, okMessage) {
        return api('', { method: 'PUT', body: body }).then(function (r) {
            if (r.status === 401) { showSignin(t.sessionExpired); return null; }
            if (!r.ok) {
                var err = r.data.error;
                showToast(err === 'invalid_bank_details' ? t.badIban : err === 'missing_bank_details' ? t.noBank : err === 'invalid_amount' ? t.badAmount : t.failed);
                if (data) render();
                return null;
            }
            data = r.data[PROGRAM];
            render();
            if (okMessage) showToast(okMessage);
            return r.data;
        }).catch(function () { showToast(t.errNetwork); if (data) render(); return null; });
    }

    function saveBank() {
        var iban = $('ibanInput').value.trim();
        var holder = $('holderInput').value.trim();
        if (!iban || !holder) { showToast(t.fillBoth); return; }
        update({ paymentInfo: { iban: iban, accountName: holder } }, t.saved).then(function (r) { if (r) $('ibanInput').value = ''; });
    }

    function requestTransfer() {
        var balance = Number(data.pendingBalance || 0);
        if (!(balance > 0)) return;
        if (!data.paymentInfo) { showToast(t.noBank); return; }
        if (!confirm(fill(t.confirmTransfer, { amount: money(balance) }))) return;
        $('transferBtn').disabled = true;
        update({ requestTransfer: true }, t.transferSent);
    }

    function useBalance() {
        var balance = Number(data.pendingBalance || 0);
        var amount = Number($('amountInput').value);
        if (!(amount >= 1) || amount > balance) { showToast(t.badAmount); return; }
        if (!confirm(fill(t.confirmCode, { amount: money(amount) }))) return;
        $('useBalanceBtn').disabled = true;
        update({ useBalance: true, amount: amount }, t.codeCreated).then(function (r) {
            if (!r || !r.promoCode) return;
            $('newCodeValue').textContent = r.promoCode;
            $('newCode').hidden = false;
        });
    }

    function shareUrl() { return 'https://kareer.pro/?ref=' + encodeURIComponent(data.code); }
    function shareVars() { return { code: data.code, url: shareUrl(), discount: money(data.discount || 0) }; }
    function copy(text, done) {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(function () { showToast(done || t.copied); }).catch(function () {});
    }

    // ----- wiring -----
    $('emailForm').addEventListener('submit', function (e) { e.preventDefault(); sendCode(); });
    $('codeForm').addEventListener('submit', function (e) { e.preventDefault(); verifyCode(); });
    $('codeInput').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); if (this.value.length === 6) verifyCode(); });
    $('resendBtn').addEventListener('click', function () { $('emailInput').value = email; sendCode(); });
    $('changeBtn').addEventListener('click', function () { showSignin(''); $('emailInput').focus(); });
    $('logoutBtn').addEventListener('click', function () { showSignin(''); });
    document.querySelectorAll('.wallet-tabs button').forEach(function (b) { b.addEventListener('click', function () { panel = b.dataset.panel; if (data) render(); }); });
    $('saveBankBtn').addEventListener('click', saveBank);
    $('transferBtn').addEventListener('click', requestTransfer);
    $('useBalanceBtn').addEventListener('click', useBalance);
    $('copyNewCode').addEventListener('click', function () { copy($('newCodeValue').textContent); });
    $('copyBtn').addEventListener('click', function () { copy(data.code); });
    $('copyLinkBtn').addEventListener('click', function () { copy(shareUrl(), t.linkCopied); });
    $('shareWaBtn').addEventListener('click', function () {
        var text = fill(Number(data.discount) > 0 ? t.shareText : t.shareTextPlain, shareVars());
        window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    });
    $('shareMailBtn').addEventListener('click', function () {
        var plain = !(Number(data.discount) > 0);
        location.href = 'mailto:?subject=' + encodeURIComponent(fill(plain ? t.mailSubjectPlain : t.mailSubject, shareVars())) + '&body=' + encodeURIComponent(fill(plain ? t.mailBodyPlain : t.mailBody, shareVars()));
    });
    document.querySelectorAll('.ref-langs button').forEach(function (b) {
        b.addEventListener('click', function () {
            lang = b.dataset.lang; t = T[lang];
            try { localStorage.setItem('kareer_lang', lang); } catch (e) {}
            applyLang();
        });
    });

    // Hooks for the page's own forms (the ambassador application).
    window.KareerProgramme = {
        api: api,
        t: function () { return t; },
        lang: function () { return lang; },
        toast: showToast,
        signedOut: function () { showSignin(t.sessionExpired); },
        reload: load,
        setData: function (value) { data = value; render(); }
    };

    applyLang();
    if (getToken()) load();
})();
