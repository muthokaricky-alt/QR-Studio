/*
 * qr.js - a small, dependency-free QR Code encoder.
 *
 * Supports byte mode (any UTF-8 text), versions 1-40 and error correction
 * levels L, M, Q and H. It returns the raw module grid so the app can draw
 * it however it likes (square, rounded, dots, with a logo cut-out, as SVG...).
 *
 *   const qr = QR.encode(new TextEncoder().encode('hello'), { level: 'M' });
 *   qr.size          // modules per side, e.g. 21
 *   qr.get(x, y)     // 1 = dark module, 0 = light (out of range = 0)
 *   qr.version       // 1..40
 *   qr.level         // 'L' | 'M' | 'Q' | 'H' (may be higher than requested, see `boost`)
 *
 *   QR.maxBytes('Q') // most bytes a level-Q code can hold (version 40)
 *
 * Throws QR.CapacityError when the data does not fit.
 */
(function (root) {
    'use strict';

    var LEVELS = ['L', 'M', 'Q', 'H'];
    var FORMAT_BITS = [1, 0, 3, 2]; // format-info bits for L, M, Q, H

    // Index 0 is padding so the arrays can be indexed by version (1..40).
    var ECC_PER_BLOCK = [
        [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
        [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
    ];
    var NUM_BLOCKS = [
        [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
        [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
        [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
        [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
    ];

    function CapacityError(max, level) {
        var e = new Error('Data is too long for a QR code at level ' + level + ' (max ' + max + ' bytes).');
        e.name = 'CapacityError';
        e.max = max;
        e.level = level;
        return e;
    }

    // ---- sizes and capacities ------------------------------------------------

    function rawDataModules(ver) {
        var n = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            var align = Math.floor(ver / 7) + 2;
            n -= (25 * align - 10) * align - 55;
            if (ver >= 7) n -= 36;
        }
        return n;
    }

    function dataCodewords(ver, ecl) {
        return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
    }

    function countBits(ver) {
        return ver < 10 ? 8 : 16;
    }

    function maxBytes(level, ver) {
        var ecl = LEVELS.indexOf(level);
        ver = ver || 40;
        return Math.floor((dataCodewords(ver, ecl) * 8 - 4 - countBits(ver)) / 8);
    }

    // ---- Reed-Solomon over GF(256) ----------------------------------------------

    function gfMul(x, y) {
        var z = 0;
        for (var i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11D);
            z ^= ((y >>> i) & 1) * x;
        }
        return z;
    }

    function rsDivisor(degree) {
        var result = [];
        for (var i = 0; i < degree; i++) result.push(0);
        result[degree - 1] = 1;
        var root = 1;
        for (var d = 0; d < degree; d++) {
            for (var j = 0; j < result.length; j++) {
                result[j] = gfMul(result[j], root);
                if (j + 1 < result.length) result[j] ^= result[j + 1];
            }
            root = gfMul(root, 0x02);
        }
        return result;
    }

    function rsRemainder(data, divisor) {
        var result = divisor.map(function () { return 0; });
        data.forEach(function (b) {
            var factor = b ^ result.shift();
            result.push(0);
            divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
        });
        return result;
    }

    function addEccAndInterleave(data, ver, ecl) {
        var numBlocks = NUM_BLOCKS[ecl][ver];
        var blockEccLen = ECC_PER_BLOCK[ecl][ver];
        var rawCodewords = Math.floor(rawDataModules(ver) / 8);
        var numShort = numBlocks - (rawCodewords % numBlocks);
        var shortLen = Math.floor(rawCodewords / numBlocks);

        var blocks = [];
        var divisor = rsDivisor(blockEccLen);
        for (var i = 0, k = 0; i < numBlocks; i++) {
            var dat = data.slice(k, k + shortLen - blockEccLen + (i < numShort ? 0 : 1));
            k += dat.length;
            var ecc = rsRemainder(dat, divisor);
            if (i < numShort) dat.push(0); // placeholder so all blocks line up
            blocks.push(dat.concat(ecc));
        }

        var result = [];
        for (var col = 0; col < blocks[0].length; col++) {
            for (var b = 0; b < blocks.length; b++) {
                if (col !== shortLen - blockEccLen || b >= numShort) result.push(blocks[b][col]);
            }
        }
        return result;
    }

    // ---- matrix construction ------------------------------------------------------

    function alignmentPositions(ver) {
        if (ver === 1) return [];
        var size = ver * 4 + 17;
        var num = Math.floor(ver / 7) + 2;
        var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
        var result = [6];
        for (var pos = size - 7; result.length < num; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    function bit(x, i) {
        return (x >>> i) & 1;
    }

    function Matrix(ver) {
        this.ver = ver;
        this.size = ver * 4 + 17;
        this.m = new Uint8Array(this.size * this.size);   // module colours
        this.f = new Uint8Array(this.size * this.size);   // 1 = function pattern
    }

    Matrix.prototype.setFn = function (x, y, dark) {
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
        this.m[y * this.size + x] = dark ? 1 : 0;
        this.f[y * this.size + x] = 1;
    };

    Matrix.prototype.drawFinder = function (cx, cy) {
        for (var dy = -4; dy <= 4; dy++) {
            for (var dx = -4; dx <= 4; dx++) {
                var dist = Math.max(Math.abs(dx), Math.abs(dy));
                this.setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
            }
        }
    };

    Matrix.prototype.drawAlignment = function (cx, cy) {
        for (var dy = -2; dy <= 2; dy++) {
            for (var dx = -2; dx <= 2; dx++) {
                this.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    };

    Matrix.prototype.drawFormat = function (ecl, mask) {
        var data = (FORMAT_BITS[ecl] << 3) | mask;
        var rem = data;
        for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        var bits = ((data << 10) | rem) ^ 0x5412;
        var s = this.size;
        var k;
        for (k = 0; k <= 5; k++) this.setFn(8, k, bit(bits, k));
        this.setFn(8, 7, bit(bits, 6));
        this.setFn(8, 8, bit(bits, 7));
        this.setFn(7, 8, bit(bits, 8));
        for (k = 9; k < 15; k++) this.setFn(14 - k, 8, bit(bits, k));
        for (k = 0; k < 8; k++) this.setFn(s - 1 - k, 8, bit(bits, k));
        for (k = 8; k < 15; k++) this.setFn(8, s - 15 + k, bit(bits, k));
        this.setFn(8, s - 8, true); // the always-dark module
    };

    Matrix.prototype.drawVersion = function () {
        if (this.ver < 7) return;
        var rem = this.ver;
        for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        var bits = (this.ver << 12) | rem;
        for (var k = 0; k < 18; k++) {
            var b = bit(bits, k);
            var a = this.size - 11 + (k % 3);
            var c = Math.floor(k / 3);
            this.setFn(a, c, b);
            this.setFn(c, a, b);
        }
    };

    Matrix.prototype.drawFunctionPatterns = function () {
        var s = this.size, i;
        for (i = 0; i < s; i++) {
            this.setFn(6, i, i % 2 === 0);
            this.setFn(i, 6, i % 2 === 0);
        }
        this.drawFinder(3, 3);
        this.drawFinder(s - 4, 3);
        this.drawFinder(3, s - 4);

        var pos = alignmentPositions(this.ver);
        var n = pos.length;
        for (i = 0; i < n; i++) {
            for (var j = 0; j < n; j++) {
                var corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
                if (!corner) this.drawAlignment(pos[i], pos[j]);
            }
        }
        this.drawFormat(0, 0); // reserve the area; redrawn once the mask is known
        this.drawVersion();
    };

    Matrix.prototype.drawCodewords = function (data) {
        var s = this.size, i = 0, total = data.length * 8;
        for (var right = s - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (var vert = 0; vert < s; vert++) {
                for (var j = 0; j < 2; j++) {
                    var x = right - j;
                    var upward = ((right + 1) & 2) === 0;
                    var y = upward ? s - 1 - vert : vert;
                    if (!this.f[y * s + x] && i < total) {
                        this.m[y * s + x] = bit(data[i >>> 3], 7 - (i & 7));
                        i++;
                    }
                }
            }
        }
    };

    Matrix.prototype.applyMask = function (mask) {
        var s = this.size;
        for (var y = 0; y < s; y++) {
            for (var x = 0; x < s; x++) {
                var flip;
                switch (mask) {
                    case 0: flip = (x + y) % 2 === 0; break;
                    case 1: flip = y % 2 === 0; break;
                    case 2: flip = x % 3 === 0; break;
                    case 3: flip = (x + y) % 3 === 0; break;
                    case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                    case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                }
                if (flip && !this.f[y * s + x]) this.m[y * s + x] ^= 1;
            }
        }
    };

    // Standard four-rule penalty score; the mask with the lowest score wins.
    Matrix.prototype.penalty = function () {
        var s = this.size, m = this.m, score = 0, x, y, a, b, run, colour;

        // Rule 1: runs of five or more identical modules in a row/column.
        for (var dir = 0; dir < 2; dir++) {
            for (a = 0; a < s; a++) {
                colour = dir === 0 ? m[a * s] : m[a];
                run = 1;
                for (b = 1; b < s; b++) {
                    var c = dir === 0 ? m[a * s + b] : m[b * s + a];
                    if (c === colour) {
                        run++;
                        if (run === 5) score += 3;
                        else if (run > 5) score++;
                    } else {
                        colour = c;
                        run = 1;
                    }
                }
            }
        }

        // Rule 2: 2x2 blocks of one colour.
        for (y = 0; y < s - 1; y++) {
            for (x = 0; x < s - 1; x++) {
                var v = m[y * s + x];
                if (v === m[y * s + x + 1] && v === m[(y + 1) * s + x] && v === m[(y + 1) * s + x + 1]) score += 3;
            }
        }

        // Rule 3: finder-like 1:1:3:1:1 patterns with a light gap on one side.
        var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        var P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
        for (var d2 = 0; d2 < 2; d2++) {
            for (a = 0; a < s; a++) {
                for (b = 0; b <= s - 11; b++) {
                    var ok1 = true, ok2 = true;
                    for (var k = 0; k < 11 && (ok1 || ok2); k++) {
                        var cell = d2 === 0 ? m[a * s + b + k] : m[(b + k) * s + a];
                        if (cell !== P1[k]) ok1 = false;
                        if (cell !== P2[k]) ok2 = false;
                    }
                    if (ok1) score += 40;
                    if (ok2) score += 40;
                }
            }
        }

        // Rule 4: balance of dark and light modules.
        var dark = 0;
        for (var i = 0; i < m.length; i++) dark += m[i];
        var total = s * s;
        var kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        score += kk * 10;

        return score;
    };

    // ---- public API ---------------------------------------------------------------

    /**
     * @param {Uint8Array|number[]} bytes  the payload (use TextEncoder for text)
     * @param {{level?: 'L'|'M'|'Q'|'H', boost?: boolean, minVersion?: number}} [opts]
     *        boost (default true): raise the error-correction level when that
     *        fits in the same version, since the extra protection is free.
     */
    function encode(bytes, opts) {
        opts = opts || {};
        var requested = opts.level || 'M';
        var ecl = LEVELS.indexOf(requested);
        if (ecl < 0) throw new Error('Unknown error correction level: ' + requested);

        var len = bytes.length;
        var ver;
        for (ver = Math.max(1, opts.minVersion || 1); ver <= 40; ver++) {
            if (4 + countBits(ver) + len * 8 <= dataCodewords(ver, ecl) * 8) break;
        }
        if (ver > 40) throw CapacityError(maxBytes(requested), requested);

        var usedBits = 4 + countBits(ver) + len * 8;
        if (opts.boost !== false) {
            for (var next = ecl + 1; next < 4; next++) {
                if (usedBits <= dataCodewords(ver, next) * 8) ecl = next;
            }
        }

        // Assemble the bit stream: mode (byte), length, payload, terminator, padding.
        var bits = [];
        function push(value, n) {
            for (var i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
        }
        push(4, 4);
        push(len, countBits(ver));
        for (var i = 0; i < len; i++) push(bytes[i], 8);

        var capBits = dataCodewords(ver, ecl) * 8;
        push(0, Math.min(4, capBits - bits.length));
        push(0, (8 - (bits.length % 8)) % 8);
        for (var pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) push(pad, 8);

        var data = [];
        for (i = 0; i < capBits / 8; i++) data.push(0);
        bits.forEach(function (b, idx) { data[idx >>> 3] |= b << (7 - (idx & 7)); });

        var codewords = addEccAndInterleave(data, ver, ecl);

        var mx = new Matrix(ver);
        mx.drawFunctionPatterns();
        mx.drawCodewords(codewords);

        var bestMask = 0, bestScore = Infinity;
        for (var mask = 0; mask < 8; mask++) {
            mx.applyMask(mask);
            mx.drawFormat(ecl, mask);
            var score = mx.penalty();
            if (score < bestScore) { bestScore = score; bestMask = mask; }
            mx.applyMask(mask); // XOR again to undo
        }
        mx.applyMask(bestMask);
        mx.drawFormat(ecl, bestMask);

        var size = mx.size, modules = mx.m;
        return {
            version: ver,
            level: LEVELS[ecl],
            mask: bestMask,
            size: size,
            modules: modules,
            get: function (x, y) {
                return x < 0 || y < 0 || x >= size || y >= size ? 0 : modules[y * size + x];
            }
        };
    }

    var QR = {
        encode: encode,
        maxBytes: maxBytes,
        CapacityError: CapacityError,
        LEVELS: LEVELS,
        // exposed for tests
        _tables: { ECC_PER_BLOCK: ECC_PER_BLOCK, NUM_BLOCKS: NUM_BLOCKS, rawDataModules: rawDataModules }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = QR;
    else root.QR = QR;
})(typeof self !== 'undefined' ? self : this);
