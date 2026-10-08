# MacWake mobile (React Native CLI)

iPhone and iPad app project for the MacWake console. Bare React Native 0.87 (no Expo),
TypeScript, bundle ID `io.macwake.mobile`, iPhone + iPad.

The screens match the web console (`console-next`): same colors (light and dark), Onest font,
sleep light, status words, facts, Timing panel and thumb-zone button.

## What's here

| Path | What |
|------|------|
| `App.tsx` | Splash, sign-in (token or pairing link) and the console screen. Draws what `src/core.ts` returns. |
| `src/Scanner.tsx` | Camera QR scanner for the Mac's "Pair phone…" code (iOS; VisionCamera). Loaded only when opened. |
| `src/core.ts` | Console client and all status logic, ported from the web console. No React, no native code. |
| `src/core.check.ts` | Tests for it: QR parsing, every status, API calls and error messages. `npm run test:core` |
| `assets/fonts/` | Onest Regular, Medium, SemiBold (SIL OFL, `OFL.txt`), registered in iOS `UIAppFonts` and Android `assets/fonts`. |
| `ios/MacWake/LaunchScreen.storyboard` | Launch screen. Its mark and background come from `../tools/make-splash.sh`. |
| `ios/`, `android/` | Native projects. App icon comes from `../tools/make-icons.sh`. |

Sign-in takes the token or the whole pairing link; the link also carries the console address.
A bare token goes to the default console (`DEFAULT_CONSOLE` in `src/core.ts`). The session is kept
in the iOS Keychain (`react-native-keychain`), readable only on this device.

## `src/core.ts` in one minute

```ts
import { api, deriveView, parsePairing, DEFAULT_CONSOLE, type Session } from "./src/core";

const session: Session = { url: DEFAULT_CONSOLE, token };   // token from the Mac's "Pair phone…"
const state = await api(session, "state");                  // GET /api/state
await api(session, "wake", {});                             // POST /api/wake  (also "cancel")
await api(session, "settings", { interval: 5, hold: 30, instant: true });

const view = deriveView(state, Date.now(), state.now - Date.now());
// view.title       "Asleep." | "Ready." | "Waking up…" | "Awake." | …
// view.line        one sentence under the title
// view.led         "sleep" | "ready" | "pending" | "awake" | "off"
// view.facts       [["Last check-in", "2 min ago"], ["Lid", "Closed"], …]
// view.note        battery warning, if any
// view.primary     { label, action: "wake" | "cancel", disabled, quiet }
// view.pollMs      how long to wait before asking again (2 s while a wake is pending)

parsePairing(scannedText);   // Mac QR "https://…/#token=…"  ->  { url, token }
```

`api()` throws `ApiError` with a sentence you can show as-is; status 401 means the token is
wrong, so send the user back to sign-in. Store the session in the iOS Keychain (for example
with `react-native-keychain`), not in plain storage.

## Run

```bash
npm install
export LANG=en_US.UTF-8   # CocoaPods fails with "Unicode Normalization not appropriate for ASCII-8BIT" without it
cd ios && bundle install && bundle exec pod install && cd ..
npm start                 # Metro, keep it running for debug builds (restart it after adding packages)
npm run ios               # simulator; the camera scanner needs a real device
npm run test:core         # logic tests
npx tsc --noEmit && npm run lint && npm test
```

## Install on your own iPhone or iPad

1. Open `ios/MacWake.xcworkspace` in Xcode (the workspace, not the project).
2. Select the **MacWake** target, then **Signing & Capabilities**. Tick **Automatically manage
   signing** and pick your **Team**. A free Apple ID shows up as "Personal Team".
3. Plug in the device, unlock it, and trust the Mac. On iOS 16 and later, turn on
   **Settings → Privacy & Security → Developer Mode** and restart the device.
4. Build a Release version, which bundles the JavaScript so it runs without Metro:

   ```bash
   npx react-native run-ios --mode Release --device
   ```

5. On first launch, if iOS says the developer isn't trusted: **Settings → General → VPN &
   Device Management**, tap your Apple ID, then **Trust**.

With a free Apple ID the app stops opening after 7 days; build and install again to renew.
A paid Apple Developer account (99 USD a year) lasts a year and allows TestFlight.

If the bundle ID `io.macwake.mobile` is taken under your team, change it in Xcode under
**Signing & Capabilities**.
