# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MacWake: wake a sleeping MacBook from anywhere and watch its screen live. A Mac app checks in with a web console; a phone (web console or the React Native app) asks it to wake.

## Repository layout and git

- This repo (`origin` = `TarunPandat/MacWake-Whole`) holds `mac/`, `mobile/`, `console/`, `lan-relay/`, `tools/`, `docs/`.
- `console-next/` and `website/` are **separate git repos nested here** (gitlinks, no `.gitmodules`): `console-next` = `TarunPandat/MacWake-Console`, `website` = `TarunPandat/MacWake`. Commit and push inside them first, then commit the moved pointer in this repo (history has commits like "Update website with …" that only bump the gitlink).
- `mac/dist/` (the built `MacWake.app`, its `WebRTC.framework`, and `MacWake.dmg`) is committed. Rebuilding changes these binaries; commit them with the source change. `mac/vendor/` is ignored.
- Releasing a Mac build: bump `CFBundleShortVersionString` in `mac/Info.plist`, copy `mac/dist/MacWake.dmg` to `website/public/downloads/`, and bump `macVersion` in `website/lib/site.js`. The APK goes to the same downloads folder (see `website/README.md`).
- Commit messages are plain imperative sentences ("Hide the viewer's Close bar once the screen is showing"), no conventional-commit prefix.

## Commands

```bash
# Next.js console (port 3000 by default; state in console-next/.data/state.json without Upstash env vars)
npm --prefix console-next run dev
npm --prefix console-next test          # node test.mjs: assert script over lib/logic.js, no server, no framework

# Cloudflare Worker console
node console/test.mjs
sh console/deploy.sh

# Mac app (needs Xcode CLT). Downloads pinned WebRTC into mac/vendor on first run, builds a universal binary, signs, makes the DMG.
CONSOLE_URL=https://your-console.vercel.app sh mac/build.sh
open -n mac/dist/MacWake.app --args --screen-test <console-url> <token>   # dev: stream the screen to a console with no install

# Mobile (mobile/)
npm run test:core                        # node --no-warnings src/core.check.ts: logic tests, Node runs the TS directly
npx tsc --noEmit && npm run lint && npm test   # npm test = jest (__tests__/App.test.tsx)
LANG=en_US.UTF-8 bash -c 'cd ios && bundle exec pod install'   # pod install fails without LANG set
npm start && npm run ios                 # restart Metro after adding packages ("Requiring unknown module" otherwise)
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a   # APK for the website

# Website
npm --prefix website run dev

# LAN relay self-check
python3 lan-relay/wake.py --test
```

The test files are single sequential assert scripts: there is no per-test selection; the first failing `eq(...)` throws with its message.

`.claude/launch.json` has preview configs: `macwake-console` (:3002), `macwake-console-test` (:3003), `macwake-website` (:3004).

## Local testing without touching real data

`console-next/.data/state.json` holds the user's real pairing. Don't overwrite it. Use `macwake-console-test` (or set `MACWAKE_STATE_FILE` to a scratch path) together with `NTFY_URL=off`, because otherwise every wake posts to the public ntfy.sh relay. Fake a Mac by `POST /api/register` with a generated 48-hex token, then `POST /api/heartbeat`. Sign the simulator app in with `http://localhost:3003/#token=<token>`.

## Architecture

### Wake flow (pull model)
A sleeping Mac can't receive traffic, so it wakes **itself**. The root daemon arms an RTC wake every `interval` minutes, then `POST /api/heartbeat`s. The reply says whether to wake/hold. The wake owner name matters: `com.apple.alarm.MacWake` gives a dark wake (screen off) and `MacWake` gives a full wake (see the comment at the top of `mac/Sources/main.swift`). With "instant" on and on AC, the daemon skips sleep and listens on an ntfy push topic derived from its token. A push only means "check in now"; commands always come from the console.

### Console API (two interchangeable implementations)
- `console-next/lib/logic.js` is pure logic, framework-free and tested by `test.mjs`. `app/api/[action]/route.js` is a thin adapter that does auth, injects `kv`, and passes the env-derived push/ICE options. `lib/store.js` uses Upstash Redis REST when `KV_REST_API_*` are set, else a serialized JSON file store (local only; on Vercel without Upstash it throws a setup message).
- `console/worker.js` is the same contract on Cloudflare Workers + KV but older: no live screen, no instant/push. The daemon treats `instant`/`push` in the heartbeat reply as optional so it keeps working with it.
- Each Mac's random token is its account. Keys live under `mac:<sha256(token)>:` and **every key has exactly one writer** (`cmd`/`settings` by the console, `device` by the Mac, `screenOffer` by the viewer, `screenAnswer` by the Mac app), so eventually-consistent stores never lose updates. Preserve this when adding keys. Bare (unprefixed) keys + `ADMIN_TOKEN` are legacy single-Mac support.

### Mac binary (`mac/Sources/`): one executable, several roles
- No flags: the menu-bar `App` (runs as the user). It handles setup/pairing (QR), installs the daemon via an admin script, and runs `ScreenShare`. It reinstalls the daemon when its own binary differs from the installed copy.
- `--daemon`: the root LaunchDaemon `io.macwake.daemon`, running from its own copy at `/Library/Application Support/MacWake/MacWake` with config in `config.json` there (`MACWAKE_CONFIG` overrides). Log: `/Library/Logs/MacWake.log`.
- `--install <url> [token]` (sudo, terminal setup), `--setup`, `--pair`, `--screen-test <url> <token>`.
- `Screen.swift` (ScreenCaptureKit + WebRTC) runs only in the menu-bar app; the daemon has no screen session. WebRTC is **weak-linked** because the daemon's lone binary copy has no `Frameworks/` beside it, so don't make it a hard link. The daemon listens on push topic `macwake-<hash>`, the app on `…-screen`.
- `build.sh` signs with a self-signed identity in `~/Library/Application Support/MacWake Build/`, so Screen Recording permission survives rebuilds. A new key forces every Mac to re-grant it.

### Live screen
The console only relays one WebRTC offer/answer per session (`GET/POST /api/screen`, `OFFER_TTL`). Video goes peer-to-peer using public STUN, plus optional `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`. Watching also requests a wake (`needsWake`).

### Cross-platform mirroring (keep in sync by hand)
- `mobile/src/core.ts` ports the web console's status logic (`deriveView`, from `console-next/app/page.js`) and the viewer decisions/messages from `console-next/lib/screen.js` (`SCREEN_MESSAGES`, `afterPoll`, `ANSWER_WAIT`, `needsWake`). **Text must stay identical.** Change both together and keep `core.ts` free of React/native imports so `test:core` runs under plain Node.
- `console-next/lib/control.js` ↔ `mobile/src/control.ts` (remote control: gestures, sticky keys, batching, texts) and `console-next/app/Controls.js` ↔ `mobile/src/Controls.tsx` (the glue). Keep behavior and text identical. The Mac side (`mac/Sources/Control.swift`) only injects; its `keyCodes` table must cover every `KeyboardEvent.code` the viewers send.
- The mobile UI mirrors the web console (`console-next/app/page.js` + `globals.css`): same tokens, Onest font, sleep light, light/dark. Sign-in has only the Token field plus "Scan pairing code". The console URL comes from the pairing link/QR or `DEFAULT_CONSOLE`, so don't add a URL field.
- Icons and splash for all apps come from `tools/make-icons.sh` / `tools/make-splash.sh` (source: `tools/tab-icon.svg`).

## Conventions

- Everything must stay on free tiers (Vercel + Upstash, Cloudflare, ntfy.sh, free TURN). Don't propose paid services.
- Comments are dense and explain *why* (often citing macOS internals). Deliberate shortcuts are marked `ponytail:` with their limit, so keep that style.
- Mobile uses Prettier (single quotes, trailing commas, `arrowParens: avoid`). The JS consoles use double quotes and compact one-liners.
- Design specs/plans live in `docs/superpowers/` (e.g. the live-screen design).
