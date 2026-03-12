/* SOS Prescription – Doctor Account (Signature upload UX Premium) */

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
    // Fallback: check extension.
    var name = (file.name || '').toLowerCase();
    return name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg');
  }

  ready(function () {
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
      // Safe rendering (no innerHTML)
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

          // Simple “premium” guidance, non blocking.
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
          // Best effort only: keep previous meta
        };

        img.src = url;
      } catch (e) {
        // Best effort only
      }
    }

    function renderPreview(file) {
      try {
        var reader = new FileReader();

        reader.onload = function (e) {
          try {
            previewImg.src = e.target && e.target.result ? e.target.result : '';
            previewWrap.style.display = previewImg.src ? 'block' : 'none';
          } catch (err) {
            previewWrap.style.display = 'none';
          }
        };

        reader.onerror = function () {
          previewWrap.style.display = 'none';
        };

        reader.readAsDataURL(file);
      } catch (e) {
        previewWrap.style.display = 'none';
      }
    }

    function handleFile(file) {
      if (!file) {
        resetToDefault();
        return;
      }

      // A) Bad format
      if (!isAllowedType(file)) {
        input.value = '';
        setError('⛔ Format non supporté. Merci d\'utiliser JPG ou PNG uniquement.');
        return;
      }

      // B) Too heavy (> 1MB)
      if (file.size > 1048576) {
        input.value = '';
        setError('⚠️ Fichier trop lourd. La limite est de 1 Mo (Recommandé : < 200ko).');
        return;
      }

      // C) Success
      setSuccess(file.name || 'signature');

      // Initial meta (will be enriched with dimensions async)
      var typeLabel = (file.type || '').replace('image/', '').toUpperCase();
      if (!typeLabel) typeLabel = 'IMAGE';
      setMeta('Type : ' + typeLabel + ' • Taille : ' + formatBytes(file.size), '');

      analyzeDimensions(file);
      renderPreview(file);

      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }

    function tryAttachFileFromDrop(file) {
      // Try to attach dropped file to the real input so the form submit works.
      try {
        if (typeof DataTransfer !== 'undefined') {
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
        } else {
          return false;
        }
      } catch (e) {
        return false;
      }

      try {
        return !!(input.files && input.files[0] && input.files[0].name === file.name && input.files[0].size === file.size);
      } catch (_) {
        return false;
      }
    }

    // Input change (click picker)
    input.addEventListener('change', function () {
      if (!input.files || !input.files[0]) {
        resetToDefault();
        return;
      }
      handleFile(input.files[0]);
    });

    // Clear selection
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        resetToDefault();
      });
    }

    // Keyboard support on label (accessibility)
    label.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    // Drag & Drop support
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
  });
})();
