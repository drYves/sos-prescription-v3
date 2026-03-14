// assets/form-posology-enhancements.js
(function () {
  'use strict';

  var ROOT_ID = 'sosprescription-root-form';
  var BLOCK_SELECTOR = '.rounded-xl.border.border-gray-200.p-4';
  var MAX_DAILY_TAKES = 6;
  var MAX_WEEKLY_TAKES = 12;
  var MAX_DURATION = 3650;
  var scheduled = false;

  function qsa(root, selector) {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }

  function text(node) {
    return String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function clampInt(value, min, max, fallback) {
    var number = parseInt(String(value == null ? '' : value), 10);
    if (!Number.isFinite(number)) {
      number = fallback;
    }
    if (number < min) number = min;
    if (number > max) number = max;
    return number;
  }

  function getRoot() {
    return document.getElementById(ROOT_ID);
  }

  function isPosologyBlock(block) {
    if (!block) return false;
    var content = text(block);
    if (content.indexOf('Frequence') === -1 && content.indexOf('Fréquence') === -1) {
      return false;
    }
    if (content.indexOf('Duree') === -1 && content.indexOf('Durée') === -1) {
      return false;
    }
    return qsa(block, 'input[type="number"]').length >= 2 && qsa(block, 'select').length >= 1;
  }

  function getControls(block) {
    var numberInputs = qsa(block, 'input[type="number"]');
    var selects = qsa(block, 'select');
    var rows = qsa(block, '.grid.grid-cols-1.gap-2.md\\:grid-cols-3').filter(function (row) {
      return !!row.querySelector('input[type="time"]') && !!row.querySelector('input[type="text"]');
    });

    return {
      countInput: numberInputs[0] || null,
      durationInput: numberInputs[1] || null,
      frequencySelect: selects[0] || null,
      durationUnitSelect: selects[1] || null,
      rows: rows,
      timeInputs: rows.map(function (row) { return row.querySelector('input[type="time"]'); }).filter(Boolean),
      doseInputs: rows.map(function (row) { return row.querySelector('input[type="text"]'); }).filter(Boolean)
    };
  }

  function frequencyOf(controls) {
    return controls.frequencySelect && controls.frequencySelect.value === 'semaine' ? 'semaine' : 'jour';
  }

  function maxCountFor(controls) {
    return frequencyOf(controls) === 'semaine' ? MAX_WEEKLY_TAKES : MAX_DAILY_TAKES;
  }

  function enhanceBlock(block) {
    if (!block) return;

    var controls = getControls(block);
    if (!controls.countInput || !controls.durationInput || !controls.frequencySelect) {
      return;
    }

    var maxCount = maxCountFor(controls);

    controls.countInput.setAttribute('min', '1');
    controls.countInput.setAttribute('max', String(maxCount));
    controls.countInput.setAttribute('step', '1');
    controls.countInput.setAttribute('inputmode', 'numeric');
    controls.countInput.setAttribute('aria-label', frequencyOf(controls) === 'semaine' ? 'Nombre de prises par semaine' : 'Nombre de prises par jour');

    controls.durationInput.setAttribute('min', '1');
    controls.durationInput.setAttribute('max', String(MAX_DURATION));
    controls.durationInput.setAttribute('step', '1');
    controls.durationInput.setAttribute('inputmode', 'numeric');
    controls.durationInput.setAttribute('aria-label', 'Durée du traitement');

    var rawDuration = String(controls.durationInput.value == null ? '' : controls.durationInput.value).trim();
    if (rawDuration !== '' && parseInt(rawDuration, 10) <= 0) {
      controls.durationInput.setCustomValidity('La durée doit être supérieure ou égale à 1.');
    } else {
      controls.durationInput.setCustomValidity('');
    }

    if (controls.frequencySelect) {
      controls.frequencySelect.setAttribute('aria-label', 'Fréquence de prise');
    }

    if (controls.durationUnitSelect) {
      controls.durationUnitSelect.setAttribute('aria-label', 'Unité de durée');
    }

    controls.timeInputs.forEach(function (input, index) {
      input.setAttribute('step', '300');
      input.setAttribute('aria-label', 'Horaire de prise ' + String(index + 1));
    });

    controls.doseInputs.forEach(function (input, index) {
      input.setAttribute('aria-label', 'Quantité pour la prise ' + String(index + 1));
      if (!input.getAttribute('placeholder')) {
        input.setAttribute('placeholder', 'Dose');
      }
    });
  }

  function scan() {
    scheduled = false;
    var root = getRoot();
    if (!root) return;

    qsa(root, BLOCK_SELECTOR).filter(isPosologyBlock).forEach(enhanceBlock);
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scan);
    } else {
      window.setTimeout(scan, 16);
    }
  }

  function onInput(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) return;

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) return;

    var controls = getControls(block);

    if (target === controls.durationInput) {
      var raw = String(target.value == null ? '' : target.value).trim();
      if (raw !== '' && parseInt(raw, 10) <= 0) {
        target.setCustomValidity('La durée doit être supérieure ou égale à 1.');
      } else {
        target.setCustomValidity('');
      }
    }

    if (target === controls.countInput) {
      var max = maxCountFor(controls);
      var value = String(target.value == null ? '' : target.value).trim();
      if (value !== '' && parseInt(value, 10) > max) {
        target.setCustomValidity('Valeur trop élevée pour cette fréquence.');
      } else if (value !== '' && parseInt(value, 10) <= 0) {
        target.setCustomValidity('La valeur doit être supérieure ou égale à 1.');
      } else {
        target.setCustomValidity('');
      }
    }

    scheduleScan();
  }

  function onBlur(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) return;

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) return;

    var controls = getControls(block);

    if (target === controls.countInput) {
      var max = maxCountFor(controls);
      var normalized = clampInt(target.value, 1, max, 1);
      if (String(target.value).trim() === '' || parseInt(target.value, 10) !== normalized) {
        target.value = String(normalized);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    if (target === controls.durationInput) {
      var normalizedDuration = clampInt(target.value, 1, MAX_DURATION, 1);
      if (String(target.value).trim() === '' || parseInt(target.value, 10) !== normalizedDuration) {
        target.value = String(normalizedDuration);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    scheduleScan();
  }

  function boot() {
    var root = getRoot();
    if (!root) return;

    scan();
    document.addEventListener('focusin', scheduleScan, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', scheduleScan, true);
    document.addEventListener('blur', onBlur, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
