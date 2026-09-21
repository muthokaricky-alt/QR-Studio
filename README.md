# QR Studio

A QR code generator that runs entirely in your browser. Paste text or an image, style the code, and export it as PNG, SVG or PDF. Nothing you type or paste is uploaded anywhere.



## Run it

Open `index.html` in a browser. There is nothing to install or build.

The generator has no dependencies. The one exception is the camera scanner, which downloads the small `html5-qrcode` library the first time you open it, so that part needs an internet connection once. The camera also needs the page to be served from `https` or `localhost` (for example `python3 -m http.server`, then open `http://localhost:8000`).

## What it does

- **Paste or type anything.** Press Ctrl+V anywhere on the page to drop text into the generator.
- **Paste or drop an image.** You choose what it does: sit in the middle of the code as a logo, or become the code itself (see below).
- **Content types:** plain text or link, Wi-Fi, contact (vCard), calendar event, and image.
- **Style:** dot color and background, three dot styles (square, rounded, dots), three corner-marker styles (square, rounded, circle), quiet margin, and export size.
- **Error correction:** Auto, or pick L / M / Q / H yourself. Auto uses level H when there is a logo and otherwise the strongest level that fits the same code size.
- **Export:** PNG, SVG (vector, logo included), PDF (A4), or copy the image to the clipboard.
- **History** of the last 30 codes you downloaded, copied or saved (stored only in your browser), with JSON export.
- **Bulk generate:** one code per line, or a CSV with a `data` column and an optional `name` column. Downloads a ZIP of PNGs.
- **Scanner:** read a QR code with your camera.
- Light and dark themes. Shortcuts: Ctrl/Cmd+S downloads the PNG, Ctrl/Cmd+Enter saves to history.

## About images

A QR code holds at most about 3 KB, so a normal photo cannot fit inside one. The Image tab shrinks your picture to a small thumbnail (WebP where the browser supports it, otherwise JPEG), embeds it as a data URI and shows how much of the space it uses. Most phone cameras will show that as text rather than open the picture, so it is best for tiny icons and demos. To share a real photo, upload it somewhere and make a code from the link instead.

## Files

| File | What it is |
|------|-----------|
| `index.html` | Page structure |
| `style.css` | Styles, light and dark |
| `script.js` | The app: content types, drawing, exports, history, bulk, scanner |
| `qr.js` | A small QR encoder (byte mode, versions 1-40, levels L/M/Q/H) with no dependencies |

`qr.js` returns the raw module grid, which is what lets the app draw rounded and dotted styles, cut out space for a logo, and write SVG from the same data.

## Notes on how it was checked

The encoder's block and capacity tables were compared against an independent implementation for all 160 version and level combinations. A maximum-size code for every version and level was decoded with an independent decoder, as were exports of every dot style, corner style and logo combination.

**Live demo:** https://muthokaricky-alt.github.io/QR-Studio/


## Ideas for later

- Numeric and alphanumeric encoding modes (smaller codes for digits-only or uppercase text).
- Gradient colors and a transparent background.
- Reading a QR code out of a pasted image.
