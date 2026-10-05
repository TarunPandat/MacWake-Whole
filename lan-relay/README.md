# Mac Remote Wake

Wake a sleeping MacBook from anywhere. A sleeping Mac cannot receive internet
traffic, so a small relay on the same home network sends it a Wake-on-LAN
magic packet. You reach the relay from anywhere over Tailscale.

```
phone/laptop (anywhere) --Tailscale--> relay (home LAN) --magic packet--> MacBook
```

## 1. On the MacBook

```sh
sh setup-mac.sh
```

Prints the MAC and broadcast address and the exact relay command. Do the
two System Settings items it lists.

## 2. On the relay (Raspberry Pi, old laptop, NAS, anything always on)

Copy `wake.py` there and run the command `setup-mac.sh` printed, e.g.

```sh
WAKE_TOKEN=... WAKE_MAC=aa:bb:cc:dd:ee:ff WAKE_BCAST=192.168.0.255 python3 wake.py serve
```

Install Tailscale on the relay and on your phone/laptop. Then from anywhere:

```sh
curl "http://<relay-tailscale-ip>:8080/wake?token=..."
```

or open `http://<relay-tailscale-ip>:8080/` in a browser and tap **Wake Mac**.

No relay box? Any WoL app on a phone that is on the home Wi-Fi works too:
target the MAC from step 1. From outside the home you still need a relay.

## Limits

- **Charger only.** macOS wake-on-network is unreliable on battery; the setup script enables it for charger only.
- **Deep sleep.** `setup-mac.sh` sets `standby 0` so the Mac stays in normal
  sleep where the Wi-Fi chip still listens. Full hibernate (`hibernatemode 25`)
  cannot be woken by network; the script keeps mode 3.
- **Private Wi-Fi Address** in Rotating mode changes the MAC. Set it Fixed or Off.
- The Mac wakes with the display off (dark wake). Screen sharing / SSH work; if
  you need the screen on, run `caffeinate -u -t 5` over SSH after waking.

## Self-check

```sh
python3 wake.py --test
```
