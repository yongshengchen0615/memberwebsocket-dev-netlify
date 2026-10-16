# QR decoder provenance

`friend-qr-decoder.js` bundles jsQR **1.4.0** from the published `jsqr/dist/jsQR.js` file, with no CDN or network dependency. Source: https://github.com/cozmo/jsQR. Apache-2.0 license: `jsqr-LICENSE.txt`.

Build with esbuild 0.25.10:

```sh
esbuild node_modules/jsqr/dist/jsQR.js --bundle --minify --format=iife --global-name=FriendQRDecode --outfile=MemberWebsocket-dev/vendor/friend-qr-decoder.js
```

Bundle SHA-256: `2778f247b80440c606112d867c3ef64621e7e07c9731daa99a301ce7054f447b`.

`friend-qr-scanner.js` samples camera frames and user-selected images in memory. The decoded content passes same-site URL and code validation before read-only member lookup. Friendship and referral reward operations require separate explicit confirmation.
