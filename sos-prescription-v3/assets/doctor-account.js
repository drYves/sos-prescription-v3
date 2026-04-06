/* SOS Prescription – Doctor Account (Signature upload UX + RPPS verification) */

(function () {
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
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
      invalidLength: normalizeString(strings.invalidLength) || '❌ RPPS invalide : 11 chiffres requis.',
      successPrefix: normalizeString(strings.successPrefix) || '✅ Identité vérifiée : Dr. ',
      successUnknown: normalizeString(strings.successUnknown) || '✅ RPPS valide.',
      invalidLookup: normalizeString(strings.invalidLookup) || '❌ RPPS invalide ou introuvable.',
      serviceUnavailable: normalizeString(strings.serviceUnavailable) || '❌ Vérification RPPS temporairement indisponible.'
    };
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

  function setFeedback(feedback, variant, message) {
    if (!feedback) return;
    feedback.hidden = false;
    feedback.className = 'sp-alert';
    if (variant === 'success') {
      feedback.classList.add('sp-alert--success');
      feedback.setAttribute('role', 'status');
    } else if (variant === 'error') {
      feedback.classList.add('sp-alert--error');
      feedback.setAttribute('role', 'alert');
    } else {
      feedback.classList.add('sp-alert--info');
      feedback.setAttribute('role', 'status');
    }
    feedback.textContent = normalizeString(message);
  }

  function clearFeedback(feedback) {
    if (!feedback) return;
    feedback.hidden = true;
    feedback.textContent = '';
    feedback.className = 'sp-alert';
    feedback.setAttribute('role', 'status');
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
    if (!input) return;

    var label = document.getElementById('sp_signature_label');
    var labelMain = document.getElementById('sp_signature_label_text');
    var errorEl = document.getElementById('sp_signature_error');
    var metaEl = document.getElementById('sp_signature_meta');
    var previewWrap = document.getElementById('sp_signature_preview');
    var previewImg = document.getElementById('sp_signature_preview_img');
    var clearBtn = document.getElementById('sp_signature_clear');

    if (!label || !labelMain || !errorEl || !metaEl || !previewWrap || !previewImg) return;

    var DEFAULT_TEXT = 'Cliquez ou glissez-déposez votre signature (PNG/JPG)';

    function clearError() {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
      label.classList.remove('error');
    }

    function clearMeta() {
      metaEl.textContent = '';
      metaEl.style.display = 'none';
    }

    function setMeta(infoText, warningText) {
      metaEl.innerHTML = '';
      metaEl.appendChild(document.createTextNode(infoText || ''));
      if (warningText) {
        var warn = document.createElement('span');
        warn.className = 'sp-warn';
        warn.textContent = warningText;
        metaEl.appendChild(warn);
      }
      metaEl.style.display = 'block';
    }

    function setError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      label.classList.remove('success');
      label.classList.add('error');
      labelMain.textContent = DEFAULT_TEXT;

      clearMeta();

      previewWrap.style.display = 'none';
      previewImg.removeAttribute('src');

      if (clearBtn) clearBtn.style.display = 'none';
    }

    function setSuccess(fileName) {
      clearError();
      label.classList.remove('error');
      label.classList.add('success');
      labelMain.textContent = '✅ ' + (fileName || 'signature') + ' prêt à être envoyé';
    }

    function resetToDefault() {
      clearError();
      clearMeta();
      label.classList.remove('success');
      label.classList.remove('error');
      labelMain.textContent = DEFAULT_TEXT;

      previewWrap.style.display = 'none';
      previewImg.removeAttribute('src');

      if (clearBtn) clearBtn.style.display = 'none';
    }

    function analyzeDimensions(file) {
      try {
        var url = URL.createObjectURL(file);
        var img = new Image();

        img.onload = function () {
          var w = img.naturalWidth || img.width || 0;
          var h = img.naturalHeight || img.height || 0;
          try { URL.revokeObjectURL(url); } catch (_) {}

          if (!w || !h) return;

          var ratio = w / h;
          var warning = '';
          if (h > 300 || ratio < 2.0) {
            warning = '⚠️ Signature très haute : privilégiez un format horizontal (ex: 800×200 px).';
          } else if (w < 400) {
            warning = '⚠️ Image petite : recommandé ≥ 600 px de large pour une signature nette.';
          }

          var typeLabel = (file.type || '').replace('image/', '').toUpperCase();
          if (!typeLabel) typeLabel = 'IMAGE';
          var info = 'Type : ' + typeLabel + ' • Taille : ' + formatBytes(file.size) + ' • Dimensions : ' + w + '×' + h + ' px';

          setMeta(info, warning);
        };

        img.onerror = function () {
          try { URL.revokeObjectURL(url); } catch (_) {}
        };

        img.src = url;
      } catch (_e) {
        // Best effort only.
      }
    }

    function renderPreview(file) {
      try {
        var reader = new FileReader();

        reader.onload = function (e) {
          try {
            previewImg.src = e.target && e.target.result ? e.target.result : '';
            previewWrap.style.display = previewImg.src ? 'block' : 'none';
          } catch (_err) {
            previewWrap.style.display = 'none';
          }
        };

        reader.onerror = function () {
          previewWrap.style.display = 'none';
        };

        reader.readAsDataURL(file);
      } catch (_e) {
        previewWrap.style.display = 'none';
      }
    }

    function handleFile(file) {
      if (!file) {
        resetToDefault();
        return;
      }

      if (!isAllowedType(file)) {
        input.value = '';
        setError('⛔ Format non supporté. Merci d\'utiliser JPG ou PNG uniquement.');
        return;
      }

      if (file.size > 1048576) {
        input.value = '';
        setError('⚠️ Fichier trop lourd. La limite est de 1 Mo (Recommandé : < 200ko).');
        return;
      }

      setSuccess(file.name || 'signature');

      var typeLabel = (file.type || '').replace('image/', '').toUpperCase();
      if (!typeLabel) typeLabel = 'IMAGE';
      setMeta('Type : ' + typeLabel + ' • Taille : ' + formatBytes(file.size), '');

      analyzeDimensions(file);
      renderPreview(file);

      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }

    function tryAttachFileFromDrop(file) {
      try {
        if (typeof DataTransfer !== 'undefined') {
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
        } else {
          return false;
        }
      } catch (_e) {
        return false;
      }

      try {
        return !!(input.files && input.files[0] && input.files[0].name === file.name && input.files[0].size === file.size);
      } catch (_err) {
        return false;
      }
    }

    input.addEventListener('change', function () {
      if (!input.files || !input.files[0]) {
        resetToDefault();
        return;
      }
      handleFile(input.files[0]);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        resetToDefault();
      });
    }

    label.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      label.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        label.classList.add('dragover');
      });
    });

    ['dragleave', 'dragend'].forEach(function (evt) {
      label.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        label.classList.remove('dragover');
      });
    });

    label.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      label.classList.remove('dragover');

      var dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files[0]) return;

      var file = dt.files[0];

      if (!tryAttachFileFromDrop(file)) {
        setError('⚠️ Glisser-déposer non supporté par votre navigateur. Cliquez pour choisir le fichier.');
        return;
      }

      handleFile(file);
    });
  }

  function enhanceRppsField(input, config) {
    if (!input || input.dataset.spRppsEnhanced === '1') return;
    if (!config || !config.verifyRppsEndpoint || !config.restNonce || typeof window.fetch !== 'function') return;

    input.dataset.spRppsEnhanced = '1';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('maxlength', '11');
    input.setAttribute('autocomplete', 'off');

    var strings = getVerifyStrings(config);
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

    input.insertAdjacentText('afterend', ' ');
    input.insertAdjacentElement('afterend', button);
    button.insertAdjacentElement('afterend', feedback);

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
      clearFeedback(feedback);
    });

    button.addEventListener('click', function () {
      var rpps = normalizeDigits(input.value);
      input.value = rpps;
      clearFeedback(feedback);

      if (rpps.length !== 11) {
        setFeedback(feedback, 'error', strings.invalidLength);
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
            setFeedback(feedback, 'success', buildVerifiedIdentityMessage(data, strings));
            return;
          }

          if (result.status >= 500) {
            setFeedback(feedback, 'error', strings.serviceUnavailable);
            return;
          }

          setFeedback(feedback, 'error', strings.invalidLookup);
        })
        .catch(function () {
          setFeedback(feedback, 'error', strings.serviceUnavailable);
        })
        .finally(function () {
          setBusy(false);
        });
    });
  }

  function initAccountDeletion() {
    var config = getDoctorAccountConfig();
    var button = document.getElementById('sp-delete-account-btn');
    var feedback = document.getElementById('sp-delete-account-feedback');
    if (!button || !config || !config.deleteAccountEndpoint || !config.restNonce || typeof window.fetch !== 'function') return;

    var deleteConfirm = normalizeString(config.strings && config.strings.deleteAccountConfirm) || "Action irréversible. Votre accès sera immédiatement détruit et vous ne pourrez plus vous connecter. Vos données médicales strictement nécessaires seront conservées sous forme d'archives inactives pour répondre aux obligations légales de traçabilité. Confirmer la suppression ?";
    var busyLabel = normalizeString(config.strings && config.strings.deleteAccountBusy) || 'Suppression…';
    var errorLabel = normalizeString(config.strings && config.strings.deleteAccountError) || 'La suppression du compte a échoué. Merci de réessayer.';
    var originalLabel = normalizeString(button.textContent) || 'Supprimer mon compte';

    function setBusy(isBusy) {
      button.disabled = !!isBusy;
      button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
      button.textContent = isBusy ? busyLabel : originalLabel;
    }

    button.addEventListener('click', function () {
      clearFeedback(feedback);

      if (!window.confirm(deleteConfirm)) {
        return;
      }

      setBusy(true);
      fetch(config.deleteAccountEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
          'X-WP-Nonce': config.restNonce
        },
        body: JSON.stringify({})
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
          if (result.ok && data.ok === true && data.deleted === true) {
            setFeedback(feedback, 'success', 'Compte supprimé. Redirection…');
            window.location.assign('/');
            return;
          }

          var message = normalizeString(data.message || '') || errorLabel;
          setFeedback(feedback, 'error', message);
        })
        .catch(function () {
          setFeedback(feedback, 'error', errorLabel);
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
    initAccountDeletion();
  });
})();
