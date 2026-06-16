/* =============================================================================
   GIFT GUIDE — quick-view popup + Add to Cart (shared controller)
   -----------------------------------------------------------------------------
   Vanilla JS only (no jQuery). One shared popup is reused by every "+" marker
   on the page (the lookbook tags). The click is delegated from `document`, so
   any [data-gift-marker] carrying a product handle opens it.

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

  /* Slugify an option value for token lookup ("Light Grey" → "light-grey"),
     used to paint a swatch from var(--tv-swatch-<slug>). */
  function slugify(value) {
    return norm(value).replace(/\s+/g, '-');
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
  /* The Gift Guide comps price everything in euros (e.g. "980,00€"), so format
     to match the design regardless of the store's base currency. European
     convention: comma decimal, period thousands, trailing € (no space). */
  function formatMoney(cents) {
    var amount = (cents || 0) / 100;
    try {
      return new Intl.NumberFormat('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(amount) + '€';
    } catch (e) {
      return amount.toFixed(2).replace('.', ',') + '€';
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
    /* Object.create(null): a value like "constructor"/"toString" must not collide
       with Object.prototype keys and be silently dropped from the option list. */
    var seen = Object.create(null);
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

  /* ── Description sanitizer ─────────────────────────────────────────────────
     product.description is the merchant's raw body_html, written or PASTED into
     the Shopify admin. Paste-from-Word/Docs/Notion smuggles in junk the popup
     never styles: <meta charset>, empty <span></span>, redundant wrapper <p>,
     office tags (<o:p>), HTML comments, stray style/class attributes — and,
     because we inject via innerHTML, potentially active markup too.

     Rather than chase each artifact with a denylist, parse the HTML in an inert
     document (DOMParser runs no scripts and fetches no resources) and rebuild it
     against a small ALLOWLIST of tags real merchants actually use. Off-list
     CONTAINER tags are unwrapped (tag dropped, text kept, so copy is never lost);
     non-content tags (script/style/meta/…) are removed outright; empty inline
     nodes vanish. Returns sanitized HTML, or '' when nothing meaningful remains.

     Deliberate scope: a compact quick-view keeps inline/list formatting only.
     <table>/<img>/<h2-6>/<blockquote> are unwrapped to their text by design. */

  /* Tags kept, each mapped to the attributes allowed on it. A kept tag is
     emitted only when it holds content — any tag left empty after cleaning is
     dropped below (<br> excepted), so <span></span> and <p></p> never render. */
  var DESC_ALLOWED = {
    P: [], BR: [], SPAN: [], STRONG: [], B: [], EM: [], I: [], U: [],
    UL: [], OL: [], LI: [], A: ['href', 'title']
  };

  /* Non-content tags: removed with their subtree (their text is not wanted). */
  var DESC_DROP = {
    SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1,
    BASE: 1, HEAD: 1, NOSCRIPT: 1
  };

  /* Permit scheme-less (relative/anchor/protocol-relative) and the safe
     schemes; block javascript:, data:, vbscript:, etc. */
  function descSafeHref(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    var scheme = v.match(/^([a-z][a-z0-9+.\-]*):/i);
    if (scheme && !/^(https?|mailto|tel)$/i.test(scheme[1])) return null;
    return v;
  }

  /* Copy `source`'s sanitized children into `dest`. Both nodes are created by
     the live document, but `dest` stays detached until the caller reads its
     HTML back, so nothing activates. */
  function descClean(source, dest) {
    var nodes = source.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      /* Text: keep verbatim (entities already decoded by the parser). */
      if (node.nodeType === 3) {
        dest.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }
      /* Comments, processing instructions, anything non-element: drop. */
      if (node.nodeType !== 1) continue;

      var tag = node.tagName.toUpperCase();

      /* Non-content, or namespaced office tags (<o:p>): drop with subtree. */
      if (DESC_DROP[tag] || tag.indexOf(':') !== -1) continue;

      /* Off-list container (<div>, <font>, <span>, …): unwrap — keep its
         sanitized children, discard the wrapper itself. */
      if (!DESC_ALLOWED.hasOwnProperty(tag)) {
        descClean(node, dest);
        continue;
      }

      /* Allowed tag: rebuild a clean copy carrying only allowed attributes. */
      var clean = document.createElement(tag.toLowerCase());
      DESC_ALLOWED[tag].forEach(function (attr) {
        if (!node.hasAttribute(attr)) return;
        if (attr === 'href') {
          var href = descSafeHref(node.getAttribute(attr));
          if (href !== null) clean.setAttribute('href', href);
        } else {
          clean.setAttribute(attr, node.getAttribute(attr));
        }
      });

      descClean(node, clean);

      /* Drop any element left empty after cleaning — inline wrappers
         (<span></span>, <strong></strong>, empty <a>) AND block/list tags
         (<p></p>, <li></li>, <ul></ul>) that would render as a blank line.
         <br> is intentionally void, so it's the one empty tag kept. */
      if (tag !== 'BR' && !clean.firstElementChild &&
          !clean.textContent.trim()) {
        continue;
      }
      dest.appendChild(clean);
    }
  }

  /* Raw merchant HTML → sanitized HTML string ('' when nothing survives).
     Falls back to plain text if parsing ever fails, so render() never throws. */
  function sanitizeDescription(html) {
    if (html == null || !String(html).trim()) return '';
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      var out = document.createElement('div');
      descClean(doc.body, out);

      /* Common Word/Docs case: the whole body is one wrapper <p>. Unwrap it so
         its default margins don't fight the container's 12px/1.1 design. */
      if (out.childNodes.length === 1 &&
          out.firstChild.nodeType === 1 &&
          out.firstChild.tagName === 'P') {
        out.firstChild.outerHTML = out.firstChild.innerHTML;
      }

      return out.textContent.trim() ? out.innerHTML.trim() : '';
    } catch (e) {
      var tmp = document.createElement('div');
      tmp.textContent = String(html);   /* text node — never parsed as markup */
      return tmp.textContent.trim();
    }
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
      sizeWrap: root.querySelector('[data-gift-popup-size-wrap]'),
      sizeTrigger: root.querySelector('[data-gift-popup-size-trigger]'),
      sizeValue: root.querySelector('[data-gift-popup-size-value]'),
      sizeList: root.querySelector('[data-gift-popup-size-list]'),
      notice: root.querySelector('[data-gift-popup-notice]'),
      add: root.querySelector('[data-gift-popup-add]')
    };

    this.product = null;     // currently shown product JSON
    this.colorIdx = -1;      // index of the Color option, or -1
    this.sizeIdx = -1;       // index of the Size option, or -1
    this.selectedColor = ''; // current color choice
    this.selectedSize = '';  // current size choice (custom listbox value)
    this.lastTrigger = null; // marker to restore focus to on close

    this.bindEvents();
  }

  PopupController.prototype.bindEvents = function () {
    var self = this;

    /* Close via the X, the dimmer, or Escape. */
    this.root.querySelectorAll('[data-gift-popup-close], [data-gift-popup-overlay]').forEach(function (el) {
      el.addEventListener('click', function () { self.close(); });
    });

    /* A click on the popup root itself (the area around the dialog) closes too,
       mirroring the X. Guarded to e.target === root so clicks that bubble up
       from inside the dialog (swatches, select, buttons) don't close it. */
    this.root.addEventListener('click', function (e) {
      if (e.target === self.root) self.close();
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

    /* Color keyboard: arrows move between cells (WAI-ARIA radiogroup pattern). */
    this.els.swatches.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].indexOf(e.key) === -1) return;
      var cells = self.els.swatches.querySelectorAll('[data-color]');
      if (!cells.length) return;
      e.preventDefault();
      var idx = 0;
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].getAttribute('aria-checked') === 'true') { idx = i; break; }
      }
      var dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
      var next = (idx + dir + cells.length) % cells.length;
      self.selectColor(cells[next].getAttribute('data-color'));
      cells[next].focus();
    });

    /* Custom size dropdown. The trigger toggles the panel; options commit on
       click; click-away and Escape close it; full keyboard nav (arrows / Home /
       End / Enter). Because we own the panel, open/close is exact — none of the
       native picker's "stays focused after click-away" quirks. */
    this.els.sizeTrigger.addEventListener('click', function () {
      if (self.sizeOpen) self.closeSize(); else self.openSize();
    });
    this.els.sizeTrigger.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Escape') { if (self.sizeOpen) { e.preventDefault(); self.closeSize(); } return; }
      if (!self.sizeOpen) {
        if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); self.openSize(); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); self.setActiveOption(self.activeIdx + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); self.setActiveOption(self.activeIdx - 1); }
      else if (k === 'Home') { e.preventDefault(); self.setActiveOption(0); }
      else if (k === 'End') { e.preventDefault(); self.setActiveOption(self.sizeOptions().length - 1); }
      else if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        if (self.activeIdx >= 0) self.selectSize(self.sizeOptions()[self.activeIdx].getAttribute('data-value'));
      }
    });
    /* Option chosen (delegated). mousedown + preventDefault keeps focus on the
       trigger so the panel doesn't flicker on the ensuing blur. */
    this.els.sizeList.addEventListener('mousedown', function (e) {
      var opt = e.target.closest('[data-value]');
      if (opt) { e.preventDefault(); self.selectSize(opt.getAttribute('data-value')); }
    });
    /* Pointer hover mirrors the keyboard highlight. */
    this.els.sizeList.addEventListener('mousemove', function (e) {
      var opt = e.target.closest('[data-value]');
      if (opt) self.setActiveOption(self.sizeOptions().indexOf(opt));
    });
    /* A click anywhere outside the control closes the open panel. */
    document.addEventListener('mousedown', function (e) {
      if (self.sizeOpen && self.els.sizeWrap && !self.els.sizeWrap.contains(e.target)) self.closeSize();
    });

    /* Add to cart button click. */
    this.els.add.addEventListener('click', function () {
      self.addToCart();
    });
  };

  /* Open for a given handle: fetch (cached), render, then reveal. */
  PopupController.prototype.open = function (handle, trigger) {
    var self = this;

    /* Already showing this product: just keep it open (re-focus is enough).
       Avoids a redundant render and a clobbered lastTrigger on a double-click. */
    if (!this.root.hasAttribute('hidden') && this.product && this.product.handle === handle) {
      return;
    }

    this.lastTrigger = trigger || null;
    this.setNotice('', false);

    /* Monotonic token: if a newer open() starts before this fetch resolves, the
       stale result is discarded so the popup always reflects the LAST click
       (correct content + focus restore), regardless of cache/resolve ordering. */
    var token = (this.openToken || 0) + 1;
    this.openToken = token;

    fetchProduct(handle).then(function (product) {
      if (self.openToken !== token) return;
      self.render(product);
      self.reveal();
    }).catch(function () {
      if (self.openToken !== token) return;
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
    els.description.innerHTML = sanitizeDescription(product.description || product.body_html);

    /* Resolve which slots hold Color and Size for this product. */
    this.colorIdx = optionIndex(product, 'Color');
    this.sizeIdx = optionIndex(product, 'Size');

    this.renderColors(optionValues(product, this.colorIdx));
    this.renderSizes(optionValues(product, this.sizeIdx));
    this.refreshAvailability();
  };

  /* Build the segmented color control (one cell per value); auto-select the
     first. Each cell is a radio carrying its [data-color] hook + a left swatch
     bar painted from the colour token. The indicator width follows the cell
     count (--color-count); selectColor slides it via --color-i. */
  PopupController.prototype.renderColors = function (colors) {
    var swatches = this.els.swatches;
    swatches.innerHTML = '';
    this.selectedColor = '';

    if (!colors.length) {
      this.els.colorsField.hidden = true;
      return;
    }
    this.els.colorsField.hidden = false;
    this.els.colorsField.style.setProperty('--color-count', colors.length);

    colors.forEach(function (color) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gift-popup__color-option';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('data-color', color);
      btn.tabIndex = -1;
      /* Paint the left swatch bar from the matching colour token. */
      btn.style.setProperty('--swatch', 'var(--tv-swatch-' + slugify(color) + ', var(--tv-black))');
      btn.textContent = color;
      swatches.appendChild(btn);
    });
    this.selectColor(colors[0]);
  };

  /* Build the custom size listbox (<li role="option">); reset to placeholder. */
  PopupController.prototype.renderSizes = function (sizes) {
    var list = this.els.sizeList;
    list.innerHTML = '';
    this.selectedSize = '';
    this.activeIdx = -1;
    this.els.sizeValue.textContent = 'Choose your size';
    this.els.sizeWrap.classList.remove('has-value');  // back to left-aligned placeholder
    this.closeSize();

    if (!sizes.length) {
      this.els.sizesField.hidden = true;
      return;
    }
    this.els.sizesField.hidden = false;

    sizes.forEach(function (size) {
      var li = document.createElement('li');
      li.className = 'gift-popup__size-option';
      li.setAttribute('role', 'option');
      li.setAttribute('data-value', size);
      li.setAttribute('aria-selected', 'false');
      li.id = 'gift-popup-size-' + slugify(size);
      li.textContent = size;
      list.appendChild(li);
    });
  };

  /* The <li> options as a plain array. */
  PopupController.prototype.sizeOptions = function () {
    return Array.prototype.slice.call(this.els.sizeList.querySelectorAll('[data-value]'));
  };

  /* Open the dropdown panel and highlight the current (or first) option. */
  PopupController.prototype.openSize = function () {
    if (this.sizeOpen) return;
    this.els.sizeList.hidden = false;
    this.els.sizeWrap.classList.add('is-open');
    this.dialog.classList.add('is-size-open');   // let the panel overflow the dialog
    this.els.sizeTrigger.setAttribute('aria-expanded', 'true');
    this.sizeOpen = true;
    var opts = this.sizeOptions();
    var idx = 0;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].getAttribute('data-value') === this.selectedSize) { idx = i; break; }
    }
    this.setActiveOption(idx);
  };
  PopupController.prototype.closeSize = function () {
    this.els.sizeList.hidden = true;
    this.els.sizeWrap.classList.remove('is-open');
    this.dialog.classList.remove('is-size-open');
    this.els.sizeTrigger.setAttribute('aria-expanded', 'false');
    this.els.sizeTrigger.removeAttribute('aria-activedescendant');
    this.sizeOpen = false;
    this.activeIdx = -1;
    var opts = this.sizeOptions();
    for (var i = 0; i < opts.length; i++) opts[i].classList.remove('is-active');
  };

  /* Keyboard highlight (roving aria-activedescendant + .is-active). */
  PopupController.prototype.setActiveOption = function (idx) {
    var opts = this.sizeOptions();
    if (!opts.length) return;
    idx = (idx + opts.length) % opts.length;
    for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('is-active', i === idx);
    this.activeIdx = idx;
    this.els.sizeTrigger.setAttribute('aria-activedescendant', opts[idx].id);
    opts[idx].scrollIntoView({ block: 'nearest' });
  };

  /* Commit a choice: update the value + trigger label, close, re-validate. */
  PopupController.prototype.selectSize = function (value) {
    this.selectedSize = value;
    this.els.sizeValue.textContent = value;
    this.els.sizeWrap.classList.add('has-value');  // centre the chosen value
    var opts = this.sizeOptions();
    for (var i = 0; i < opts.length; i++) {
      opts[i].setAttribute('aria-selected', opts[i].getAttribute('data-value') === value ? 'true' : 'false');
    }
    this.closeSize();
    this.els.sizeTrigger.focus();
    this.refreshAvailability();
  };

  PopupController.prototype.selectColor = function (color) {
    this.selectedColor = color;
    var selectedIndex = 0;
    this.els.swatches.querySelectorAll('[data-color]').forEach(function (btn, i) {
      var on = btn.getAttribute('data-color') === color;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;       // roving tabindex: only the selected cell is tabbable
      if (on) selectedIndex = i;
    });
    /* Slide the indicator layer to the chosen cell. */
    this.els.colorsField.style.setProperty('--color-i', selectedIndex);
    this.refreshAvailability();
  };

  /* Find the variant matching the current Color + Size selection. */
  PopupController.prototype.currentVariant = function () {
    if (!this.product) return null;
    var color = this.selectedColor;
    var size = this.selectedSize;
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
    var size = this.sizeIdx >= 0 ? variant.options[this.sizeIdx] : this.selectedSize;
    var triggersRule = isBlack(color) && isMedium(size) && this.product.handle !== AUTO_ADD_HANDLE;

    if (!triggersRule) return Promise.resolve(items);

    return fetchProduct(AUTO_ADD_HANDLE).then(function (gift) {
      var giftVariant = firstAvailableVariant(gift);
      /* Only append the bonus when it's actually in stock: /cart/add.js is atomic,
         so a sold-out gift line would fail the WHOLE batch and block the shopper's
         own item. If unavailable, skip it — the chosen item still adds. */
      if (giftVariant && giftVariant.available) items.push({ id: giftVariant.id, quantity: 1 });
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
        /* Ask the cart endpoint to also return the freshly-rendered header cart
           bubble (Shopify Section Rendering API) so the count updates in place,
           with no extra request and no full-page reload. */
        body: JSON.stringify({
          items: items,
          sections: 'cart-icon-bubble',
          sections_url: window.location.pathname
        })
      }).then(function (res) {
        if (!res.ok) throw new Error('cart/add failed');
        return res.json();
      }).then(function (data) {
        self.els.add.disabled = false;
        var extra = items.length > 1 ? ' (Soft Winter Jacket added too)' : '';
        self.setNotice('Added to cart' + extra + '.', false);
        self.updateCartBubble(data && data.sections && data.sections['cart-icon-bubble']);
        document.dispatchEvent(new CustomEvent('gift:cart:added', { detail: { items: items } }));
      });
    }).catch(function () {
      self.els.add.disabled = false;
      self.setNotice('Could not add to cart. Please try again.', true);
    });
  };

  /* Refresh the theme's cart count after an add. Theme-aware but not coupled:
     prefers Dawn's #cart-icon-bubble (swapped from the Section Rendering API HTML
     returned above); if that element/section is absent it no-ops, falling back to
     any opt-in [data-gift-cart-count] hooks via /cart.js. Never throws. */
  PopupController.prototype.updateCartBubble = function (sectionHtml) {
    var current = document.getElementById('cart-icon-bubble');
    if (current && sectionHtml) {
      try {
        var fresh = new DOMParser()
          .parseFromString(sectionHtml, 'text/html')
          .getElementById('cart-icon-bubble');
        if (fresh) { current.innerHTML = fresh.innerHTML; return; }
      } catch (e) { /* fall through to the count-hook fallback below */ }
    }

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
    if (this.sizeOpen) this.closeSize();
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
