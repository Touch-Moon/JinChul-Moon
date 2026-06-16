/* =============================================================================
   GIFT LOOKBOOK — marker placement helper (Theme Customizer ONLY)
   -----------------------------------------------------------------------------
   Lets the merchant DRAG a "+" tag over its photo to place it. While dragging,
   the tag follows the pointer and a live "X, Y" badge shows the percent. On
   release, that "X, Y" is copied to the clipboard and a toast tells the merchant
   to paste it into the block's "Tag position" field.

   Why copy-paste and not auto-save: the editor preview runs in an iframe and
   Shopify exposes no API to write a section setting from inside it. Dragging +
   auto-copy is the closest in-editor placement the platform allows; the merchant
   pastes once instead of guessing two slider values.

   Loaded only when {{ request.design_mode }} is true, so it never ships to
   shoppers. Vanilla JS, no dependencies. Self-guards on Shopify.designMode too.
   ============================================================================= */
(function () {
  'use strict';

  /* Belt-and-braces: the section only injects this in design mode, but guard
     anyway so a stray include on the storefront is a no-op. */
  if (!window.Shopify || !window.Shopify.designMode) return;

  /* Pointer travel (px) before a press counts as a drag rather than a click —
     keeps a plain click on a linked tag free to still open the quick view. */
  var DRAG_THRESHOLD = 3;

  var badge = null;          // live "X, Y" readout that follows the pointer
  var toast = null;          // "copied — paste it" confirmation
  var toastTimer = null;
  var drag = null;           // active drag state, or null

  function clampPercent(n) { return Math.max(0, Math.min(100, n)); }

  /* ── Badge + toast (created lazily, reused thereafter) ─────────────────────── */

  function showBadge(text, clientX, clientY) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'gift-lookbook__pos-badge';
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.left = clientX + 'px';
    badge.style.top = clientY + 'px';
    badge.classList.add('is-visible');
  }

  function hideBadge() {
    if (badge) badge.classList.remove('is-visible');
  }

  function showToast(text) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gift-lookbook__toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-visible'); }, 3200);
  }

  /* Copy with a graceful fallback for older editors lacking the async API. */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallbackCopy.bind(null, text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* clipboard blocked */ }
    document.body.removeChild(ta);
  }

  /* ── Drag lifecycle ───────────────────────────────────────────────────────── */

  function onPointerDown(e) {
    /* Primary button / touch only. */
    if (e.button != null && e.button !== 0) return;
    var marker = e.target.closest('.gift-lookbook__marker');
    if (!marker) return;
    var media = marker.closest('.gift-lookbook__media');
    if (!media) return;

    e.preventDefault();   // don't start a native image drag or text selection
    drag = {
      marker: marker,
      media: media,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      value: ''
    };
  }

  function onPointerMove(e) {
    if (!drag) return;

    /* Ignore sub-threshold jitter so a click stays a click. */
    if (!drag.moved &&
        Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
        Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) {
      return;
    }
    drag.moved = true;

    var rect = drag.media.getBoundingClientRect();
    var x = Math.round(clampPercent((e.clientX - rect.left) / rect.width * 100));
    var y = Math.round(clampPercent((e.clientY - rect.top) / rect.height * 100));

    /* Live-move the tag and remember the value to copy on release. */
    drag.marker.style.setProperty('--mx', x + '%');
    drag.marker.style.setProperty('--my', y + '%');
    drag.value = x + ', ' + y;
    showBadge(drag.value, e.clientX, e.clientY);
  }

  function onPointerUp() {
    if (!drag) return;
    var ended = drag;
    drag = null;
    hideBadge();

    if (!ended.moved || !ended.value) return;   // it was a click, not a drag

    copyText(ended.value);
    showToast('Position copied: ' + ended.value + '  —  paste it into the block’s “Tag position” field');

    /* A drag on a linked tag would otherwise fire a click and open the quick
       view; swallow that one click (capture phase, before the popup's handler). */
    suppressNextClick(ended.marker);
  }

  function suppressNextClick(marker) {
    function swallow(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      marker.removeEventListener('click', swallow, true);
    }
    marker.addEventListener('click', swallow, true);
    /* If no click follows (e.g. touch), clean up so the next real click works. */
    setTimeout(function () { marker.removeEventListener('click', swallow, true); }, 400);
  }

  /* ── Affordance + wire-up ─────────────────────────────────────────────────── */

  /* Mark every tag as draggable (cursor + tooltip). Re-runnable: the editor
     re-renders the section on edits, and closest()-based handlers already cover
     new tags, so this only refreshes the visual hint. */
  function tagMarkers() {
    document.querySelectorAll('.gift-lookbook__marker').forEach(function (m) {
      m.classList.add('gift-lookbook__marker--draggable');
      m.setAttribute('title', 'Drag to position — the coordinates are copied for you');
    });
  }

  /* Document-level listeners (added once) so a fast drag that leaves the tag — or
     even the photo — keeps tracking until release. */
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tagMarkers);
  } else {
    tagMarkers();
  }
  document.addEventListener('shopify:section:load', tagMarkers);
})();
