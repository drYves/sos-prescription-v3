(function () {
  'use strict';

  var shell = document.querySelector('.sp-shell');
  if (!(shell instanceof HTMLElement)) {
    return;
  }

  shell.dataset.spShellRuntime = 'theme-safe';
})();
