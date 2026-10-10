#!/bin/sh
# One-time, run by you: creates a free self-signed code-signing identity, "MacWake Local Signing", in your login
# keychain. mac/build.sh signs with it so macOS keeps MacWake's Screen Recording permission across rebuilds and
# updates (ad-hoc signatures change on every build). macOS asks for your login password to trust it for code signing.
set -e
NAME="MacWake Local Signing"
KC="$HOME/Library/Keychains/login.keychain-db"
if security find-identity -p codesigning | grep -q "\"$NAME\""; then echo "already set up: $NAME"; exit 0; fi
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
cat > "$D/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
# Apple's LibreSSL writes a PKCS#12 that `security import` reads (Homebrew OpenSSL 3 would need -legacy).
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$D/cert.cnf" -keyout "$D/key.pem" -out "$D/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -name "$NAME" -out "$D/id.p12" -passout pass:macwake
security import "$D/id.p12" -k "$KC" -P macwake -T /usr/bin/codesign
security add-trusted-cert -p codeSign -k "$KC" "$D/cert.pem"
echo "created: $NAME. Rebuild with mac/build.sh, then allow Screen Recording once more for the newly signed app."
