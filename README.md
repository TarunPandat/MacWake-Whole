# MacWake

Wake your MacBook at home from anywhere: open the web console on your phone, tap **Wake up Mac**.

```
phone (anywhere) ──HTTPS──> console (Cloudflare Worker, free) <──HTTPS── MacBook at home
                                                                 wakes itself every N min,
                                                                 asks "anyone want me awake?"
```

## Why it works this way

A sleeping Mac cannot receive anything from the internet, and nothing at home is awake to
poke it. So the Mac wakes **itself** on a hardware timer (RTC alarm, the same mechanism as
Energy Saver schedules) every few minutes, checks the console, and either stays awake
(you pressed the button) or goes straight back to sleep. On charger these check-ins are
silent "dark wakes": the screen stays off, the Mac is back asleep within seconds. Only when
you press the button does it light the screen (lid open) and hold itself awake.

On charger with **Instant wake** on (the default in the Next.js console), the Mac skips deep
sleep and listens on a push channel, so a wake arrives in about a second. On battery, or with
Instant off, wake latency is up to the check-in interval (default 5 min, 10 min on battery).

## Parts

| Path | What |
|------|------|
| `console/` | Web console + API. One file Cloudflare Worker, state in Workers KV. |
| `console-next/` | Same console + API as a Next.js app (deploy on Vercel + Upstash Redis). Use this **or** `console/`. |
| `mac/` | Menu-bar app + background service (Swift). `build.sh` makes `dist/MacWake.dmg`. |
| `mobile/` | React Native CLI project for iPhone and iPad: tested console logic in `src/core.ts`, app screen still the template. See [mobile/README.md](mobile/README.md). |
| `lan-relay/` | Optional: classic Wake-on-LAN relay if you ever have an always-on box at home (instant wake). |

## 1. Deploy the console (once, 2 minutes)

Needs Node 22+ (`brew install node` or nodejs.org) and a free Cloudflare account.

```bash
sh console/deploy.sh
```

It logs you into Cloudflare in the browser, creates the KV namespace, deploys, and prints
the console URL (`https://macwake.<you>.workers.dev`). There is no admin token to copy: each
Mac pairs itself in step 2 and shows a QR code for its phone.

Prefer Next.js / Vercel? Use `console-next/` instead; see [console-next/README.md](console-next/README.md). The Mac app works with either.

## 2. Install on the MacBook

Needs Xcode Command Line Tools once: `xcode-select --install`.

Build with your console's address baked in, so the app needs no typing:

```bash
CONSOLE_URL=https://your-console.vercel.app sh mac/build.sh    # -> mac/dist/MacWake.dmg
```

The build signs the app with a free local signing key it creates once in `~/Library/Application Support/MacWake Build/`
(its own keychain; your login keychain is untouched), so macOS keeps MacWake's Screen Recording permission across
rebuilds and updates. Keep that folder: a new key means allowing Screen Recording again on every Mac.

Open the DMG, drag **MacWake** to Applications, and open it from Applications. It refuses
to set up from the DMG or from `mac/dist`. On first run it:

1. Creates its own random token and pairs it with the console. Every Mac does this, so one
   console serves any number of Macs, and each phone only sees the Mac it paired with.
2. Asks for your Mac password once, to install the background service. That is a root
   LaunchDaemon with its own copy of the binary, so moving the app later does not break it.
3. Shows **Pair your phone**: a QR code that opens the console already signed in, plus the
   token with a **Copy token** button.

Later, the menu-bar icon has **Pair phone…**, **Copy token** and **Open console**. Built
without `CONSOLE_URL`, the app asks for the address once instead.

If you copied the DMG from another Mac (AirDrop, download) macOS will block the first
launch because the app is not notarized. Either: System Settings → Privacy & Security →
scroll to Security → **Open Anyway** → open it again, or run once:

```bash
xattr -dr com.apple.quarantine /Applications/MacWake.app
```

## 3. Test

Menu bar → **Sleep now**. On your phone, tap **Wake up Mac**. The console shows
"Wake requested… waiting for Mac to check in", then "Awake, holding" within the interval.
The Mac stays awake for the configured hold time (default 30 min) or until you tap
**Cancel / let it sleep**. Log: `/Library/Logs/MacWake.log` (menu bar → Show log).

## Watch the screen

Tap **Watch screen** in the console or the app to see your Mac's screen live (view-only for now). It wakes the Mac
if needed and connects on its own; the Mac shows an eye in its menu bar and macOS's own recording indicator while
someone watches. Video goes straight from the Mac to your phone, encrypted; the console only passes the connection
setup along.

- MacWake's menu-bar app must be running (it starts at login) and someone must be logged in on the Mac.
- Allow Screen Recording once when setup asks (System Settings → Privacy & Security → Screen Recording).
- After a wake the Mac usually shows its lock screen; you'll see it, but view-only can't unlock it.
- Lid closed without an external display means there's no screen to show.
- Turn it off on the Mac with **Allow screen viewing** in the menu. **New token (unpair all phones)…** locks out
  every phone and browser that had the old token.
- Some cellular networks block direct connections; add a free TURN relay to the console (see console-next/README.md).

## Settings (in the console)

- **Check-in interval**: how often the Mac wakes to ask. Shorter = faster wake, more wakes.
- **Stay awake after wake**: how long the Mac holds itself awake after you press the button.

## Limits, honestly

- **Keep the Mac plugged in.** On battery macOS does not let software hold a dark wake, so
  the Mac falls back to a full wake (screen on) only every 30 min, and only with the lid
  open. The console shows charger/battery state and warns you.
- **Lid closed, no external display**: the Mac wakes "dark" (no screen) and stays that way;
  SSH, Screen Sharing and file sharing work. Open the lid or attach a display (an HDMI
  dummy plug works) if you need the screen on.
- **No Wi-Fi after wake**: if the Mac cannot reach the console it retries ten times (up to
  a few minutes), then sleeps until the next timer. Check the log.
- **Hibernate**: leave `hibernatemode` at the default 3. The RTC alarm also wakes from
  hibernation, but restoring from the disk image makes every check-in much slower.
- **Each Mac's token** protects that Mac on the console and the API, and now also opens its screen. Treat it like a
  password; use **New token (unpair all phones)…** if it leaks.
- Cloudflare free tier allows 1000 KV writes/day; each Mac only writes on change or every
  5 min (about 300/day), so it fits about three Macs. For more, use `console-next/`.

## Uninstall

Menu bar → **Uninstall…**, then delete MacWake.app.
