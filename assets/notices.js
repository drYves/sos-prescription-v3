(function () {
  try {
    function ready(fn) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn);
      } else {
        fn();
      }
    }

    function safeGet(key) {
      try {
        return window.localStorage ? window.localStorage.getItem(key) : null;
      } catch (e) {
        return null;
      }
    }

    function safeSet(key, value) {
      try {
        if (window.localStorage) {
          window.localStorage.setItem(key, value);
        }
      } catch (e) {
        // ignore
      }
    }

    ready(function () {
      var nodes = document.querySelectorAll('.sosprescription-notice[data-notice-key]');
      if (!nodes || !nodes.length) return;

      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var key = el.getAttribute('data-notice-key');
        if (!key) continue;

        var state = safeGet(key);
        if (state === 'dismissed') {
          el.style.display = 'none';
          continue;
        }

        var close = el.querySelector('.sp-notice-close');
        if (close) {
          close.addEventListener('click', function (ev) {
            try { ev.preventDefault(); } catch (e) {}
            var parent = this.closest ? this.closest('.sosprescription-notice') : null;
            if (!parent) return;
            var k = parent.getAttribute('data-notice-key');
            if (k) safeSet(k, 'dismissed');
            parent.style.display = 'none';
          });
        }
      }
    });
  } catch (e) {
    // silent
  }
})();
