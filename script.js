/* QR Studio - app logic. Depends only on qr.js (the encoder). */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    //  Small helpers
    // ------------------------------------------------------------------
    var $ = function (id) { return document.getElementById(id); };
    var enc = new TextEncoder();
    var utf8 = function (s) { return enc.encode(s); };
    var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var store = {
        get: function (key, fallback) {
            try {
                var v = localStorage.getItem(key);
                return v === null ? fallback : JSON.parse(v);
            } catch (e) { return fallback; }
        },
        set: function (key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
        }
    };

    var toastTimer = 0;
    function toast(message, type) {
        var el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'info');
        el.textContent = message;
        $('toasts').replaceChildren(el);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.remove(); }, type === 'error' ? 5000 : 2600);
    }

    function download(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    function slug(s) {
        return String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '').slice(0, 40);
    }

    function todayISO() {
        return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }

    function formatBytes(n) {
        return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' bytes';
    }

    // ------------------------------------------------------------------
    //  State
    // ------------------------------------------------------------------
    var DEFAULT_DESIGN = {
        fg: '#0f151d', bg: '#ffffff', dots: 'square', eyes: 'square',
        ecc: 'auto', size: 1024, margin: 4, logoSize: 20
    };

    var state = {
        kind: 'text',
        values: { text: {}, wifi: { enc: 'WPA' }, contact: {}, event: { date: todayISO() }, image: {} },
        design: Object.assign({}, DEFAULT_DESIGN, store.get('qrs.design', {})),
        logo: null,     // { img, url } - shown in the middle of the code
        image: null,    // { url, w, h, mime, bytes, source } - the image *is* the payload
        current: null   // { model, payload, bytes } for the code currently on screen
    };
    var cache = { key: '', model: null };
    var history = store.get('qrs.history', []);

    // ------------------------------------------------------------------
    //  Content types -> payload strings
    // ------------------------------------------------------------------
    function escWifi(s) { return String(s).replace(/([\\;,:"])/g, '\\$1'); }
    function escText(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
    }

    var KINDS = {
        text: {
            fields: [
                { id: 'text', label: 'Text or link', type: 'textarea', rows: 6, wide: true,
                  placeholder: 'Paste or type anything: a link, a note, a phone number...' }
            ],
            build: function (v) { return v.text || ''; }
        },
        wifi: {
            fields: [
                { id: 'ssid', label: 'Network name', type: 'text', wide: true },
                { id: 'enc', label: 'Security', type: 'select', value: 'WPA',
                  options: [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'None (open network)']] },
                { id: 'password', label: 'Password', type: 'text',
                  showIf: function (v) { return v.enc !== 'nopass'; } },
                { id: 'hidden', label: 'This network is hidden', type: 'checkbox', wide: true }
            ],
            build: function (v) {
                if (!v.ssid) return '';
                var open = v.enc === 'nopass';
                return 'WIFI:T:' + (v.enc || 'WPA') + ';S:' + escWifi(v.ssid) + ';' +
                    (open ? '' : 'P:' + escWifi(v.password || '') + ';') +
                    (v.hidden ? 'H:true;' : '') + ';';
            }
        },
        contact: {
            fields: [
                { id: 'name', label: 'Full name', type: 'text', wide: true },
                { id: 'phone', label: 'Phone', type: 'tel' },
                { id: 'email', label: 'Email', type: 'email' },
                { id: 'company', label: 'Company', type: 'text' },
                { id: 'website', label: 'Website', type: 'url' }
            ],
            build: function (v) {
                var name = (v.name || '').trim();
                if (!name) return '';
                var parts = name.split(/\s+/);
                var last = parts.length > 1 ? parts.pop() : '';
                var lines = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + escText(last) + ';' + escText(parts.join(' ')) + ';;;',
                    'FN:' + escText(name)];
                if (v.company) lines.push('ORG:' + escText(v.company.trim()));
                if (v.phone) lines.push('TEL:' + v.phone.trim());
                if (v.email) lines.push('EMAIL:' + v.email.trim());
                if (v.website) lines.push('URL:' + v.website.trim());
                lines.push('END:VCARD');
                return lines.join('\r\n');
            }
        },
        event: {
            fields: [
                { id: 'title', label: 'Event title', type: 'text', wide: true },
                { id: 'date', label: 'Date', type: 'date' },
                { id: 'start', label: 'Starts', type: 'time' },
                { id: 'end', label: 'Ends', type: 'time' },
                { id: 'location', label: 'Location', type: 'text' },
                { id: 'description', label: 'Description', type: 'text', wide: true },
                { type: 'help', text: 'Leave the times empty for an all-day event.' }
            ],
            build: function (v) {
                if (!v.title || !v.date) return '';
                var d = v.date.replace(/-/g, '');
                var t = function (x) { return x.replace(':', '') + '00'; };
                var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'SUMMARY:' + escText(v.title.trim())];
                if (v.start) {
                    lines.push('DTSTART:' + d + 'T' + t(v.start));
                    if (v.end) lines.push('DTEND:' + d + 'T' + t(v.end));
                } else {
                    lines.push('DTSTART;VALUE=DATE:' + d);
                }
                if (v.location) lines.push('LOCATION:' + escText(v.location.trim()));
                if (v.description) lines.push('DESCRIPTION:' + escText(v.description.trim()));
                lines.push('END:VEVENT', 'END:VCALENDAR');
                return lines.join('\r\n');
            }
        },
        image: {
            fields: [],
            build: function () { return state.image ? state.image.url : ''; }
        }
    };

    var EMPTY_COPY = {
        text: ['Paste text, a link, or an image', 'Your code appears here as you type. Press Ctrl+V anywhere on the page.'],
        wifi: ['Enter a network name', 'The code lets people join the network by scanning it.'],
        contact: ['Enter a name', 'Scanning the code offers to add a contact.'],
        event: ['Enter a title and date', 'Scanning the code offers to add a calendar event.'],
        image: ['Add an image', 'Paste, drop, or choose one on the left.']
    };

    function payloadFor(kind, values, image) {
        return kind === 'image' ? (image ? image.url : '') : KINDS[kind].build(values);
    }

    function labelFor(kind, values, image) {
        var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
        var out;
        if (kind === 'text') out = clean(values.text).slice(0, 48);
        else if (kind === 'wifi') out = 'Wi-Fi ' + clean(values.ssid);
        else if (kind === 'contact') out = clean(values.name);
        else if (kind === 'event') out = clean(values.title);
        else out = image ? 'Image ' + image.w + '\u00d7' + image.h : '';
        return out || 'Untitled';
    }

    // ------------------------------------------------------------------
    //  Encoding (picks the error-correction level)
    // ------------------------------------------------------------------
    function encodeWith(bytes, o) {
        var auto = o.ecc === 'auto';
        var start = !auto ? o.ecc : (o.kind === 'image' ? 'L' : (o.logo ? 'H' : 'M'));
        var order = auto ? QR.LEVELS.slice(0, QR.LEVELS.indexOf(start) + 1).reverse() : [start];
        var last = null;
        for (var i = 0; i < order.length; i++) {
            try {
                return QR.encode(bytes, { level: order[i], boost: auto && o.kind !== 'image' });
            } catch (e) {
                if (e.name !== 'CapacityError') throw e;
                last = e;
            }
        }
        throw last;
    }

    function ceilingLevel() {
        return state.design.ecc === 'auto' ? 'L' : state.design.ecc;
    }

    // ------------------------------------------------------------------
    //  Drawing: paths in module units, shared by canvas, SVG and history
    // ------------------------------------------------------------------
    function num(n) { return String(+n.toFixed(3)); }

    function rrect(x, y, w, h, tl, tr, br, bl) {
        var p = 'M' + num(x + tl) + ' ' + num(y) + 'h' + num(w - tl - tr);
        if (tr) p += 'a' + num(tr) + ' ' + num(tr) + ' 0 0 1 ' + num(tr) + ' ' + num(tr);
        p += 'v' + num(h - tr - br);
        if (br) p += 'a' + num(br) + ' ' + num(br) + ' 0 0 1 ' + num(-br) + ' ' + num(br);
        p += 'h' + num(-(w - br - bl));
        if (bl) p += 'a' + num(bl) + ' ' + num(bl) + ' 0 0 1 ' + num(-bl) + ' ' + num(-bl);
        p += 'v' + num(-(h - bl - tl));
        if (tl) p += 'a' + num(tl) + ' ' + num(tl) + ' 0 0 1 ' + num(tl) + ' ' + num(-tl);
        return p + 'z';
    }

    function circle(cx, cy, r) {
        return 'M' + num(cx - r) + ' ' + num(cy) + 'a' + num(r) + ' ' + num(r) + ' 0 1 0 ' + num(2 * r) + ' 0a' +
            num(r) + ' ' + num(r) + ' 0 1 0 ' + num(-2 * r) + ' 0z';
    }

    function eyeShape(style, x, y, size, radius) {
        if (style === 'circle') return circle(x + size / 2, y + size / 2, size / 2);
        var r = style === 'rounded' ? radius : 0;
        return rrect(x, y, size, size, r, r, r, r);
    }

    // The area in the middle that the logo covers (odd number of modules so it stays centred).
    function logoCut(model, design) {
        var n = model.size;
        var v = Math.max(3, Math.round(n * design.logoSize / 100));
        if (v % 2 !== n % 2) v += 1;
        v = Math.min(v, n - 16 - ((n - 16) % 2 === n % 2 ? 0 : 1));
        var x0 = (n - v) / 2;
        return { x0: x0, y0: x0, v: v };
    }

    function buildPaths(model, design, cut) {
        var n = model.size;
        var isEye = function (x, y) { return (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7); };
        var inCut = function (x, y) {
            return cut && x >= cut.x0 && x < cut.x0 + cut.v && y >= cut.y0 && y < cut.y0 + cut.v;
        };
        var dark = function (x, y) {
            return x >= 0 && y >= 0 && x < n && y < n && model.get(x, y) === 1 && !isEye(x, y) && !inCut(x, y);
        };

        var data = '', x, y;
        if (design.dots === 'square') {
            for (y = 0; y < n; y++) {
                x = 0;
                while (x < n) {
                    if (dark(x, y)) {
                        var s = x;
                        while (x < n && dark(x, y)) x++;
                        data += 'M' + s + ' ' + y + 'h' + (x - s) + 'v1h-' + (x - s) + 'z';
                    } else x++;
                }
            }
        } else if (design.dots === 'dots') {
            for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (dark(x, y)) data += circle(x + 0.5, y + 0.5, 0.42);
        } else {
            for (y = 0; y < n; y++) {
                for (x = 0; x < n; x++) {
                    if (!dark(x, y)) continue;
                    var up = dark(x, y - 1), down = dark(x, y + 1), left = dark(x - 1, y), right = dark(x + 1, y);
                    data += rrect(x, y, 1, 1,
                        !up && !left ? 0.5 : 0, !up && !right ? 0.5 : 0,
                        !down && !right ? 0.5 : 0, !down && !left ? 0.5 : 0);
                }
            }
        }

        // Finder "eyes": ring + inner block, filled with the even-odd rule so the ring has a hole.
        var eyes = '';
        [[0, 0], [n - 7, 0], [0, n - 7]].forEach(function (p) {
            eyes += eyeShape(design.eyes, p[0], p[1], 7, 2.2) +
                eyeShape(design.eyes, p[0] + 1, p[1] + 1, 5, 1.2) +
                eyeShape(design.eyes, p[0] + 2, p[1] + 2, 3, 0.9);
        });
        return { data: data, eyes: eyes };
    }

    function logoGeometry(cut, logo) {
        var box = cut.v * 0.8;
        var iw = logo.img.naturalWidth, ih = logo.img.naturalHeight;
        var k = Math.min(box / iw, box / ih);
        return { w: iw * k, h: ih * k, x: cut.x0 + (cut.v - iw * k) / 2, y: cut.y0 + (cut.v - ih * k) / 2 };
    }

    function platePath(cut) {
        var r = cut.v * 0.12;
        return rrect(cut.x0, cut.y0, cut.v, cut.v, r, r, r, r);
    }

    function paint(ctx, px, model, design, logo) {
        var margin = design.margin;
        var scale = px / (model.size + margin * 2);
        var cut = logo ? logoCut(model, design) : null;
        var paths = buildPaths(model, design, cut);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = design.bg;
        ctx.fillRect(0, 0, px, px);
        ctx.setTransform(scale, 0, 0, scale, margin * scale, margin * scale);
        ctx.fillStyle = design.fg;
        ctx.fill(new Path2D(paths.data));
        ctx.fill(new Path2D(paths.eyes), 'evenodd');

        if (cut) {
            ctx.fillStyle = design.bg;
            ctx.fill(new Path2D(platePath(cut)));
            var g = logoGeometry(cut, logo);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(logo.img, g.x, g.y, g.w, g.h);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    function toSVG(model, design, logo, px) {
        var m = design.margin, total = model.size + m * 2;
        var cut = logo ? logoCut(model, design) : null;
        var paths = buildPaths(model, design, cut);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' +
            total + ' ' + total + '" width="' + px + '" height="' + px + '">' +
            '<rect width="' + total + '" height="' + total + '" fill="' + design.bg + '"/>' +
            '<g transform="translate(' + m + ' ' + m + ')">' +
            '<path fill="' + design.fg + '" d="' + paths.data + '"/>' +
            '<path fill="' + design.fg + '" fill-rule="evenodd" d="' + paths.eyes + '"/>';
        if (cut) {
            var g = logoGeometry(cut, logo);
            svg += '<path fill="' + design.bg + '" d="' + platePath(cut) + '"/>' +
                '<image x="' + num(g.x) + '" y="' + num(g.y) + '" width="' + num(g.w) + '" height="' + num(g.h) +
                '" xlink:href="' + logo.url + '"/>';
        }
        return svg + '</g></svg>';
    }

    // ------------------------------------------------------------------
    //  Fields (built from the KINDS table)
    // ------------------------------------------------------------------
    var fieldsEl = $('fields');

    function fieldHTML(kind, f) {
        if (f.type === 'help') return '<p class="control-help field-wide">' + esc(f.text) + '</p>';
        var id = 'f-' + kind + '-' + f.id;
        var v = state.values[kind][f.id];
        var cls = 'field' + (f.wide ? ' wide' : '');
        if (f.type === 'checkbox') {
            return '<div class="' + cls + '" data-wrap="' + f.id + '"><label class="check"><input type="checkbox" id="' + id +
                '" data-field="' + f.id + '"' + (v ? ' checked' : '') + ' /><span>' + esc(f.label) + '</span></label></div>';
        }
        var control;
        if (f.type === 'textarea') {
            control = '<textarea id="' + id + '" data-field="' + f.id + '" rows="' + (f.rows || 4) +
                '" spellcheck="false" autocapitalize="off" placeholder="' + esc(f.placeholder || '') + '">' + esc(v || '') + '</textarea>';
        } else if (f.type === 'select') {
            var cur = v || f.value;
            control = '<select id="' + id + '" data-field="' + f.id + '">' + f.options.map(function (o) {
                return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
            }).join('') + '</select>';
        } else {
            control = '<input type="' + (f.type || 'text') + '" id="' + id + '" data-field="' + f.id +
                '" value="' + esc(v || '') + '" autocomplete="off" />';
        }
        return '<div class="' + cls + '" data-wrap="' + f.id + '"><label for="' + id + '">' + esc(f.label) + '</label>' + control + '</div>';
    }

    function imageFieldsHTML() {
        return '<div class="field wide">' +
            '<label class="drop" id="imgDrop"><input type="file" id="imgFile" accept="image/*" class="sr-only" />' +
            '<span class="drop-title">Choose, drop, or paste an image</span>' +
            '<span class="drop-sub">It is shrunk to a small thumbnail so it fits inside the code.</span></label>' +
            '<div class="img-result" id="imgResult" hidden>' +
            '<img id="imgThumb" alt="Thumbnail that will be stored in the code" />' +
            '<div class="img-info"><strong id="imgDims"></strong><span id="imgSize"></span></div>' +
            '<button type="button" class="btn btn-quiet" id="imgClear">Remove</button></div>' +
            '<p class="callout">Phones usually show an embedded picture as text instead of opening it. ' +
            'This works for tiny icons and demos. To share a real photo, upload it somewhere and make a code from the link.</p>' +
            '</div>';
    }

    function renderFields() {
        var kind = state.kind;
        fieldsEl.innerHTML = kind === 'image' ? imageFieldsHTML()
            : KINDS[kind].fields.map(function (f) { return fieldHTML(kind, f); }).join('');
        syncVisibility();
        if (kind === 'image') {
            $('imgFile').addEventListener('change', function (e) {
                if (e.target.files[0]) setPayloadImage(e.target.files[0]);
                e.target.value = '';
            });
            $('imgClear').addEventListener('click', function () { state.image = null; renderImageResult(); render(); });
            renderImageResult();
        }
    }

    function syncVisibility() {
        if (state.kind === 'image') return;
        KINDS[state.kind].fields.forEach(function (f) {
            if (!f.showIf) return;
            var wrap = fieldsEl.querySelector('[data-wrap="' + f.id + '"]');
            if (wrap) wrap.hidden = !f.showIf(state.values[state.kind]);
        });
    }

    fieldsEl.addEventListener('input', onFieldInput);
    fieldsEl.addEventListener('change', onFieldInput);
    function onFieldInput(e) {
        var t = e.target, id = t.dataset && t.dataset.field;
        if (!id) return;
        state.values[state.kind][id] = t.type === 'checkbox' ? t.checked : t.value;
        syncVisibility();
        scheduleRender();
    }

    // ------------------------------------------------------------------
    //  Image as payload (thumbnail shrunk to fit the code)
    // ------------------------------------------------------------------
    var webpOk = null;
    function imageMime() {
        if (webpOk === null) {
            var c = document.createElement('canvas');
            c.width = c.height = 1;
            webpOk = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
        }
        return webpOk ? 'image/webp' : 'image/jpeg';
    }

    function loadImage(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                if (!img.naturalWidth) { reject(new Error('empty')); return; }
                resolve(img);
            };
            img.onerror = function () { reject(new Error('unreadable')); };
            img.src = url;
        });
    }

    function fitImage(img) {
        var budget = QR.maxBytes(ceilingLevel());
        var mime = imageMime();
        var iw = img.naturalWidth, ih = img.naturalHeight, longest = Math.max(iw, ih);
        var dims = [192, 160, 128, 112, 96, 80, 64, 56, 48, 40, 32, 24, 16];
        var attempts = [];
        dims.forEach(function (d) { attempts.push([d, 0.8], [d, 0.55]); });
        dims.forEach(function (d) { attempts.push([d, 0.3]); });
        var seen = {};
        for (var i = 0; i < attempts.length; i++) {
            var k = Math.min(1, attempts[i][0] / longest);
            var w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
            var key = w + 'x' + h + 'x' + attempts[i][1];
            if (seen[key]) continue;
            seen[key] = true;
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            var url = c.toDataURL(mime, attempts[i][1]);
            if (url.length <= budget) return { url: url, w: w, h: h, mime: mime, bytes: url.length };
        }
        return null;
    }

    async function setPayloadImage(file) {
        try {
            var img = await loadImage(file);
            var fit = fitImage(img);
            if (!fit) { toast('That image cannot be shrunk small enough to fit in a QR code.', 'error'); return; }
            fit.source = img;
            state.image = fit;
            if (state.kind !== 'image') setKind('image'); else { renderImageResult(); render(); }
        } catch (e) {
            toast('Could not read that image.', 'error');
        }
    }

    function renderImageResult() {
        var box = $('imgResult');
        if (!box) return;
        var im = state.image;
        box.hidden = !im;
        if (!im) return;
        $('imgThumb').src = im.url;
        $('imgThumb').style.width = Math.max(48, Math.min(96, im.w)) + 'px';
        $('imgDims').textContent = im.w + ' \u00d7 ' + im.h + ' px ' + (im.mime === 'image/webp' ? 'WebP' : 'JPEG');
        $('imgSize').textContent = formatBytes(im.bytes) + ' of ' + formatBytes(QR.maxBytes(ceilingLevel())) + ' available';
    }

    // ------------------------------------------------------------------
    //  Logo
    // ------------------------------------------------------------------
    async function setLogo(file) {
        try {
            var src = await loadImage(file);
            var k = Math.min(1, 512 / Math.max(src.naturalWidth, src.naturalHeight));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(src.naturalWidth * k));
            c.height = Math.max(1, Math.round(src.naturalHeight * k));
            c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
            var url = c.toDataURL('image/png');
            var img = new Image();
            await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = url; });
            state.logo = { img: img, url: url };
            syncLogoUI();
            render();
            toast('Logo added');
        } catch (e) {
            toast('Could not read that image.', 'error');
        }
    }

    function syncLogoUI() {
        var has = !!state.logo;
        $('logoThumb').hidden = !has;
        $('logoRemove').hidden = !has;
        $('logoSizeWrap').hidden = !has;
        if (has) $('logoThumb').src = state.logo.url;
        $('logoDropText').textContent = has ? 'Replace logo' : 'Choose, drop, or paste an image';
    }

    // ------------------------------------------------------------------
    //  Rendering pipeline
    // ------------------------------------------------------------------
    var preview = $('preview');
    var previewCtx = preview.getContext('2d');
    var renderTimer = 0;

    function scheduleRender() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(render, 80);
    }

    function activeLogo() {
        return state.kind === 'image' ? null : state.logo;
    }

    function setStage(name) {
        $('viewfinder').dataset.state = name;
        preview.hidden = name !== 'ready';
        $('stageEmpty').hidden = name !== 'empty';
        $('stageError').hidden = name !== 'error';
        $('readout').hidden = name !== 'ready';
        ['dlPng', 'dlSvg', 'dlPdf', 'copyImg', 'saveBtn'].forEach(function (id) { $(id).disabled = name !== 'ready'; });
        if (name !== 'ready') { $('notes').innerHTML = ''; state.current = null; }
        if (name === 'empty') $('meter').hidden = true;
    }

    function updateMeter(bytes, over, max) {
        var meter = $('meter');
        meter.hidden = false;
        var ratio = Math.min(1, bytes / max);
        $('meterFill').style.width = (ratio * 100).toFixed(1) + '%';
        meter.dataset.level = over ? 'over' : ratio > 0.85 ? 'high' : 'ok';
        $('meterText').textContent = over
            ? bytes.toLocaleString() + ' bytes is more than a QR code can hold (' + max.toLocaleString() + ').'
            : bytes.toLocaleString() + ' of ' + max.toLocaleString() + ' bytes';
    }

    function updateHint(payload) {
        var hint = $('fieldHint');
        var t = (state.kind === 'text' ? payload : '').trim();
        var bare = t && t.indexOf('\n') < 0 && !/^[a-z][a-z0-9+.-]*:/i.test(t) &&
            /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t);
        hint.hidden = !bare;
        if (bare) {
            hint.innerHTML = 'This looks like a web address. <button type="button" class="link-btn" id="addHttps">Add https://</button> so phones open it as a link.';
        }
    }

    function luminance(hex) {
        var c = [1, 3, 5].map(function (i) {
            var v = parseInt(hex.substr(i, 2), 16) / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    function collectNotes(model, level) {
        var d = state.design, notes = [];
        var lf = luminance(d.fg), lb = luminance(d.bg);
        var ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
        if (lf > lb) {
            notes.push(['warn', 'Light dots on a dark background: many scanners cannot read inverted codes.']);
        } else if (ratio < 4) {
            notes.push(['warn', 'Low contrast (' + ratio.toFixed(1) + ' to 1). Aim for at least 4 to 1 so scanners can tell dots from background.']);
        }
        var total = model.size + d.margin * 2;
        var perModule = d.size / total;
        if (perModule < 3) {
            notes.push(['warn', 'Each module is only ' + perModule.toFixed(1) + ' px at this export size. Raise the size or shorten the content.']);
        }
        if (activeLogo() && (level === 'L' || level === 'M')) {
            notes.push(['warn', 'A logo needs level Q or H to stay scannable. Shorten the content or shrink the logo.']);
        }
        if (d.margin < 2) {
            notes.push(['warn', 'A margin under 2 modules can stop some scanners from finding the code.']);
        }
        if (model.version >= 10) {
            notes.push(['info', 'Dense code (version ' + model.version + '). Print it at least ' + Math.ceil(total * 0.4 / 10) + ' cm wide.']);
        }
        return notes;
    }

    var ECC_RECOVERY = { L: 7, M: 15, Q: 25, H: 30 };

    function render() {
        var payload = payloadFor(state.kind, state.values[state.kind], state.image);
        updateHint(payload);

        var empty = EMPTY_COPY[state.kind];
        $('stageEmpty').querySelector('.stage-title').textContent = empty[0];
        $('stageEmpty').querySelector('.stage-sub').textContent = empty[1];

        if (!payload) { setStage('empty'); return; }

        var bytes = utf8(payload);
        var model;
        var key = [state.design.ecc, !!activeLogo(), state.kind, payload].join('\u0000');
        if (cache.key === key) {
            model = cache.model;
        } else {
            try {
                model = encodeWith(bytes, { ecc: state.design.ecc, kind: state.kind, logo: !!activeLogo() });
            } catch (err) {
                setStage('error');
                if (err.name === 'CapacityError') {
                    $('stageErrorTitle').textContent = 'Too much for one QR code';
                    $('stageErrorText').textContent = state.design.ecc === 'auto'
                        ? 'Shorten the content. The limit is ' + err.max.toLocaleString() + ' bytes.'
                        : 'Shorten the content or choose a lower error correction level. Level ' + err.level +
                        ' holds ' + err.max.toLocaleString() + ' bytes.';
                    updateMeter(bytes.length, true, err.max);
                } else {
                    console.error(err);
                    $('stageErrorTitle').textContent = 'Could not build the code';
                    $('stageErrorText').textContent = 'Something unexpected happened. Try changing the content.';
                }
                return;
            }
            cache = { key: key, model: model };
        }

        state.current = { model: model, payload: payload, bytes: bytes.length };
        setStage('ready');
        paint(previewCtx, preview.width, model, state.design, activeLogo());
        preview.setAttribute('aria-label', 'QR code for ' + labelFor(state.kind, state.values[state.kind], state.image));

        var d = state.design, total = model.size + d.margin * 2;
        $('roGrid').textContent = model.size + ' \u00d7 ' + model.size + ' modules (version ' + model.version + ')';
        $('roEcc').textContent = 'Level ' + model.level + ', recovers up to ~' + ECC_RECOVERY[model.level] + '%';
        $('roExport').textContent = d.size + ' px, ' + (d.size / total).toFixed(1) + ' px per module';
        updateMeter(bytes.length, false, QR.maxBytes(ceilingLevel()));

        $('notes').innerHTML = collectNotes(model, model.level).map(function (n) {
            return '<li class="note note-' + n[0] + '">' + esc(n[1]) + '</li>';
        }).join('');
    }

    // ------------------------------------------------------------------
    //  Exports
    // ------------------------------------------------------------------
    function fileBase() {
        return 'qr-' + (slug(labelFor(state.kind, state.values[state.kind], state.image)) || 'code');
    }

    function renderCanvas(px) {
        var c = document.createElement('canvas');
        c.width = c.height = px;
        paint(c.getContext('2d'), px, state.current.model, state.design, activeLogo());
        return c;
    }

    function canvasBlob(canvas) {
        return new Promise(function (res, rej) {
            canvas.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob failed')); }, 'image/png');
        });
    }

    async function exportPNG() {
        if (!state.current) return;
        try {
            download(await canvasBlob(renderCanvas(state.design.size)), fileBase() + '.png');
            toast('PNG downloaded');
            saveToHistory(true);
        } catch (e) { toast('Could not create the PNG.', 'error'); }
    }

    function exportSVG() {
        if (!state.current) return;
        var svg = toSVG(state.current.model, state.design, activeLogo(), state.design.size);
        download(new Blob([svg], { type: 'image/svg+xml' }), fileBase() + '.svg');
        toast('SVG downloaded');
        saveToHistory(true);
    }

    async function copyImage() {
        if (!state.current) return;
        try {
            var canvas = renderCanvas(Math.min(state.design.size, 1024));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(canvas) })]);
            toast('Image copied');
            saveToHistory(true);
        } catch (e) {
            toast('Your browser blocked copying. Use Download PNG instead.', 'error');
        }
    }

    function buildPDF(imgBytes, w, h) {
        var parts = [], offsets = [], len = 0;
        var add = function (x) {
            var b = typeof x === 'string' ? enc.encode(x) : x;
            parts.push(b);
            len += b.length;
        };
        var obj = function (n, body) { offsets[n] = len; add(n + ' 0 obj\n' + body + '\nendobj\n'); };
        var side = 340.16;               // 12 cm
        var x = (595.28 - side) / 2, y = (841.89 - side) / 2 + 40;

        add('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
        obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
        obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
        obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
        offsets[4] = len;
        add('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
            ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + imgBytes.length + ' >>\nstream\n');
        add(imgBytes);
        add('\nendstream\nendobj\n');
        var content = 'q\n' + side + ' 0 0 ' + side + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm\n/Im0 Do\nQ\n';
        offsets[5] = len;
        add('5 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\nendobj\n');
        var xref = len;
        var table = 'xref\n0 6\n0000000000 65535 f \n';
        for (var n = 1; n <= 5; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
        add(table + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
        return new Blob(parts, { type: 'application/pdf' });
    }

    async function exportPDF() {
        if (!state.current) return;
        if (typeof CompressionStream === 'undefined') {
            toast('PDF export needs a newer browser. Use SVG or PNG instead.', 'error');
            return;
        }
        try {
            var px = Math.max(1200, state.design.size);
            var canvas = renderCanvas(px);
            var rgba = canvas.getContext('2d').getImageData(0, 0, px, px).data;
            var rgb = new Uint8Array(px * px * 3);
            for (var i = 0, j = 0; i < rgba.length; i += 4) {
                rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];
            }
            var stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'));
            var deflated = new Uint8Array(await new Response(stream).arrayBuffer());
            download(buildPDF(deflated, px, px), fileBase() + '.pdf');
            toast('PDF downloaded');
            saveToHistory(true);
        } catch (e) { toast('Could not create the PDF.', 'error'); }
    }

    // Minimal ZIP writer (stored, no compression: PNGs are already compressed).
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(buf) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function makeZip(files) {
        var chunks = [], central = [], offset = 0;
        var now = new Date();
        var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        files.forEach(function (f) {
            var name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
            var lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
            lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
            lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
            chunks.push(new Uint8Array(lh.buffer), name, f.data);

            var ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
            ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
            ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), name);
            offset += 30 + name.length + size;
        });
        var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
        var end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
        return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
    }

    // ------------------------------------------------------------------
    //  History
    // ------------------------------------------------------------------
    function designSnapshot() {
        var d = state.design;
        return { fg: d.fg, bg: d.bg, dots: d.dots, eyes: d.eyes, ecc: d.ecc, margin: d.margin };
    }

    function saveToHistory(silent) {
        if (!state.current) return;
        var entry = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            ts: Date.now(),
            kind: state.kind,
            values: state.kind === 'image' ? {} : clone(state.values[state.kind]),
            image: state.kind === 'image' && state.image
                ? { url: state.image.url, w: state.image.w, h: state.image.h, mime: state.image.mime, bytes: state.image.bytes } : null,
            design: designSnapshot(),
            label: labelFor(state.kind, state.values[state.kind], state.image)
        };
        var sig = JSON.stringify([entry.kind, state.current.payload, entry.design]);
        history = history.filter(function (h) {
            return JSON.stringify([h.kind, payloadFor(h.kind, h.values, h.image), h.design]) !== sig;
        });
        history.unshift(entry);
        history = history.slice(0, 30);
        while (!store.set('qrs.history', history) && history.length > 1) history.pop();
        renderHistory();
        if (!silent) toast('Saved to history');
    }

    function renderHistory() {
        var grid = $('historyGrid');
        $('historyCount').textContent = history.length;
        grid.innerHTML = '';
        if (!history.length) {
            grid.innerHTML = '<p class="history-empty">Codes you download, copy, or save appear here.</p>';
            return;
        }
        history.forEach(function (entry) {
            var item = document.createElement('div');
            item.className = 'history-item';

            var load = document.createElement('button');
            load.type = 'button';
            load.className = 'history-load';
            load.setAttribute('aria-label', 'Load ' + entry.label);
            var canvas = document.createElement('canvas');
            canvas.width = canvas.height = 128;
            try {
                var payload = payloadFor(entry.kind, entry.values, entry.image);
                var model = encodeWith(utf8(payload), { ecc: entry.design.ecc, kind: entry.kind, logo: false });
                paint(canvas.getContext('2d'), 128, model, Object.assign({}, DEFAULT_DESIGN, entry.design, { margin: 2 }), null);
            } catch (e) { /* leave the thumbnail blank */ }
            var label = document.createElement('span');
            label.className = 'history-label';
            label.textContent = entry.label;
            load.append(canvas, label);
            load.addEventListener('click', function () { restoreEntry(entry); });

            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'history-del';
            del.setAttribute('aria-label', 'Remove ' + entry.label + ' from history');
            del.textContent = '\u00d7';
            del.addEventListener('click', function () {
                history = history.filter(function (h) { return h.id !== entry.id; });
                store.set('qrs.history', history);
                renderHistory();
            });

            item.append(load, del);
            grid.appendChild(item);
        });
    }

    function restoreEntry(entry) {
        state.values[entry.kind] = clone(entry.values);
        Object.assign(state.design, entry.design);
        if (entry.kind === 'image') state.image = entry.image ? Object.assign({ source: null }, entry.image) : null;
        store.set('qrs.design', state.design);
        syncDesignUI();
        setKind(entry.kind);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ------------------------------------------------------------------
    //  Bulk
    // ------------------------------------------------------------------
    function parseCSV(text) {
        var rows = [], row = [], cell = '', quoted = false;
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (quoted) {
                if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
                else cell += c;
            } else if (c === '"' && cell === '') quoted = true;
            else if (c === ',') { row.push(cell); cell = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += c;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }

    function parseBulk(text) {
        var lines = text.replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
        if (!lines.length) return [];
        var head = parseCSV(lines[0])[0].map(function (c) { return c.trim().toLowerCase(); });
        var dataCol = head.findIndex(function (c) { return ['data', 'text', 'url', 'link', 'content'].indexOf(c) >= 0; });
        if (dataCol < 0) return lines.map(function (l) { return { data: l.trim(), name: '' }; });
        var nameCol = head.findIndex(function (c) { return ['name', 'filename', 'file', 'label'].indexOf(c) >= 0; });
        return parseCSV(lines.slice(1).join('\n')).filter(function (r) { return (r[dataCol] || '').trim(); })
            .map(function (r) { return { data: r[dataCol].trim(), name: nameCol >= 0 ? (r[nameCol] || '').trim() : '' }; });
    }

    async function bulkGenerate() {
        var status = $('bulkStatus');
        var items = parseBulk($('bulkText').value);
        if (!items.length) { status.textContent = 'Add at least one line first.'; return; }
        if (items.length > 500) { status.textContent = 'That is ' + items.length + ' rows. Please keep it to 500 or fewer at a time.'; return; }

        var d = state.design, files = [], skipped = [], used = {};
        $('bulkGo').disabled = true;
        for (var i = 0; i < items.length; i++) {
            var it = items[i], model;
            try {
                model = encodeWith(utf8(it.data), { ecc: d.ecc, kind: 'text', logo: !!state.logo });
            } catch (e) { skipped.push(i + 1); continue; }
            var canvas = document.createElement('canvas');
            canvas.width = canvas.height = d.size;
            paint(canvas.getContext('2d'), d.size, model, d, state.logo);
            var buf = new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());
            var base = slug(it.name || it.data) || 'code-' + (i + 1), name = base, n = 2;
            while (used[name]) name = base + '-' + n++;
            used[name] = true;
            files.push({ name: name + '.png', data: buf });
            if (i % 4 === 3) { status.textContent = 'Rendering ' + (i + 1) + ' of ' + items.length + '...'; await tick(); }
        }
        $('bulkGo').disabled = false;
        if (!files.length) { status.textContent = 'No codes were created. Every row was too long.'; return; }
        download(makeZip(files), 'qr-codes.zip');
        status.textContent = 'Downloaded ' + files.length + ' codes.' +
            (skipped.length ? ' Skipped ' + skipped.length + ' too long (line ' + skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? '...' : '') + ').' : '');
    }

    // ------------------------------------------------------------------
    //  Scanner (camera). The library loads only when you open the scanner.
    // ------------------------------------------------------------------
    var scanner = null, scanFocus = null;
    var scanModal = $('scanner');

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('load')); };
            document.head.appendChild(s);
        });
    }

    async function openScanner() {
        scanFocus = document.activeElement;
        scanModal.hidden = false;
        $('scanResult').hidden = true;
        $('scanClose').focus();
        var status = $('scanStatus');
        status.textContent = 'Starting the camera...';
        try {
            if (!window.Html5Qrcode) await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
        } catch (e) {
            status.textContent = 'The scanner loads a small library the first time. Connect to the internet once and try again.';
            return;
        }
        try {
            scanner = new Html5Qrcode('scannerView');
            await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, onScanned, function () {});
            status.textContent = 'Point the camera at a QR code.';
        } catch (err) {
            status.textContent = 'Could not start the camera. Allow camera access and make sure the page is on https or localhost.';
        }
    }

    async function closeScanner() {
        scanModal.hidden = true;
        if (scanner) {
            try { await scanner.stop(); scanner.clear(); } catch (e) { /* already stopped */ }
            scanner = null;
        }
        if (scanFocus && scanFocus.focus) scanFocus.focus();
    }

    async function onScanned(text) {
        if (scanner) { try { await scanner.stop(); } catch (e) { /* ignore */ } }
        $('scanStatus').textContent = 'Scanned.';
        $('scanText').textContent = text;
        $('scanResult').hidden = false;
        var open = $('scanOpen');
        try {
            var u = new URL(text);
            if (u.protocol === 'http:' || u.protocol === 'https:') { open.href = u.href; open.hidden = false; }
            else open.hidden = true;
        } catch (e) { open.hidden = true; }
    }

    // ------------------------------------------------------------------
    //  Pasting and dropping images
    // ------------------------------------------------------------------
    var pendingImage = null;
    var choice = $('imageChoice');

    function routeImage(file) {
        if (state.kind === 'image') { setPayloadImage(file); return; }
        pendingImage = file;
        choice.hidden = false;
        $('choiceLogo').focus();
    }

    function closeChoice() { choice.hidden = true; pendingImage = null; }

    $('choiceLogo').addEventListener('click', function () { var f = pendingImage; closeChoice(); if (f) setLogo(f); });
    $('choiceCode').addEventListener('click', function () { var f = pendingImage; closeChoice(); if (f) setPayloadImage(f); });
    $('choiceCancel').addEventListener('click', closeChoice);

    document.addEventListener('paste', function (e) {
        var cd = e.clipboardData;
        if (!cd) return;
        var file = null;
        for (var i = 0; i < cd.items.length; i++) {
            if (cd.items[i].kind === 'file' && cd.items[i].type.indexOf('image/') === 0) { file = cd.items[i].getAsFile(); break; }
        }
        if (file) { e.preventDefault(); routeImage(file); return; }

        var t = e.target;
        if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
        var text = cd.getData('text/plain');
        if (!text) return;
        e.preventDefault();
        state.values.text.text = text;
        if (state.kind !== 'text') setKind('text');
        else { var ta = $('f-text-text'); if (ta) ta.value = text; render(); }
        toast('Pasted into Text');
    });

    var dragDepth = 0;
    var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
    window.addEventListener('dragenter', function (e) { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
    window.addEventListener('dragleave', function (e) { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('dragging');
        var f = e.dataTransfer.files[0];
        if (f && f.type.indexOf('image/') === 0) routeImage(f);
        else toast('Drop an image file.', 'error');
    });

    // ------------------------------------------------------------------
    //  Controls wiring
    // ------------------------------------------------------------------
    function setKind(kind) {
        state.kind = kind;
        var radio = document.querySelector('input[name="kind"][value="' + kind + '"]');
        if (radio) radio.checked = true;
        $('logoControl').hidden = kind === 'image';
        renderFields();
        render();
    }

    function syncDesignUI() {
        var d = state.design;
        $('fgColor').value = d.fg; $('fgHex').textContent = d.fg;
        $('bgColor').value = d.bg; $('bgHex').textContent = d.bg;
        ['dots', 'eyes'].forEach(function (name) {
            var r = document.querySelector('input[name="' + name + '"][value="' + d[name] + '"]');
            if (r) r.checked = true;
        });
        var e = document.querySelector('input[name="ecc"][value="' + d.ecc + '"]');
        if (e) e.checked = true;
        $('sizeRange').value = d.size; $('sizeOut').textContent = d.size + ' px';
        $('marginRange').value = d.margin; $('marginOut').textContent = d.margin + (d.margin === 1 ? ' module' : ' modules');
        $('logoRange').value = d.logoSize; $('logoOut').textContent = d.logoSize + '%';
    }

    function designChanged() {
        store.set('qrs.design', state.design);
        scheduleRender();
    }

    $('kindGroup').addEventListener('change', function (e) { setKind(e.target.value); });
    $('fgColor').addEventListener('input', function (e) { state.design.fg = e.target.value; $('fgHex').textContent = e.target.value; designChanged(); });
    $('bgColor').addEventListener('input', function (e) { state.design.bg = e.target.value; $('bgHex').textContent = e.target.value; designChanged(); });
    $('dotsGroup').addEventListener('change', function (e) { state.design.dots = e.target.value; designChanged(); });
    $('eyesGroup').addEventListener('change', function (e) { state.design.eyes = e.target.value; designChanged(); });
    $('eccGroup').addEventListener('change', function (e) {
        state.design.ecc = e.target.value;
        if (state.kind === 'image' && state.image && state.image.source) {
            var fit = fitImage(state.image.source);
            if (fit) { fit.source = state.image.source; state.image = fit; renderImageResult(); }
            else toast('At this level the image no longer fits. Try a lower level.', 'error');
        }
        designChanged();
    });
    $('sizeRange').addEventListener('input', function (e) { state.design.size = +e.target.value; $('sizeOut').textContent = e.target.value + ' px'; designChanged(); });
    $('marginRange').addEventListener('input', function (e) {
        state.design.margin = +e.target.value;
        $('marginOut').textContent = e.target.value + (e.target.value === '1' ? ' module' : ' modules');
        designChanged();
    });
    $('logoRange').addEventListener('input', function (e) { state.design.logoSize = +e.target.value; $('logoOut').textContent = e.target.value + '%'; designChanged(); });

    $('logoFile').addEventListener('change', function (e) { if (e.target.files[0]) setLogo(e.target.files[0]); e.target.value = ''; });
    $('logoRemove').addEventListener('click', function () { state.logo = null; syncLogoUI(); render(); });

    $('fieldHint').addEventListener('click', function (e) {
        if (e.target.id !== 'addHttps') return;
        var v = (state.values.text.text || '').trim();
        state.values.text.text = 'https://' + v;
        var ta = $('f-text-text');
        if (ta) ta.value = state.values.text.text;
        render();
    });

    $('dlPng').addEventListener('click', exportPNG);
    $('dlSvg').addEventListener('click', exportSVG);
    $('dlPdf').addEventListener('click', exportPDF);
    $('copyImg').addEventListener('click', copyImage);
    $('saveBtn').addEventListener('click', function () { saveToHistory(false); });

    $('historyClear').addEventListener('click', function () {
        if (!history.length) return;
        if (confirm('Remove all ' + history.length + ' saved codes?')) {
            history = [];
            store.set('qrs.history', history);
            renderHistory();
        }
    });
    $('historyExport').addEventListener('click', function () {
        if (!history.length) { toast('Nothing to export yet.'); return; }
        download(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }), 'qr-history.json');
    });

    $('bulkGo').addEventListener('click', bulkGenerate);
    $('bulkFile').addEventListener('change', async function (e) {
        var f = e.target.files[0];
        if (!f) return;
        $('bulkText').value = await f.text();
        $('bulkStatus').textContent = 'Loaded ' + parseBulk($('bulkText').value).length + ' rows from ' + f.name + '.';
        e.target.value = '';
    });

    $('scanBtn').addEventListener('click', openScanner);
    $('scanClose').addEventListener('click', closeScanner);
    scanModal.addEventListener('mousedown', function (e) { if (e.target === scanModal) closeScanner(); });
    $('scanUse').addEventListener('click', function () {
        state.values.text.text = $('scanText').textContent;
        closeScanner();
        setKind('text');
    });
    $('scanCopy').addEventListener('click', function () {
        navigator.clipboard.writeText($('scanText').textContent).then(function () { toast('Copied'); }, function () { toast('Could not copy.', 'error'); });
    });

    var themeBtn = $('themeBtn');
    function syncThemeButton() {
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    }
    themeBtn.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('qrs.theme', next); } catch (e) { /* private mode */ }
        syncThemeButton();
    });

    document.addEventListener('keydown', function (e) {
        var mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            if (!$('dlPng').disabled) exportPNG();
        } else if (mod && e.key === 'Enter') {
            e.preventDefault();
            saveToHistory(false);
        } else if (e.key === 'Escape') {
            if (!scanModal.hidden) closeScanner();
            else if (!choice.hidden) closeChoice();
        } else if (e.key === 'Tab') {
            var box = !scanModal.hidden ? scanModal : !choice.hidden ? choice : null;
            if (!box) return;
            var items = box.querySelectorAll('button:not([hidden]):not([disabled]), a[href]:not([hidden]), video');
            if (!items.length) return;
            var first = items[0], last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });

    // ------------------------------------------------------------------
    //  Start
    // ------------------------------------------------------------------
    syncThemeButton();
    syncDesignUI();
    syncLogoUI();
    renderHistory();
    setKind('text');
    var firstField = $('f-text-text');
    if (firstField) firstField.focus();
})();
