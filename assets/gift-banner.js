/* =============================================================================
   GIFT BANNER — mobile nav toggle
   -----------------------------------------------------------------------------
   Vanilla JS (no jQuery). On mobile the hamburger reveals a panel holding the
   tagline + "Choose gift" button (the items the desktop bar shows inline). On
   desktop the panel uses `display: contents`, so this toggle is inert there.

   Accessibility: the button drives aria-expanded; CSS swaps the hamburger ↔
   close icon and shows/hides the panel from the bar's --open modifier.
   ============================================================================= */
(function () {
  'use strict';

  function bind(toggle) {
    var bar = toggle.closest('[data-gift-nav]');
    if (!bar) return;

    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
      bar.classList.toggle('gift-banner__bar--open', !open);
    });
  }

  function init() {
    document.querySelectorAll('[data-gift-nav-toggle]').forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
