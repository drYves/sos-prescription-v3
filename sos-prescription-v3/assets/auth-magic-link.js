(() => {
  const config = window.SOSPrescriptionAuthMagicLink || {};
  const strings = config.strings || {};
  const requestLinkEndpoint = toSafeString(config.requestLinkEndpoint);
  const verifyLinkEndpoint = toSafeString(config.verifyLinkEndpoint);
  const draftResendEndpoint = toSafeString(config.draftResendEndpoint);
  const redirects = typeof config.redirects === 'object' && config.redirects ? config.redirects : {};
  const requestStartUrl = toSafeString(config.requestStartUrl);

  function toSafeString(value) {
    return typeof value === 'string' ? value : '';
  }

  function getString(key, fallback) {
    const value = strings[key];
    return typeof value === 'string' && value.trim() !== '' ? value : fallback;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function isEmailLike(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
  }


  function shouldResetStorageKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return normalized.startsWith('sp_')
      || normalized.startsWith('sp-')
      || normalized.startsWith('sp:')
      || normalized.startsWith('sosprescription')
      || normalized.startsWith('sos-prescription')
      || normalized.startsWith('medlab')
      || normalized.startsWith('ml_')
      || normalized.includes('prescription')
      || normalized.includes('submission')
      || normalized.includes('draft');
  }

  function resetStorageArea(storage) {
    if (!storage) {
      return;
    }

    const keysToRemove = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && shouldResetStorageKey(key)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      try {
        storage.removeItem(key);
      } catch {
        // noop
      }
    });
  }

  function resetApplicationStorage() {
    try {
      resetStorageArea(window.localStorage);
    } catch {
      // noop
    }

    try {
      resetStorageArea(window.sessionStorage);
    } catch {
      // noop
    }

    try {
      if (typeof window.name === 'string' && shouldResetStorageKey(window.name)) {
        window.name = '';
      }
    } catch {
      // noop
    }
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  async function postJson(url, payload) {
    if (!url) {
      throw new Error('endpoint_missing');
    }

    const response = await window.fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    });

    const data = await readJson(response);
    if (!response.ok) {
      const error = new Error(
        typeof data.message === 'string' && data.message.trim() !== ''
          ? data.message.trim()
          : `http_${response.status}`
      );
      error.payload = data;
      error.status = response.status;
      throw error;
    }

    return data && typeof data === 'object' ? data : {};
  }

  function getTokenFromUrl() {
    try {
      const url = new URL(window.location.href);
      const token = url.searchParams.get('token');
      return typeof token === 'string' ? token.trim() : '';
    } catch {
      return '';
    }
  }

  function resolveRedirectUrl(payload) {
    const redirectTo = toSafeString(payload && payload.redirect_to).trim();
    if (redirectTo) {
      return redirectTo;
    }

    const role = toSafeString(payload && payload.role).trim().toLowerCase();
    if (role === 'doctor' && toSafeString(redirects.doctor)) {
      return toSafeString(redirects.doctor);
    }
    if (role === 'patient' && toSafeString(redirects.patient)) {
      return toSafeString(redirects.patient);
    }

    return toSafeString(redirects.default) || '/';
  }

  function updateAlert(feedback, variant, title, body) {
    if (!feedback) {
      return;
    }

    feedback.hidden = false;
    feedback.classList.remove('sp-alert--info', 'sp-alert--success', 'sp-alert--warning', 'sp-alert--error');
    feedback.classList.add(`sp-alert--${variant}`);

    const titleNode = feedback.querySelector('.sp-alert__title, .sp-app-notice__title');
    const bodyNode = feedback.querySelector('.sp-alert__body, [data-sp-auth-feedback-body="1"]');

    if (titleNode) {
      titleNode.textContent = title;
    }
    if (bodyNode) {
      bodyNode.textContent = body;
    }
  }

  function findRequestSurface(form) {
    if (!form) {
      return null;
    }

    return form.closest('[data-sp-auth-surface="1"]')
      || form.closest('.sp-app-stack')
      || form.closest('.sp-stack')
      || form.parentElement
      || null;
  }

  function findFeedbackForForm(form) {
    const surface = findRequestSurface(form);
    return surface ? surface.querySelector('[data-sp-auth-feedback]') : null;
  }

  function findUnknownEmailBlock(form) {
    const surface = findRequestSurface(form);
    return surface ? surface.querySelector('[data-sp-auth-unknown-email="1"]') : null;
  }

  function showRequestFeedback(form) {
    const feedback = findFeedbackForForm(form);
    if (feedback) {
      feedback.hidden = false;
    }

    const unknownEmailBlock = findUnknownEmailBlock(form);
    if (unknownEmailBlock) {
      unknownEmailBlock.hidden = true;
    }

    return feedback;
  }

  function showUnknownEmailFallback(form) {
    const feedback = findFeedbackForForm(form);
    if (feedback) {
      feedback.hidden = true;
    }

    const unknownEmailBlock = findUnknownEmailBlock(form);
    if (!unknownEmailBlock) {
      return;
    }

    const titleNode = unknownEmailBlock.querySelector('.sp-app-notice__title');
    const bodyNode = unknownEmailBlock.querySelector('p:not(.sp-app-notice__title)');
    const actionNode = unknownEmailBlock.querySelector('a, button');

    if (titleNode) {
      titleNode.textContent = getString('requestNotFoundTitle', 'E-mail non reconnu ?');
    }
    if (bodyNode) {
      bodyNode.textContent = getString('requestNotFoundBody', "Si vous n'avez pas encore passé de commande, commencez par ici.");
    }
    if (actionNode && actionNode.tagName === 'A' && requestStartUrl) {
      actionNode.setAttribute('href', requestStartUrl);
      actionNode.textContent = getString('requestNotFoundAction', 'Commencer une demande');
    }

    unknownEmailBlock.hidden = false;

    const focusTarget = unknownEmailBlock.querySelector('a, button');
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
  }

  function isPatientEntryForm(form) {
    return Boolean(form && form.dataset && form.dataset.spAuthVariant === 'patient-entry');
  }

  function isNotFoundPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const nestedData = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const code = toSafeString(payload.code || nestedData.code).trim().toLowerCase();
    const message = toSafeString(payload.message || nestedData.message).trim().toLowerCase();
    const nestedStatus = Number(nestedData.status || 0);

    return payload.not_found === true
      || nestedData.not_found === true
      || payload.sent === false
      || nestedStatus === 404
      || code === 'sosprescription_auth_email_not_found'
      || code === 'ml_auth_email_not_found'
      || message.includes('e-mail inconnu')
      || message.includes('email inconnu')
      || message.includes('non reconnu')
      || message.includes('not found');
  }

  function isNotFoundError(error) {
    if (!error) {
      return false;
    }

    if (typeof error.status === 'number' && error.status === 404) {
      return true;
    }

    const message = toSafeString(error.message).trim().toLowerCase();
    return isNotFoundPayload(error.payload)
      || message.includes('e-mail inconnu')
      || message.includes('email inconnu')
      || message.includes('non reconnu')
      || message.includes('not found');
  }

  function setButtonBusy(button, busy, idleLabel) {
    if (!button) {
      return;
    }

    if (!button.dataset.spIdleLabel) {
      button.dataset.spIdleLabel = idleLabel || button.textContent || '';
    }

    button.disabled = Boolean(busy);
    if (busy) {
      button.setAttribute('aria-busy', 'true');
      button.textContent = getString('submitLabelBusy', 'Envoi…');
      return;
    }

    button.removeAttribute('aria-busy');
    button.textContent = button.dataset.spIdleLabel || idleLabel || '';
  }

  function initRequestForms() {
    const forms = document.querySelectorAll('[data-sp-auth-request-form="1"]');
    forms.forEach((form) => {
      if (form.dataset.spMagicReady === '1') {
        return;
      }
      form.dataset.spMagicReady = '1';

      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const emailInput = form.querySelector('input[name="email"]');
        const submitButton = form.querySelector('[data-sp-auth-submit="1"]');
        const email = emailInput ? String(emailInput.value || '').trim().toLowerCase() : '';
        const feedback = showRequestFeedback(form);

        if (!isEmailLike(email)) {
          updateAlert(
            feedback,
            'error',
            getString('requestErrorTitle', 'Envoi impossible'),
            getString('magicEmailInvalid', 'Merci de renseigner une adresse e-mail valide.')
          );
          if (emailInput) {
            emailInput.focus();
          }
          return;
        }

        setButtonBusy(submitButton, true, submitButton ? submitButton.textContent : '');
        updateAlert(
          feedback,
          'info',
          getString('requestSendingTitle', 'Envoi en cours…'),
          getString('requestSendingBody', 'Nous préparons votre lien de connexion sécurisé.')
        );

        try {
          const payload = await postJson(requestLinkEndpoint, { email });

          if (isPatientEntryForm(form) && isNotFoundPayload(payload)) {
            showUnknownEmailFallback(form);
            return;
          }

          updateAlert(
            feedback,
            'success',
            getString('requestSuccessTitle', 'Lien de connexion envoyé'),
            getString('requestSuccessBody', 'Un lien de connexion vous a été envoyé par e-mail.')
          );
          form.reset();
        } catch (error) {
          if (isPatientEntryForm(form) && isNotFoundError(error)) {
            showUnknownEmailFallback(form);
            return;
          }

          updateAlert(
            feedback,
            'error',
            getString('requestErrorTitle', 'Envoi impossible'),
            extractErrorMessage(error, getString('requestErrorBody', 'Le lien de connexion n’a pas pu être envoyé pour le moment.'))
          );
        } finally {
          setButtonBusy(submitButton, false, submitButton ? submitButton.textContent : '');
        }
      });
    });
  }

  function initLegacyVerifyScreens() {
    const roots = document.querySelectorAll('[data-sp-auth-verify="1"]');
    roots.forEach((root) => {
      if (root.dataset.spMagicReady === '1') {
        return;
      }
      root.dataset.spMagicReady = '1';

      const feedback = root.querySelector('[data-sp-auth-feedback="verify"]');
      const token = getTokenFromUrl();
      if (!token) {
        updateAlert(
          feedback,
          'error',
          getString('missingTokenTitle', 'Lien incomplet'),
          getString('missingTokenBody', 'Le token de connexion est manquant dans l’URL.')
        );
        return;
      }

      verifyMagicLink(token)
        .then((payload) => {
          if (payload && payload.valid === true) {
            updateAlert(
              feedback,
              'success',
              getString('verifySuccessTitle', 'Connexion établie'),
              getString('verifySuccessBody', 'Votre session sécurisée est prête. Redirection en cours…')
            );
            resetApplicationStorage();
            window.location.replace(resolveRedirectUrl(payload));
            return;
          }

          updateAlert(
            feedback,
            'error',
            getString('verifyInvalidTitle', 'Lien invalide ou expiré'),
            getString('verifyInvalidBody', 'Le lien de connexion est invalide, expiré ou déjà utilisé.')
          );
        })
        .catch(() => {
          updateAlert(
            feedback,
            'error',
            getString('verifyErrorTitle', 'Vérification impossible'),
            getString('verifyErrorBody', 'La connexion sécurisée est temporairement indisponible.')
          );
        });
    });
  }

  async function verifyMagicLink(token) {
    return postJson(verifyLinkEndpoint, { token });
  }

  function renderMagicCard(card, options) {
    const title = escapeHtml(options.title || '');
    const text = escapeHtml(options.text || '');
    const hint = escapeHtml(options.hint || '');
    const spinnerHtml = options.spinner
      ? '<div class="sp-magic-redirect__spinner" aria-hidden="true"></div>'
      : `<div class="sp-magic-redirect__icon${options.error ? ' sp-magic-redirect__icon--error' : ''}" aria-hidden="true">${escapeHtml(options.icon || '•')}</div>`;
    const bodyHtml = options.bodyHtml || '';
    const actionsHtml = options.actionsHtml || '';

    card.innerHTML = [
      spinnerHtml,
      `<h1 class="sp-magic-redirect__title">${title}</h1>`,
      `<p class="sp-magic-redirect__text">${text}</p>`,
      bodyHtml,
      actionsHtml,
      hint ? `<p class="sp-magic-redirect__hint">${hint}</p>` : ''
    ].join('');
  }

  function renderMagicLoading(card, title, text, hint) {
    renderMagicCard(card, {
      spinner: true,
      title,
      text,
      hint,
    });
  }

  function renderMagicMessage(card, title, text, hint, extra) {
    renderMagicCard(card, {
      spinner: false,
      icon: extra && extra.icon ? extra.icon : '•',
      error: Boolean(extra && extra.error),
      title,
      text,
      hint,
      actionsHtml: extra && extra.actionsHtml ? extra.actionsHtml : '',
      bodyHtml: extra && extra.bodyHtml ? extra.bodyHtml : '',
    });
  }

  function baseActionsHtml(includeReturnHome) {
    if (!includeReturnHome) {
      return '';
    }

    return `<div class="sp-magic-redirect__actions"><a class="sp-magic-redirect__button sp-magic-redirect__button--secondary" href="${escapeHtml(toSafeString(redirects.default) || '/')}">${escapeHtml(getString('magicReturnHomeLabel', 'Retour à l’accueil'))}</a></div>`;
  }

  function buildInvalidActionsHtml() {
    return [
      '<div class="sp-magic-redirect__actions">',
      `<button type="button" class="sp-magic-redirect__button" data-sp-magic-resend="1">${escapeHtml(getString('magicResendButton', 'Demander un nouveau lien'))}</button>`,
      `<a class="sp-magic-redirect__button sp-magic-redirect__button--secondary" href="${escapeHtml(toSafeString(redirects.default) || '/')}">${escapeHtml(getString('magicReturnHomeLabel', 'Retour à l’accueil'))}</a>`,
      '</div>'
    ].join('');
  }

  function buildEmailCaptureBodyHtml() {
    return [
      '<div class="sp-magic-redirect__field">',
      `<label class="sp-magic-redirect__label" for="sp-magic-email">${escapeHtml(getString('magicEmailLabel', 'Adresse e-mail'))}</label>`,
      `<input class="sp-magic-redirect__input" id="sp-magic-email" type="email" inputmode="email" autocomplete="email" placeholder="${escapeHtml(getString('magicEmailPlaceholder', 'vous@exemple.fr'))}" data-sp-magic-email-input="1" />`,
      '</div>',
      '<div class="sp-magic-redirect__actions">',
      `<button type="button" class="sp-magic-redirect__button" data-sp-magic-submit-email="1">${escapeHtml(getString('magicEmailSubmit', 'Recevoir un nouveau lien'))}</button>`,
      `<button type="button" class="sp-magic-redirect__button sp-magic-redirect__button--secondary" data-sp-magic-cancel-email="1">${escapeHtml(getString('magicReturnHomeLabel', 'Retour à l’accueil'))}</button>`,
      '</div>'
    ].join('');
  }

  function extractErrorMessage(error, fallback) {
    if (error && typeof error.message === 'string' && error.message.trim() !== '') {
      return error.message.trim();
    }
    return fallback;
  }

  function initMagicRedirectScreens() {
    const roots = document.querySelectorAll('[data-sp-magic-redirect="1"]');
    roots.forEach((root) => {
      if (root.dataset.spMagicReady === '1') {
        return;
      }
      root.dataset.spMagicReady = '1';

      const card = root.querySelector('.sp-magic-redirect__card');
      if (!card) {
        return;
      }

      const token = getTokenFromUrl();
      let knownEmail = '';
      let knownDraftRef = '';
      let slowTimer = null;

      const clearSlowTimer = () => {
        if (slowTimer) {
          window.clearTimeout(slowTimer);
          slowTimer = null;
        }
      };

      const showTechnicalError = (message) => {
        clearSlowTimer();
        renderMagicMessage(
          card,
          getString('magicTechnicalTitle', 'Connexion temporairement indisponible'),
          message || getString('magicTechnicalBody', 'Merci de réessayer dans quelques instants.'),
          '',
          {
            error: true,
            icon: '!',
            actionsHtml: baseActionsHtml(true),
          }
        );
      };

      const showResendSuccess = () => {
        renderMagicMessage(
          card,
          getString('magicResendSuccessTitle', 'Lien de connexion envoyé'),
          getString('magicResendSuccessBody', 'Un nouveau lien vient de vous être envoyé. Vérifiez votre e-mail pour reprendre votre dossier.'),
          '',
          {
            icon: '✓',
            actionsHtml: baseActionsHtml(true),
          }
        );
      };

      const sendNewLink = async (email, draftRef) => {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!isEmailLike(normalizedEmail)) {
          showTechnicalError(getString('magicEmailInvalid', 'Merci de renseigner une adresse e-mail valide.'));
          return;
        }

        renderMagicLoading(
          card,
          getString('magicResendSending', 'Nouvel envoi en cours…'),
          getString('requestSendingBody', 'Nous préparons votre lien de connexion sécurisé.'),
          ''
        );

        try {
          if (String(draftRef || '').trim() && draftResendEndpoint) {
            await postJson(draftResendEndpoint, {
              draft_ref: String(draftRef).trim(),
              email: normalizedEmail,
            });
          } else {
            await postJson(requestLinkEndpoint, { email: normalizedEmail });
          }

          showResendSuccess();
        } catch (error) {
          renderMagicMessage(
            card,
            getString('magicResendErrorTitle', 'Envoi impossible'),
            extractErrorMessage(error, getString('magicResendErrorBody', 'Le nouveau lien n’a pas pu être envoyé pour le moment.')),
            '',
            {
              error: true,
              icon: '!',
              actionsHtml: buildInvalidActionsHtml(),
            }
          );
          bindInvalidActions();
        }
      };

      const showEmailCapture = () => {
        renderMagicMessage(
          card,
          getString('magicMissingEmailTitle', 'Adresse e-mail nécessaire'),
          getString('magicMissingEmailBody', 'Merci de saisir votre adresse e-mail pour recevoir un nouveau lien.'),
          '',
          {
            icon: '@',
            bodyHtml: buildEmailCaptureBodyHtml(),
          }
        );

        const emailInput = card.querySelector('[data-sp-magic-email-input="1"]');
        const submitButton = card.querySelector('[data-sp-magic-submit-email="1"]');
        const cancelButton = card.querySelector('[data-sp-magic-cancel-email="1"]');

        if (emailInput && knownEmail) {
          emailInput.value = knownEmail;
        }

        if (cancelButton) {
          cancelButton.addEventListener('click', () => {
            window.location.assign(toSafeString(redirects.default) || '/');
          });
        }

        if (submitButton) {
          submitButton.addEventListener('click', () => {
            const emailValue = emailInput ? String(emailInput.value || '').trim().toLowerCase() : '';
            knownEmail = emailValue;
            void sendNewLink(emailValue, knownDraftRef);
          });
        }
      };

      const bindInvalidActions = () => {
        const resendButton = card.querySelector('[data-sp-magic-resend="1"]');
        if (!resendButton) {
          return;
        }

        resendButton.addEventListener('click', () => {
          if (knownEmail) {
            void sendNewLink(knownEmail, knownDraftRef);
            return;
          }

          showEmailCapture();
        });
      };

      const showInvalidState = () => {
        renderMagicMessage(
          card,
          getString('magicInvalidTitle', 'Lien invalide'),
          getString('magicInvalidBody', 'Ce lien n’est plus valide ou a expiré. Vous pouvez demander un nouveau lien pour reprendre votre dossier.'),
          getString('magicInvalidHint', 'Le nouveau lien sera envoyé à la même adresse e-mail lorsqu’elle est disponible.'),
          {
            error: true,
            icon: '!',
            actionsHtml: buildInvalidActionsHtml(),
          }
        );
        bindInvalidActions();
      };

      if (!token) {
        showInvalidState();
        return;
      }

      slowTimer = window.setTimeout(() => {
        const hint = card.querySelector('.sp-magic-redirect__hint');
        if (hint) {
          hint.textContent = getString('magicSlowHint', 'Merci de patienter, la connexion sécurisée prend un peu plus de temps que prévu.');
        }
      }, 5000);

      verifyMagicLink(token)
        .then((payload) => {
          clearSlowTimer();

          if (payload && payload.valid === true) {
            renderMagicMessage(
              card,
              getString('verifySuccessTitle', 'Connexion établie'),
              getString('verifySuccessBody', 'Votre session sécurisée est prête. Redirection en cours…'),
              '',
              {
                icon: '✓',
              }
            );
            resetApplicationStorage();
            window.location.replace(resolveRedirectUrl(payload));
            return;
          }

          knownEmail = toSafeString(payload && payload.email).trim().toLowerCase();
          knownDraftRef = toSafeString(payload && payload.draft_ref).trim();
          showInvalidState();
        })
        .catch(() => {
          clearSlowTimer();
          showTechnicalError(getString('magicTechnicalBody', 'Merci de réessayer dans quelques instants.'));
        });
    });
  }

  function init() {
    if (!window.fetch) {
      return;
    }

    initRequestForms();
    initLegacyVerifyScreens();
    initMagicRedirectScreens();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
