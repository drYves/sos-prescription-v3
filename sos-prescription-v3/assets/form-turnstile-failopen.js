// assets/form-turnstile-failopen.js
(function () {
  'use strict';

  var config = window.SOSPrescriptionTurnstileFailOpen || {};
  var shouldHide = !(config && config.enabled && config.configured);

  if (!shouldHide) {
    return;
  }

  function getRoot() {
    return document.getElementById('sosprescription-root-form');
  }

  function looksLikeTurnstileCard(node) {
    if (!node || !(node instanceof HTMLElement)) {
      return false;
    }

    var text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.indexOf('Anti-robot') === -1 && text.indexOf('Turnstile non configuré') === -1) {
      return false;
    }

    if (text.indexOf('Turnstile non configuré') !== -1) {
      return true;
    }

    return text.indexOf('Anti-robot') !== -1;
  }

  function hideTurnstileCard() {
    var root = getRoot();
    if (!root) {
      return;
    }

    var cards = root.querySelectorAll('div.rounded-xl.border.border-gray-200.bg-white.p-4');
    Array.prototype.forEach.call(cards, function (card) {
      if (!looksLikeTurnstileCard(card)) {
        return;
      }

      card.style.display = 'none';
      card.setAttribute('hidden', 'hidden');
      card.setAttribute('aria-hidden', 'true');
    });

    var warnings = root.querySelectorAll('[class*="warning"], .text-yellow-800, .text-amber-800');
    Array.prototype.forEach.call(warnings, function (node) {
      var content = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (content.indexOf('Turnstile non configuré') === -1) {
        return;
      }

      node.style.display = 'none';
      node.setAttribute('hidden', 'hidden');
      node.setAttribute('aria-hidden', 'true');
    });
  }

  function boot() {
    hideTurnstileCard();

    var root = getRoot();
    if (!root || typeof MutationObserver === 'undefined') {
      return;
    }

    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) {
        return;
      }

      scheduled = true;
      var run = function () {
        scheduled = false;
        hideTurnstileCard();
      };

      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 16);
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
