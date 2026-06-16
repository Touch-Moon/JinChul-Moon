/* =============================================================================
   GIFT GUIDE — grid markers, quick-view popup, and Add to Cart
   -----------------------------------------------------------------------------
   Vanilla JS only (no jQuery). One shared popup is reused by every grid marker.

   Flow:
     marker click → fetch /products/{handle}.js (cached) → render the popup
     → user picks Color + Size → resolve the matching variant by OPTION NAME
     (never a hardcoded ID) → submit adds it via /cart/add.js.

   Special rule (from the brief): whenever a variant with Color = Black AND
   Size = Medium is added, the "Soft Winter Jacket" (handle: dark-winter-jacket)
   is added in the same cart request. The target is resolved at runtime from its
   own product JSON, so no IDs are baked in.
   ============================================================================= */
(function () {
  'use strict';

  /* Handle of the product auto-added by the Black + Medium rule. */
  var AUTO_ADD_HANDLE = 'dark-winter-jacket';

  /* ── Small helpers ─────────────────────────────────────────────────────── */

  /* Normalize an option value for matching (case/space-insensitive). */
  function norm(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /* The rule keys off these two, regardless of which option slot they sit in.
     "Medium" is matched as either the full word or the common "M" short form. */
  function isBlack(value) {
    return norm(value) === 'black';
  }
  function isMedium(value) {
    var v = norm(value);
    return v === 'medium' || v === 'm';
  }

  /* Format an integer amount of cents into the store currency. Uses Shopify's
     own formatter when present, else falls back to Intl with the active
     currency (keeps the preview harness and the live store consistent). */
  function formatMoney(cents) {
    if (window.Shopify && typeof window.Shopify.formatMoney === 'function') {
      return window.Shopify.formatMoney(cents);
    }
    var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(cents / 100);
    } catch (e) {
      return (cents / 100).toFixed(2);
    }
  }

  /* Index of an option (e.g. "Color") within product.options, by name. Returns
     -1 when the product does not carry that option. */
  function optionIndex(product, name) {
    var options = product.options || [];
    for (var i = 0; i < options.length; i++) {
      /* product.options can be ["Color","Size"] or [{name:"Color"},...]. */
      var optName = typeof options[i] === 'string' ? options[i] : options[i].name;
      if (norm(optName) === norm(name)) return i;
    }
    return -1;
  }

  /* Unique option values in source order (e.g. all colors of a product). */
  function optionValues(product, idx) {
    if (idx < 0) return [];
    var seen = {};
    var out = [];
    (product.variants || []).forEach(function (variant) {
      var value = variant.options[idx];
      if (value != null && !seen[value]) {
        seen[value] = true;
        out.push(value);
      }
    });
    return out;
  }

  /* First available variant of a product (or the first variant as a fallback). */
  function firstAvailableVariant(product) {
    var variants = product.variants || [];
    for (var i = 0; i < variants.length; i++) {
      if (variants[i].available) return variants[i];
    }
    return variants[0] || null;
  }

  /* Storefront route root ("/" or e.g. "/en") so locale-prefixed shops work. */
  function routeRoot() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return root.replace(/\/$/, ''); // trim trailing slash; paths below add their own
  }

  /* ── Product cache: fetch each handle's JSON at most once ─────────────────── */

  var productCache = {};

  function fetchProduct(handle) {
    if (productCache[handle]) return productCache[handle];
    var promise = fetch(routeRoot() + '/products/' + handle + '.js', {
      headers: { Accept: 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('Product fetch failed: ' + handle);
      return res.json();
    });
    productCache[handle] = promise;
    return promise;
  }

  /* ── Popup controller ────────────────────────────────────────────────────
     One instance manages the single shared modal. State for the open product
     lives here so the markup stays a dumb shell. */

  function PopupController(root) {
    this.root = root;
    this.dialog = root.querySelector('[data-gift-popup-dialog]');
    this.els = {
      image: root.querySelector('[data-gift-popup-image]'),
      title: root.querySelector('[data-gift-popup-title]'),
      price: root.querySelector('[data-gift-popup-price]'),
      description: root.querySelector('[data-gift-popup-description]'),
      colorsField: root.querySelector('[data-gift-popup-colors]'),
      swatches: root.querySelector('[data-gift-popup-swatches]'),
      sizesField: root.querySelector('[data-gift-popup-sizes]'),
      size: root.querySelector('[data-gift-popup-size]'),
      notice: root.querySelector('[data-gift-popup-notice]'),
      form: root.querySelector('[data-gift-popup-form]'),
      add: root.querySelector('[data-gift-popup-add]')
    };

    this.product = null;     // currently shown product JSON
    this.colorIdx = -1;      // index of the Color option, or -1
    this.sizeIdx = -1;       // index of the Size option, or -1
    this.selectedColor = ''; // current color choice
    this.lastTrigger = null; // marker to restore focus to on close

    this.bindEvents();
  }

  PopupController.prototype.bindEvents = function () {
    var self = this;

    /* Close via the X, the dimmer, or Escape. */
    this.root.querySelectorAll('[data-gift-popup-close], [data-gift-popup-overlay]').forEach(function (el) {
      el.addEventListener('click', function () { self.close(); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !self.root.hasAttribute('hidden')) self.close();
    });

    /* Keep focus inside the dialog while it is open. */
    this.dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') self.trapFocus(e);
    });

    /* Color swatch clicks (event-delegated). */
    this.els.swatches.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-color]');
      if (btn) self.selectColor(btn.getAttribute('data-color'));
    });

    /* Size change re-validates availability. */
    this.els.size.addEventListener('change', function () { self.refreshAvailability(); });

    /* Submit = add to cart. */
    this.els.form.addEventListener('submit', function (e) {
      e.preventDefault();
      self.addToCart();
    });
  };

  /* Open for a given handle: fetch (cached), render, then reveal. */
  PopupController.prototype.open = function (handle, trigger) {
    var self = this;
    this.lastTrigger = trigger || null;
    this.setNotice('', false);

    fetchProduct(handle).then(function (product) {
      self.render(product);
      self.reveal();
    }).catch(function () {
      self.render(null);
      self.setNotice('Sorry, this product could not be loaded.', true);
      self.reveal();
    });
  };

  /* Populate the shell from product JSON. */
  PopupController.prototype.render = function (product) {
    this.product = product;
    var els = this.els;

    if (!product) {
      els.title.textContent = 'Unavailable';
      els.price.textContent = '';
      els.description.innerHTML = '';
      els.colorsField.hidden = true;
      els.sizesField.hidden = true;
      return;
    }

    /* Media + text. */
    els.image.src = product.featured_image || (product.images && product.images[0]) || '';
    els.image.alt = product.title || '';
    els.title.textContent = product.title || '';
    els.price.textContent = formatMoney(product.price);
    els.description.innerHTML = product.description || product.body_html || '';

    /* Resolve which slots hold Color and Size for this product. */
    this.colorIdx = optionIndex(product, 'Color');
    this.sizeIdx = optionIndex(product, 'Size');

    this.renderColors(optionValues(product, this.colorIdx));
    this.renderSizes(optionValues(product, this.sizeIdx));
    this.refreshAvailability();
  };

  /* Build color swatches; auto-select the first one. */
  PopupController.prototype.renderColors = function (colors) {
    var swatches = this.els.swatches;
    swatches.innerHTML = '';
    this.selectedColor = '';

    if (!colors.length) {
      this.els.colorsField.hidden = true;
      return;
    }
    this.els.colorsField.hidden = false;

    var self = this;
    colors.forEach(function (color) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gift-popup__swatch';
      btn.setAttribute('data-color', color);
      btn.setAttribute('aria-label', color);
      btn.title = color;
      /* Paint from a per-color token so unknown colors still get a neutral chip. */
      btn.style.setProperty('--swatch', 'var(--tv-swatch-' + norm(color) + ', #cccccc)');
      swatches.appendChild(btn);
    });
    this.selectColor(colors[0]);
  };

  /* Build the size <select>; reset to the placeholder. */
  PopupController.prototype.renderSizes = function (sizes) {
    var select = this.els.size;
    /* Keep the disabled placeholder (first option), drop the rest. */
    while (select.options.length > 1) select.remove(1);
    select.selectedIndex = 0;

    if (!sizes.length) {
      this.els.sizesField.hidden = true;
      return;
    }
    this.els.sizesField.hidden = false;
    sizes.forEach(function (size) {
      var opt = document.createElement('option');
      opt.value = size;
      opt.textContent = size;
      select.appendChild(opt);
    });
  };

  PopupController.prototype.selectColor = function (color) {
    this.selectedColor = color;
    this.els.swatches.querySelectorAll('[data-color]').forEach(function (btn) {
      var on = btn.getAttribute('data-color') === color;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    this.refreshAvailability();
  };

  /* Find the variant matching the current Color + Size selection. */
  PopupController.prototype.currentVariant = function () {
    if (!this.product) return null;
    var color = this.selectedColor;
    var size = this.els.size.value;
    var needColor = this.colorIdx >= 0;
    var needSize = this.sizeIdx >= 0;

    /* Cannot resolve until every present option is chosen. */
    if ((needColor && !color) || (needSize && !size)) return null;

    var self = this;
    return (this.product.variants || []).filter(function (v) {
      return (!needColor || v.options[self.colorIdx] === color) &&
             (!needSize || v.options[self.sizeIdx] === size);
    })[0] || null;
  };

  /* Enable/disable Add to Cart and reflect price + stock for the choice. */
  PopupController.prototype.refreshAvailability = function () {
    var variant = this.currentVariant();
    var add = this.els.add;

    if (!variant) {
      add.disabled = true;
      add.setAttribute('aria-disabled', 'true');
      return;
    }
    this.els.price.textContent = formatMoney(variant.price);
    if (variant.available) {
      add.disabled = false;
      add.removeAttribute('aria-disabled');
      this.setNotice('', false);
    } else {
      add.disabled = true;
      add.setAttribute('aria-disabled', 'true');
      this.setNotice('This option is sold out.', true);
    }
  };

  /* Build the /cart/add.js payload, applying the Black + Medium rule. */
  PopupController.prototype.buildCartItems = function (variant) {
    var items = [{ id: variant.id, quantity: 1 }];

    /* Rule: a Black + Medium selection also adds the Soft Winter Jacket.
       Guard against recursion if the chosen product IS the auto-add target. */
    var color = this.colorIdx >= 0 ? variant.options[this.colorIdx] : this.selectedColor;
    var size = this.sizeIdx >= 0 ? variant.options[this.sizeIdx] : this.els.size.value;
    var triggersRule = isBlack(color) && isMedium(size) && this.product.handle !== AUTO_ADD_HANDLE;

    if (!triggersRule) return Promise.resolve(items);

    return fetchProduct(AUTO_ADD_HANDLE).then(function (gift) {
      var giftVariant = firstAvailableVariant(gift);
      if (giftVariant) items.push({ id: giftVariant.id, quantity: 1 });
      return items;
    }).catch(function () {
      /* If the bonus product cannot be loaded, still add the chosen item. */
      return items;
    });
  };

  PopupController.prototype.addToCart = function () {
    var self = this;
    var variant = this.currentVariant();
    if (!variant || !variant.available) return;

    this.els.add.disabled = true;
    this.setNotice('Adding…', false);

    this.buildCartItems(variant).then(function (items) {
      return fetch(routeRoot() + '/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: items })
      }).then(function (res) {
        if (!res.ok) throw new Error('cart/add failed');
        return res.json();
      }).then(function () {
        self.els.add.disabled = false;
        var extra = items.length > 1 ? ' (Soft Winter Jacket added too)' : '';
        self.setNotice('Added to cart' + extra + '.', false);
        self.refreshCartCount();
        document.dispatchEvent(new CustomEvent('gift:cart:added', { detail: { items: items } }));
      });
    }).catch(function () {
      self.els.add.disabled = false;
      self.setNotice('Could not add to cart. Please try again.', true);
    });
  };

  /* Best-effort cart bubble refresh (theme-agnostic; ignores absence). */
  PopupController.prototype.refreshCartCount = function () {
    fetch(routeRoot() + '/cart.js', { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cart) {
        if (!cart) return;
        document.querySelectorAll('[data-gift-cart-count]').forEach(function (el) {
          el.textContent = cart.item_count;
        });
      })
      .catch(function () {});
  };

  PopupController.prototype.setNotice = function (message, isError) {
    var notice = this.els.notice;
    notice.textContent = message;
    notice.hidden = !message;
    notice.classList.toggle('gift-popup__notice--error', !!isError);
  };

  /* ── Open/close + focus management ───────────────────────────────────────── */

  PopupController.prototype.reveal = function () {
    this.root.removeAttribute('hidden');
    document.body.classList.add('gift-popup-open');
    /* Move focus into the dialog for keyboard + screen-reader users. */
    var focusable = this.focusable();
    (focusable[0] || this.dialog).focus();
  };

  PopupController.prototype.close = function () {
    this.root.setAttribute('hidden', '');
    document.body.classList.remove('gift-popup-open');
    if (this.lastTrigger) this.lastTrigger.focus();
  };

  PopupController.prototype.focusable = function () {
    return Array.prototype.slice.call(
      this.dialog.querySelectorAll(
        'button:not([disabled]), [href], select, input, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(function (el) { return el.offsetParent !== null; });
  };

  PopupController.prototype.trapFocus = function (e) {
    var items = this.focusable();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /* ── Wire-up ──────────────────────────────────────────────────────────────
     One controller for the shared popup; markers are delegated from document
     so cards added later (or rendered per-section) still work. */

  function init() {
    var popupEl = document.querySelector('[data-gift-popup]');
    if (!popupEl) return;
    var controller = new PopupController(popupEl);

    document.addEventListener('click', function (e) {
      var marker = e.target.closest('[data-gift-marker]');
      if (!marker) return;
      e.preventDefault();
      controller.open(marker.getAttribute('data-product-handle'), marker);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
