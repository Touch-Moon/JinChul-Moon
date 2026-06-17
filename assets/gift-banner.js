/* =============================================================================
   GIFT BANNER — mobile nav toggle
   -----------------------------------------------------------------------------
   The hamburger reveals a panel with the tagline + "Choose gift" button (shown
   inline on desktop, where the panel is display:contents so this toggle is inert).
   Drives aria-expanded; CSS handles the icon swap + panel reveal.
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
