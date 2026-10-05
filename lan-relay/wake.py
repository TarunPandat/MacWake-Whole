#!/usr/bin/env python3
"""Wake a Mac over the LAN. Stdlib only, runs on any always-on box in the same network.

  python3 wake.py wake AA:BB:CC:DD:EE:FF [broadcast_ip]   # one-shot from CLI
  WAKE_TOKEN=secret WAKE_MAC=AA:BB:... python3 wake.py serve [port]   # HTTP relay
  python3 wake.py --test                                   # self-check

HTTP:  GET /            -> tiny page with a Wake button
       GET /wake?token= -> sends magic packet, 200 on success, 403 on bad token
"""
import hmac, os, socket, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse


def magic_packet(mac: str) -> bytes:
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if len(raw) != 6:
        raise ValueError(f"bad MAC: {mac!r}")
    return b"\xff" * 6 + raw * 16


def wake(mac: str, bcast: str = "255.255.255.255", repeat: int = 3) -> None:
    pkt = magic_packet(mac)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for _ in range(repeat):          # repeat: Wi-Fi drops broadcast frames sometimes
            for port in (9, 7):
                s.sendto(pkt, (bcast, port))


PAGE = b"""<!doctype html><meta name=viewport content="width=device-width">
<body style="font:24px system-ui;text-align:center;padding:3em">
<form onsubmit="event.preventDefault();fetch('/wake?token='+encodeURIComponent(t.value))
.then(r=>out.textContent=r.ok?'Magic packet sent':'Bad token')">
<input id=t type=password placeholder=token style="font-size:1em">
<button style="font-size:1em">Wake Mac</button></form><p id=out></p>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(PAGE); return
        if u.path != "/wake":
            self.send_error(404); return
        token = parse_qs(u.query).get("token", [""])[0]
        if not hmac.compare_digest(token, os.environ["WAKE_TOKEN"]):
            self.send_error(403); return
        wake(os.environ["WAKE_MAC"], os.environ.get("WAKE_BCAST", "255.255.255.255"))
        self.send_response(200); self.end_headers(); self.wfile.write(b"sent\n")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def _test():
    p = magic_packet("aa:bb:cc:dd:ee:ff")
    assert len(p) == 102 and p[:6] == b"\xff" * 6 and p[6:12] == p[-6:] == bytes.fromhex("aabbccddeeff")
    try:
        magic_packet("aa:bb"); assert False
    except ValueError:
        pass
    print("ok")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--test"]:
        _test()
    elif a[:1] == ["wake"] and len(a) in (2, 3):
        wake(*a[1:]); print("sent")
    elif a[:1] == ["serve"]:
        for k in ("WAKE_TOKEN", "WAKE_MAC"):
            if not os.environ.get(k):
                sys.exit(f"set {k}")
        port = int(a[1]) if len(a) > 1 else 8080
        print(f"relay on :{port} -> {os.environ['WAKE_MAC']}")
        HTTPServer(("", port), Handler).serve_forever()
    else:
        sys.exit(__doc__)
