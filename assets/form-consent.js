/* global SosPrescription */
(function () {
  try {
    if (window.__sosPrescriptionConsentPatched) return;
    window.__sosPrescriptionConsentPatched = true;

    var cfg = (window.SosPrescription && window.SosPrescription.compliance) ? window.SosPrescription.compliance : {};
    var required = !!cfg.consent_required;

    function getBox() {
      return document.getElementById('sosprescription-consent-box');
    }

    function readCheckbox(id) {
      var el = document.getElementById(id);
      return !!(el && el.checked);
    }

    function getState() {
      return {
        telemedicine: readCheckbox('sp-consent-medical'),
        truth: readCheckbox('sp-consent-truth'),
        cgu: readCheckbox('sp-consent-cgu'),
        privacy: readCheckbox('sp-consent-privacy')
      };
    }

    function isOk(state) {
      return !!(state.telemedicine && state.truth && state.cgu && state.privacy);
    }

    function flashError() {
      var box = getBox();
      if (box) {
        box.classList.add('sp-consent-error');
        try {
          box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {
          // ignore
        }
        window.setTimeout(function () {
          box.classList.remove('sp-consent-error');
        }, 4500);
      } else {
        window.alert('Vous devez accepter les consentements requis avant de soumettre.');
      }
    }

    window.addEventListener('sosprescription_consent_required', flashError);

    if (!window.fetch) return;

    var origFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
      try {
        var url = '';
        var method = 'GET';

        if (typeof input === 'string') {
          url = input;
        } else if (input && input.url) {
          url = input.url;
          method = input.method || method;
        }

        if (init && init.method) {
          method = init.method;
        }

        method = (method || 'GET').toUpperCase();

        // Intercept uniquement la création de prescription.
        if (method === 'POST' && url && url.indexOf('/sosprescription/v1/prescriptions') !== -1) {
          var state = getState();

          if (required && !isOk(state)) {
            window.setTimeout(function () {
              try {
                window.dispatchEvent(new Event('sosprescription_consent_required'));
              } catch (e) {
                // ignore
              }
            }, 0);

            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: 'sosprescription_consent_required',
                  message: 'Vous devez cocher toutes les cases de consentement avant de soumettre la demande.'
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
              )
            );
          }

          // Injecte les consentements dans le body JSON.
          if (init && typeof init.body === 'string' && init.body.length > 0) {
            try {
              var obj = JSON.parse(init.body);
              obj.consent = {
                telemedicine: !!state.telemedicine,
                truth: !!state.truth,
                cgu: !!state.cgu,
                privacy: !!state.privacy,
                timestamp: (new Date()).toISOString(),
                cgu_version: cfg.cgu_version || '',
                privacy_version: cfg.privacy_version || ''
              };
              init = Object.assign({}, init, { body: JSON.stringify(obj) });
            } catch (e) {
              // ignore
            }
          }
        }
      } catch (e) {
        // ignore
      }

      return origFetch(input, init);
    };
  } catch (e) {
    // silent
  }
})();
