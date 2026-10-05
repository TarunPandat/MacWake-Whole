#!/bin/sh
# Run ON the MacBook. Makes it wakeable over the network while on charger.
set -e
IF=$(route -n get default 2>/dev/null | awk '/interface/{print $2}')
MAC=$(ifconfig "$IF" | awk '/ether/{print $2}')
BCAST=$(ifconfig "$IF" | awk '/inet /{print $NF}')

echo "Applying power settings (charger only; macOS disables network wake on battery)..."
sudo pmset -c womp 1 tcpkeepalive 1 powernap 1 standby 0 hibernatemode 3

echo
echo "Interface : $IF"
echo "MAC       : $MAC"
echo "Broadcast : $BCAST"
echo
echo "On the relay box run:"
echo "  WAKE_TOKEN=\$(openssl rand -hex 16) WAKE_MAC=$MAC WAKE_BCAST=$BCAST python3 wake.py serve"
echo
echo "Checklist:"
echo "  - Keep the Mac plugged in; lid closed is fine."
echo "  - System Settings > Wi-Fi > this network > Private Wi-Fi Address: set to Off or Fixed."
echo "    If it says Rotating, the MAC above changes and wake packets miss."
echo "  - System Settings > Battery > Options > Wake for network access: Always."
