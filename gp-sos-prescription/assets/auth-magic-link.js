(function () {
  'use strict';

  var config = window.SOSPrescriptionAuthMagicLink || {};
  var strings = config.strings || {};
  var REQUEST_FORM_SELECTOR = '[data-sp-auth-request-form="1"]';
  var VERIFY_ROOT_SELECTOR = '[data-sp-auth-verify="1"]';

  function text(key, fallback) {
    return typeof strings[key] === 'string' && strings[key].trim() !== '' ? strings[key] : fallback;
  }

  function endpoint(name) {
    var value = config[name];
    return typeof value === 'string' ? value : '';
  }

  function getRedirectUrl(role) {
    var redirects = config.redirects || {};
    if (role === 'doctor' && typeof redirects.doctor === 'string' && redirects.doctor) {
      return redirects.doctor;
    }
    if (role === 'patient' && typeof redirects.patient === 'string' && redirects.patient) {
      return redirects.patient;
    }
    if (typeof redirects.default === 'string' && redirects.default) {
      return redirects.default;
    }
    return '/';
  }

  function setFeedback(node, tone, title, body) {
    if (!node) {
      return;
    }

    node.className = 'sp-alert sp-alert--' + tone;
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    node.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    node.setAttribute('tabindex', '-1');
    node.innerHTML = '';

    var titleNode = document.createElement('p');
    titleNode.className = 'sp-alert__title';
    titleNode.textContent = title;

    var bodyNode = document.createElement('p');
    bodyNode.className = 'sp-alert__body';
    bodyNode.textContent = body;

    node.appendChild(titleNode);
    node.appendChild(bodyNode);
  }

  function buildRequestSuccessBody(email) {
    var body = text('requestSuccessBody', 'Un lien de connexion vous a été envoyé par e-mail.');
    var trimmedEmail = typeof email === 'string' ? email.trim() : '';

    if (trimmedEmail) {
      body += ' Adresse utilisée : ' + trimmedEmail + '.';
    }

    if (body.indexOf('courriers indésirables') === -1) {
      body += ' Vérifiez également vos courriers indésirables.';
    }

    return body;
  }

  async function postJson(url, payload) {
    var response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(payload || {})
    });

    var data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    if (!response.ok) {
      var error = new Error(data && typeof data.message === 'string' && data.message ? data.message : 'request_failed');
      error.payload = data;
      error.status = response.status;
      throw error;
    }

    return data || {};
  }

  function bindRequestForms() {
    var forms = document.querySelectorAll(REQUEST_FORM_SELECTOR);
    if (!forms.length) {
      return;
    }

    var requestEndpoint = endpoint('requestLinkEndpoint');
    if (!requestEndpoint) {
      return;
    }

    forms.forEach(function (form) {
      if (!(form instanceof HTMLFormElement) || form.dataset.spAuthBound === '1') {
        return;
      }
      form.dataset.spAuthBound = '1';

      var emailInput = form.querySelector('input[name="email"]');
      var submitButton = form.querySelector('[data-sp-auth-submit="1"]');
      var feedback = form.parentElement ? form.parentElement.querySelector('[data-sp-auth-feedback]') : null;
      var submitLabel = submitButton ? submitButton.textContent : '';

      form.addEventListener('submit', function (event) {
        event.preventDefault();

        var email = emailInput && typeof emailInput.value === 'string' ? emailInput.value.trim() : '';
        if (!email) {
          setFeedback(
            feedback,
            'error',
            text('requestErrorTitle', 'Envoi impossible'),
            'Adresse e-mail invalide.'
          );
          if (emailInput && typeof emailInput.focus === 'function') {
            emailInput.focus();
          }
          return;
        }

        if (submitButton) {
          submitButton.disabled = true;
          submitButton.textContent = text('submitLabelBusy', 'Envoi…');
        }

        setFeedback(
          feedback,
          'info',
          text('requestSendingTitle', 'Envoi en cours…'),
          text('requestSendingBody', 'Nous préparons votre lien de connexion sécurisé.')
        );

        postJson(requestEndpoint, { email: email })
          .then(function (payload) {
            if (payload && payload.ok === true) {
              setFeedback(
                feedback,
                'success',
                text('requestSuccessTitle', 'Lien de connexion envoyé'),
                buildRequestSuccessBody(email)
              );
              form.reset();
              return;
            }

            throw new Error(payload && typeof payload.message === 'string' && payload.message ? payload.message : text('requestErrorBody', 'Le lien de connexion n’a pas pu être envoyé pour le moment.'));
          })
          .catch(function (err) {
            setFeedback(
              feedback,
              'error',
              text('requestErrorTitle', 'Envoi impossible'),
              err && typeof err.message === 'string' && err.message ? err.message : text('requestErrorBody', 'Le lien de connexion n’a pas pu être envoyé pour le moment.')
            );
          })
          .finally(function () {
            if (submitButton) {
              submitButton.disabled = false;
              submitButton.textContent = submitLabel || 'Recevoir un lien de connexion';
            }
          });
      });
    });
  }

  function bindVerifyScreens() {
    var roots = document.querySelectorAll(VERIFY_ROOT_SELECTOR);
    if (!roots.length) {
      return;
    }

    var verifyEndpoint = endpoint('verifyLinkEndpoint');
    if (!verifyEndpoint) {
      return;
    }

    var search = new URLSearchParams(window.location.search || '');
    var token = (search.get('token') || '').trim();

    roots.forEach(function (root) {
      if (!(root instanceof HTMLElement) || root.dataset.spAuthBound === '1') {
        return;
      }
      root.dataset.spAuthBound = '1';

      var feedback = root.querySelector('[data-sp-auth-feedback]');

      if (!token) {
        setFeedback(
          feedback,
          'error',
          text('missingTokenTitle', 'Lien incomplet'),
          text('missingTokenBody', 'Le token de connexion est manquant dans l’URL.')
        );
        return;
      }

      setFeedback(
        feedback,
        'info',
        text('verifyLoadingTitle', 'Vérification du lien'),
        text('verifyLoadingBody', 'Connexion sécurisée en cours…')
      );

      postJson(verifyEndpoint, { token: token })
        .then(function (payload) {
          if (payload && payload.ok === true && payload.valid === true) {
            setFeedback(
              feedback,
              'success',
              text('verifySuccessTitle', 'Connexion établie'),
              text('verifySuccessBody', 'Votre session sécurisée est prête. Redirection en cours…')
            );

            window.setTimeout(function () {
              window.location.assign(getRedirectUrl(payload.role || ''));
            }, 700);
            return;
          }

          setFeedback(
            feedback,
            'error',
            text('verifyInvalidTitle', 'Lien invalide ou expiré'),
            payload && typeof payload.message === 'string' && payload.message ? payload.message : text('verifyInvalidBody', 'Le lien de connexion est invalide, expiré ou déjà utilisé.')
          );
        })
        .catch(function (err) {
          setFeedback(
            feedback,
            'error',
            text('verifyErrorTitle', 'Vérification impossible'),
            err && typeof err.message === 'string' && err.message ? err.message : text('verifyErrorBody', 'La connexion sécurisée est temporairement indisponible.')
          );
        });
    });
  }

  function boot() {
    bindRequestForms();
    bindVerifyScreens();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
