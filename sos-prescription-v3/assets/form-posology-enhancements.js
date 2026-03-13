// assets/form-posology-enhancements.js
(function () {
  'use strict';

  var ROOT_ID = 'sosprescription-root-form';
  var BLOCK_SELECTOR = '.rounded-xl.border.border-gray-200.p-4';
  var timers = new WeakMap();

  var PRESET_TIMES = {
    1: ['08:00'],
    2: ['08:00', '20:00'],
    3: ['08:00', '12:00', '20:00'],
    4: ['08:00', '12:00', '16:00', '20:00'],
    5: ['08:00', '11:00', '14:00', '17:00', '20:00'],
    6: ['08:00', '10:30', '13:00', '15:30', '18:00', '20:30']
  };

  function qsa(root, selector) {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }

  function clampInt(value, min, max, fallback) {
    var number = parseInt(String(value == null ? '' : value), 10);
    if (!Number.isFinite(number)) {
      number = fallback;
    }
    number = Math.max(min, number);
    number = Math.min(max, number);
    return number;
  }

  function text(node) {
    return String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function isPosologyBlock(block) {
    if (!block) {
      return false;
    }

    var content = text(block);
    if (content.indexOf('Fréquence') === -1 || content.indexOf('Durée') === -1) {
      return false;
    }

    var hasCountInput = qsa(block, 'input[type="number"]').length >= 2;
    var hasFrequencySelect = qsa(block, 'select').length >= 1;

    return hasCountInput && hasFrequencySelect;
  }

  function findBlocks(root) {
    return qsa(root, BLOCK_SELECTOR).filter(isPosologyBlock);
  }

  function getControls(block) {
    var numberInputs = qsa(block, 'input[type="number"]');
    var selects = qsa(block, 'select');
    var timeInputs = qsa(block, 'input[type="time"]');
    var textInputs = qsa(block, 'input[type="text"]');
    var buttons = qsa(block, 'button');

    return {
      countInput: numberInputs[0] || null,
      durationInput: numberInputs[1] || null,
      frequencySelect: selects[0] || null,
      durationUnitSelect: selects[1] || null,
      timeInputs: timeInputs,
      doseInputs: textInputs,
      buttons: buttons,
      resetButton: buttons.find(function (button) {
        var label = text(button);
        return label.indexOf('Réinitialiser horaires recommandés') !== -1 || label.indexOf('Horaires auto') !== -1;
      }) || null
    };
  }

  function isAutoMode(block) {
    return qsa(block, 'button').some(function (button) {
      return text(button).indexOf('Réinitialiser horaires recommandés') !== -1;
    });
  }

  function setNativeValue(element, value) {
    var prototype = Object.getPrototypeOf(element);
    var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchValueUpdate(element, value) {
    if (!element) {
      return;
    }

    setNativeValue(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function recommendedTimes(count) {
    var safeCount = clampInt(count, 1, 6, 1);
    if (PRESET_TIMES[safeCount]) {
      return PRESET_TIMES[safeCount].slice();
    }

    return PRESET_TIMES[1].slice();
  }

  function ensureTopHelper(block) {
    if (block.querySelector('[data-sp-posology-helper="1"]')) {
      return;
    }

    var controls = getControls(block);
    if (!controls.countInput || !controls.frequencySelect) {
      return;
    }

    var grid = controls.countInput.closest('.grid');
    if (!grid) {
      return;
    }

    var helper = document.createElement('div');
    helper.setAttribute('data-sp-posology-helper', '1');
    helper.className = 'mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900';
    helper.textContent = 'La fréquence indique le nombre de prises par jour ou par semaine. La quantité à prendre à chaque prise se renseigne plus bas, pour chaque horaire.';

    grid.insertAdjacentElement('afterend', helper);
  }

  function ensureTopLabels(block) {
    var labelNodes = qsa(block, 'div.text-sm.font-medium.text-gray-900');
    if (labelNodes[0]) {
      labelNodes[0].textContent = 'Prises par période';
    }
    if (labelNodes[1]) {
      labelNodes[1].textContent = 'Fréquence';
    }
    if (labelNodes[2]) {
      labelNodes[2].textContent = 'Durée du traitement';
    }

    var controls = getControls(block);
    if (controls.countInput) {
      controls.countInput.setAttribute('aria-label', 'Nombre de prises par période');
      controls.countInput.setAttribute('min', '1');
      controls.countInput.setAttribute('step', '1');
      controls.countInput.setAttribute('inputmode', 'numeric');
      controls.countInput.setAttribute('title', 'Nombre de prises par jour ou par semaine');
    }

    if (controls.durationInput) {
      controls.durationInput.setAttribute('aria-label', 'Durée du traitement');
      controls.durationInput.setAttribute('min', '1');
      controls.durationInput.setAttribute('step', '1');
      controls.durationInput.setAttribute('inputmode', 'numeric');
    }

    if (controls.durationUnitSelect) {
      controls.durationUnitSelect.setAttribute('aria-label', 'Unité de durée');
    }

    if (controls.frequencySelect) {
      controls.frequencySelect.setAttribute('aria-label', 'Fréquence de prise');
    }
  }

  function ensureRowLabels(block) {
    var rows = qsa(block, '.grid.grid-cols-1.gap-2.md\\:grid-cols-3').filter(function (row) {
      return !!row.querySelector('input[type="time"]') && !!row.querySelector('input[type="text"]');
    });

    rows.forEach(function (row) {
      var timeInput = row.querySelector('input[type="time"]');
      var doseInput = row.querySelector('input[type="text"]');
      if (!timeInput || !doseInput) {
        return;
      }

      var timeCell = timeInput.parentElement;
      var doseCell = doseInput.parentElement;

      if (timeCell && !timeCell.querySelector('[data-sp-field-label="time"]')) {
        var timeLabel = document.createElement('div');
        timeLabel.setAttribute('data-sp-field-label', 'time');
        timeLabel.className = 'mb-1 text-xs font-medium text-gray-600';
        timeLabel.textContent = 'Horaire';
        timeCell.insertBefore(timeLabel, timeInput);
      }

      if (doseCell && !doseCell.querySelector('[data-sp-field-label="dose"]')) {
        var doseLabel = document.createElement('div');
        doseLabel.setAttribute('data-sp-field-label', 'dose');
        doseLabel.className = 'mb-1 text-xs font-medium text-gray-600';
        doseLabel.textContent = 'Quantité / prise';
        doseCell.insertBefore(doseLabel, doseInput);
      }

      doseInput.setAttribute('placeholder', 'Quantité / prise');
      doseInput.setAttribute('aria-label', 'Quantité par prise');
      timeInput.setAttribute('aria-label', 'Horaire de prise');
    });
  }

  function normalizeNumericFields(block) {
    var controls = getControls(block);
    if (!controls.countInput || !controls.durationInput || !controls.frequencySelect) {
      return;
    }

    var frequency = controls.frequencySelect.value === 'semaine' ? 'semaine' : 'jour';
    var maxCount = frequency === 'jour' ? 6 : 12;
    var countValue = clampInt(controls.countInput.value, 1, maxCount, 1);
    var durationValue = clampInt(controls.durationInput.value, 1, 3650, 1);

    controls.countInput.setAttribute('max', String(maxCount));

    if (String(controls.countInput.value) !== String(countValue)) {
      dispatchValueUpdate(controls.countInput, String(countValue));
    }

    if (String(controls.durationInput.value) !== String(durationValue)) {
      dispatchValueUpdate(controls.durationInput, String(durationValue));
    }
  }

  function applyRecommendedTimes(block) {
    var controls = getControls(block);
    if (!controls.frequencySelect || controls.frequencySelect.value !== 'jour') {
      return;
    }

    var count = clampInt(controls.countInput && controls.countInput.value, 1, 6, 1);
    var times = recommendedTimes(count);
    var timeInputs = controls.timeInputs.slice(0, count);

    if (!timeInputs.length) {
      return;
    }

    timeInputs.forEach(function (input, index) {
      var value = times[index] || times[times.length - 1] || '08:00';
      dispatchValueUpdate(input, value);
    });
  }

  function scheduleRecommendedTimes(block, delay) {
    if (!block) {
      return;
    }

    if (timers.has(block)) {
      window.clearTimeout(timers.get(block));
    }

    var timeout = window.setTimeout(function () {
      timers.delete(block);
      patchBlock(block);
      applyRecommendedTimes(block);
    }, typeof delay === 'number' ? delay : 120);

    timers.set(block, timeout);
  }

  function patchBlock(block) {
    if (!block) {
      return;
    }

    ensureTopLabels(block);
    ensureTopHelper(block);
    ensureRowLabels(block);
    normalizeNumericFields(block);

    if (isAutoMode(block)) {
      applyRecommendedTimes(block);
    }
  }

  function scan() {
    var root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    findBlocks(root).forEach(patchBlock);
  }

  function onDocumentClick(event) {
    var button = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!button) {
      return;
    }

    var block = button.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    var label = text(button);
    if (label.indexOf('Réinitialiser horaires recommandés') !== -1 || label.indexOf('Horaires auto') !== -1) {
      scheduleRecommendedTimes(block, 160);
    }
  }

  function onDocumentChange(event) {
    var target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
      return;
    }

    var block = target.closest(BLOCK_SELECTOR);
    if (!isPosologyBlock(block)) {
      return;
    }

    patchBlock(block);

    if (target.matches('input[type="number"]')) {
      var value = clampInt(target.value, 1, 3650, 1);
      if (String(target.value) !== String(value)) {
        dispatchValueUpdate(target, String(value));
        return;
      }
    }

    if (target.matches('input[type="number"], select')) {
      if (isAutoMode(block)) {
        scheduleRecommendedTimes(block, 140);
      }
    }
  }

  function observe() {
    var root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    var observer = new MutationObserver(function () {
      scan();
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  }

  function boot() {
    scan();
    observe();
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('change', onDocumentChange, true);
    document.addEventListener('blur', onDocumentChange, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
