/* SOS Prescription – Doctor Account (signature upload + RPPS verification, shell compliant) */

(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function normalizeDigits(value) {
    return String(value || '').replace(/\D+/g, '');
  }

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_err) {
      return null;
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 ko';
    if (!bytes) return '';
    var kb = bytes / 1024;
    if (kb < 1024) return Math.round(kb) + ' ko';
    var mb = kb / 1024;
    return (Math.round(mb * 10) / 10) + ' Mo';
  }

  function isAllowedType(file) {
    var allowed = ['image/png', 'image/jpeg'];
    if (file.type && allowed.indexOf(file.type) !== -1) return true;
    var name = (file.name || '').toLowerCase();
    return name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg');
  }

  function getDoctorAccountConfig() {
    var cfg = window.SOSPrescriptionDoctorAccount || window.SosPrescriptionDoctorAccount || null;
    if (!cfg || typeof cfg !== 'object') {
      return null;
    }
    return cfg;
  }

  function getVerifyStrings(config) {
    var strings = config && config.strings && typeof config.strings === 'object' ? config.strings : {};
    return {
      verifyLabel: normalizeString(strings.verifyLabel) || 'Vérifier',
      verifyingLabel: normalizeString(strings.verifyingLabel) || 'Vérification…',
      invalidLength: normalizeString(strings.invalidLength) || 'RPPS invalide : 11 chiffres requis.',
      successPrefix: normalizeString(strings.successPrefix) || 'Identité vérifiée : Dr. ',
      successUnknown: normalizeString(strings.successUnknown) || 'RPPS valide.',
      invalidLookup: normalizeString(strings.invalidLookup) || 'RPPS invalide ou introuvable.',
      serviceUnavailable: normalizeString(strings.serviceUnavailable) || 'Vérification RPPS temporairement indisponible.'
    };
  }

  function setAlert(node, variant, title, body) {
    if (!node) {
      return;
    }

    node.hidden = false;
    node.className = 'sp-alert sp-alert--' + variant;
    node.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    node.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
    node.innerHTML = '';

    var titleNode = document.createElement('p');
    titleNode.className = 'sp-alert__title';
    titleNode.textContent = normalizeString(title);

    var bodyNode = document.createElement('p');
    bodyNode.className = 'sp-alert__body';
    bodyNode.textContent = normalizeString(body);

    node.appendChild(titleNode);
    node.appendChild(bodyNode);
  }

  function clearAlert(node) {
    if (!node) {
      return;
    }
    node.hidden = true;
    node.className = 'sp-alert';
    node.setAttribute('role', 'status');
    node.textContent = '';
  }

  function buildVerifiedIdentityMessage(data, strings) {
    var firstName = normalizeString(data && (data.firstName || data.first_name));
    var lastName = normalizeString(data && (data.lastName || data.last_name));
    var profession = normalizeString(data && data.profession);
    var fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

    if (!fullName && !profession) {
      return strings.successUnknown;
    }

    var message = strings.successPrefix + (fullName || 'Professionnel identifié');
    if (profession) {
      message += ' (' + profession + ')';
    }
    return message;
  }

  function maybeHydrateDoctorFields(input, data) {
    if (!input || !data) return;

    var form = input.form || input.closest('form');
    if (!form || !form.querySelector) return;

    var profession = normalizeString(data.profession);
    var fullName = [
      normalizeString(data && (data.firstName || data.first_name)),
      normalizeString(data && (data.lastName || data.last_name))
    ].filter(Boolean).join(' ').trim();

    var specialtyInput = form.querySelector('#sp_doc_specialty, input[name="specialty"]');
    if (specialtyInput && specialtyInput.value != null && !normalizeString(specialtyInput.value) && profession) {
      specialtyInput.value = profession;
    }

    var displayNameInput = form.querySelector('#sp_doc_display_name, #sp_new_doc_name, input[name="display_name"]');
    if (displayNameInput && displayNameInput.value != null && !normalizeString(displayNameInput.value) && fullName) {
      displayNameInput.value = fullName;
    }
  }

  function initSignatureUpload() {
    var input = document.getElementById('signature_file');
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    var feedback = document.getElementById('sp_signature_feedback');
    var meta = document.getElementById('sp_signature_meta');
    var preview = document.getElementById('sp_signature_preview');
    var previewImg = document.getElementById('sp_signature_preview_img');
    var clearBtn = document.getElementById('sp_signature_clear');
    var currentObjectUrl = '';

    function revokeObjectUrl() {
      if (!currentObjectUrl) {
        return;
      }
      try {
        URL.revokeObjectURL(currentObjectUrl);
      } catch (_err) {
        // noop
      }
      currentObjectUrl = '';
    }

    function resetPreview() {
      revokeObjectUrl();
      clearAlert(feedback);
      if (meta) {
        meta.hidden = true;
        meta.textContent = '';
      }
      if (preview) {
        preview.hidden = true;
      }
      if (previewImg instanceof HTMLImageElement) {
        previewImg.removeAttribute('src');
      }
    }

    function updateMeta(file) {
      if (!meta) {
        return;
      }
      var message = 'Fichier prêt : ' + normalizeString(file.name || 'signature') + ' • ' + formatBytes(file.size);
      meta.textContent = message;
      meta.hidden = false;
    }

    function renderPreview(file) {
      if (!(preview instanceof HTMLElement) || !(previewImg instanceof HTMLImageElement)) {
        return;
      }
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        preview.hidden = true;
        return;
      }
      revokeObjectUrl();
      currentObjectUrl = URL.createObjectURL(file);
      previewImg.src = currentObjectUrl;
      preview.hidden = false;
    }

    function handleFile(file) {
      if (!file) {
        resetPreview();
        return;
      }

      if (!isAllowedType(file)) {
        input.value = '';
        resetPreview();
        setAlert(feedback, 'error', 'Fichier non supporté', 'Merci d’utiliser un fichier PNG ou JPG pour la signature.');
        return;
      }

      if (file.size > 1048576) {
        input.value = '';
        resetPreview();
        setAlert(feedback, 'error', 'Fichier trop volumineux', 'La taille maximale autorisée est de 1 Mo.');
        return;
      }

      updateMeta(file);
      renderPreview(file);
      setAlert(feedback, 'success', 'Signature prête', 'Le fichier sélectionné sera enregistré lors de la validation du formulaire.');
    }

    input.addEventListener('change', function () {
      if (!input.files || !input.files[0]) {
        resetPreview();
        return;
      }
      handleFile(input.files[0]);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        resetPreview();
      });
    }
  }

  function enhanceRppsField(input, config) {
    if (!input || input.dataset.spRppsEnhanced === '1') return;
    if (!config || !config.verifyRppsEndpoint || !config.restNonce || typeof window.fetch !== 'function') return;

    input.dataset.spRppsEnhanced = '1';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('maxlength', '11');
    input.setAttribute('autocomplete', 'off');

    var strings = getVerifyStrings(config);
    var field = input.closest('.sp-field');
    var actionsContainer = field ? field.querySelector('[data-sp-rpps-actions]') : null;
    var container = actionsContainer || field || input.parentNode;
    if (!container) {
      return;
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sp-button sp-button--secondary';
    button.textContent = strings.verifyLabel;
    button.setAttribute('aria-label', strings.verifyLabel);

    var feedback = document.createElement('div');
    feedback.className = 'sp-alert';
    feedback.hidden = true;
    feedback.setAttribute('aria-live', 'polite');
    feedback.setAttribute('role', 'status');
    if (input.id) {
      feedback.id = input.id + '_verify_feedback';
      button.setAttribute('aria-controls', feedback.id);
    }

    container.appendChild(button);
    container.appendChild(feedback);

    function setBusy(isBusy) {
      button.disabled = !!isBusy;
      button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
      button.textContent = isBusy ? strings.verifyingLabel : strings.verifyLabel;
    }

    input.addEventListener('input', function () {
      var digits = normalizeDigits(input.value);
      if (digits.length > 11) {
        digits = digits.slice(0, 11);
      }
      if (input.value !== digits) {
        input.value = digits;
      }
      clearAlert(feedback);
    });

    button.addEventListener('click', function () {
      var rpps = normalizeDigits(input.value);
      input.value = rpps;
      clearAlert(feedback);

      if (rpps.length !== 11) {
        setAlert(feedback, 'error', 'RPPS invalide', strings.invalidLength);
        return;
      }

      setBusy(true);

      fetch(config.verifyRppsEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
          'X-WP-Nonce': config.restNonce
        },
        body: JSON.stringify({ rpps: rpps })
      })
        .then(function (response) {
          return response.text().then(function (text) {
            return {
              ok: response.ok,
              status: response.status,
              data: safeJsonParse(text) || {}
            };
          });
        })
        .then(function (result) {
          var data = result.data || {};
          if (result.ok && data.valid === true) {
            maybeHydrateDoctorFields(input, data);
            setAlert(feedback, 'success', 'Identité vérifiée', buildVerifiedIdentityMessage(data, strings));
            return;
          }

          if (result.status >= 500) {
            setAlert(feedback, 'error', 'Service indisponible', strings.serviceUnavailable);
            return;
          }

          setAlert(feedback, 'error', 'RPPS introuvable', strings.invalidLookup);
        })
        .catch(function () {
          setAlert(feedback, 'error', 'Service indisponible', strings.serviceUnavailable);
        })
        .finally(function () {
          setBusy(false);
        });
    });
  }

  function initRppsVerification() {
    var config = getDoctorAccountConfig();
    if (!config) return;

    var inputs = document.querySelectorAll('input[name="rpps"]');
    if (!inputs || !inputs.length) return;

    Array.prototype.forEach.call(inputs, function (input) {
      enhanceRppsField(input, config);
    });
  }

  ready(function () {
    initSignatureUpload();
    initRppsVerification();
  });
})();
