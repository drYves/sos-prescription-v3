(() => {
  const cfg = window.SOSPrescriptionAuthMagicLink || {};
  const strings = cfg.strings || {};
  const redirects = cfg.redirects || {};

  function text(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  }

  function setFeedback(node, title, body, variant) {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    node.classList.remove('sp-alert--info', 'sp-alert--success', 'sp-alert--warning', 'sp-alert--error');
    node.classList.add(`sp-alert--${variant || 'info'}`);

    const titleNode = node.querySelector('.sp-alert__title');
    const bodyNode = node.querySelector('.sp-alert__body');

    if (titleNode) {
      titleNode.textContent = title;
    }
    if (bodyNode) {
      bodyNode.textContent = body;
    }
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload || {}),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_err) {
      data = null;
    }

    if (!response.ok) {
      const message = data && typeof data.message === 'string' ? data.message : 'Erreur de connexion.';
      throw new Error(message);
    }

    return data || {};
  }

  function bindRequestForms() {
    const forms = document.querySelectorAll('[data-sp-auth-request-form="1"]');
    forms.forEach((form) => {
      if (!(form instanceof HTMLFormElement) || form.dataset.spBound === '1') {
        return;
      }

      form.dataset.spBound = '1';
      const submitButton = form.querySelector('[data-sp-auth-submit="1"]');
      const feedback = form.parentElement ? form.parentElement.querySelector('[data-sp-auth-feedback]') : null;
      const emailInput = form.querySelector('input[name="email"]');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const email = emailInput instanceof HTMLInputElement ? emailInput.value.trim() : '';
        if (!email) {
          setFeedback(
            feedback,
            text(strings.requestErrorTitle, 'Envoi impossible'),
            'Merci de renseigner une adresse e-mail valide.',
            'error',
          );
          return;
        }

        if (submitButton instanceof HTMLButtonElement) {
          submitButton.disabled = true;
          submitButton.dataset.originalLabel = submitButton.textContent || '';
          submitButton.textContent = text(strings.submitLabelBusy, 'Envoi…');
        }

        setFeedback(
          feedback,
          text(strings.requestSendingTitle, 'Envoi en cours…'),
          text(strings.requestSendingBody, 'Nous préparons votre lien de connexion sécurisé.'),
          'info',
        );

        try {
          await postJson(cfg.requestLinkEndpoint, { email });
          setFeedback(
            feedback,
            text(strings.requestSuccessTitle, 'Lien de connexion envoyé'),
            text(strings.requestSuccessBody, 'Un lien de connexion vous a été envoyé par e-mail.'),
            'success',
          );
        } catch (error) {
          setFeedback(
            feedback,
            text(strings.requestErrorTitle, 'Envoi impossible'),
            error instanceof Error && error.message ? error.message : text(strings.requestErrorBody, 'Le lien de connexion n’a pas pu être envoyé pour le moment.'),
            'error',
          );
        } finally {
          if (submitButton instanceof HTMLButtonElement) {
            submitButton.disabled = false;
            submitButton.textContent = submitButton.dataset.originalLabel || submitButton.textContent || 'Recevoir un lien de connexion';
          }
        }
      });
    });
  }

  async function bindVerifyScreen() {
    const verifyRoot = document.querySelector('[data-sp-auth-verify="1"]');
    if (!(verifyRoot instanceof HTMLElement) || verifyRoot.dataset.spBound === '1') {
      return;
    }

    verifyRoot.dataset.spBound = '1';
    const feedback = verifyRoot.querySelector('[data-sp-auth-feedback="verify"]');
    const params = new URLSearchParams(window.location.search);
    const token = (params.get('token') || '').trim();

    if (!token) {
      setFeedback(
        feedback,
        text(strings.missingTokenTitle, 'Lien incomplet'),
        text(strings.missingTokenBody, 'Le token de connexion est manquant dans l’URL.'),
        'error',
      );
      return;
    }

    setFeedback(
      feedback,
      text(strings.verifyLoadingTitle, 'Vérification du lien'),
      text(strings.verifyLoadingBody, 'Connexion sécurisée en cours…'),
      'info',
    );

    try {
      const payload = await postJson(cfg.verifyLinkEndpoint, { token });
      if (!payload || payload.valid !== true) {
        setFeedback(
          feedback,
          text(strings.verifyInvalidTitle, 'Lien invalide ou expiré'),
          text(strings.verifyInvalidBody, 'Le lien de connexion est invalide, expiré ou déjà utilisé.'),
          'error',
        );
        return;
      }

      setFeedback(
        feedback,
        text(strings.verifySuccessTitle, 'Connexion établie'),
        text(strings.verifySuccessBody, 'Votre session sécurisée est prête. Redirection en cours…'),
        'success',
      );

      const target = (typeof payload.redirect_to === 'string' && payload.redirect_to.trim() !== '')
        ? payload.redirect_to.trim()
        : (typeof redirects[payload.role] === 'string' && redirects[payload.role].trim() !== ''
          ? redirects[payload.role].trim()
          : text(redirects.default, '/'));

      window.setTimeout(() => {
        window.location.assign(target);
      }, 300);
    } catch (_error) {
      setFeedback(
        feedback,
        text(strings.verifyErrorTitle, 'Vérification impossible'),
        text(strings.verifyErrorBody, 'La connexion sécurisée est temporairement indisponible.'),
        'error',
      );
    }
  }

  function boot() {
    bindRequestForms();
    void bindVerifyScreen();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
