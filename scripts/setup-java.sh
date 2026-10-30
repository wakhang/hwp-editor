#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
JDK="$VENDOR/jdk/Contents/Home"
JAR="$VENDOR/hwp2hwpx-cli.jar"
if [[ -x "$JDK/bin/java" && -f "$JAR" && "$JAR" -nt "$ROOT/java/Hwp2HwpxCli.java" ]]; then
  exit 0
fi
mkdir -p "$VENDOR/lib" "$VENDOR/src"
WORK="$(mktemp -d "$VENDOR/.setup.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
if [[ ! -x "$JDK/bin/javac" ]]; then
  curl -fL --retry 3 'https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse' -o "$WORK/jdk.tar.gz"
  mkdir -p "$WORK/jdk"
  tar -xzf "$WORK/jdk.tar.gz" -C "$WORK/jdk" --strip-components 1
  rm -rf "$VENDOR/jdk"
  mv "$WORK/jdk" "$VENDOR/jdk"
fi
# hwp2hwpx main requires hwplib 1.1.10 and hwpxlib 1.0.9; 1.1.11 is compatible.
# Neither library POM declares runtime dependencies.
for spec in hwplib:1.1.11 hwpxlib:1.0.9; do
  name="${spec%:*}"; version="${spec#*:}"
  file="$VENDOR/lib/$name-$version.jar"
  if [[ ! -f "$file" ]]; then
    curl -fL --retry 3 "https://repo.maven.apache.org/maven2/kr/dogfoot/$name/$version/$name-$version.jar" -o "$WORK/$name.jar"
    mv "$WORK/$name.jar" "$file"
  fi
done
if [[ ! -f "$VENDOR/src/hwp2hwpx/pom.xml" ]]; then
  curl -fL --retry 3 'https://github.com/neolord0/hwp2hwpx/archive/refs/heads/main.tar.gz' -o "$WORK/source.tar.gz"
  mkdir -p "$WORK/source"
  tar -xzf "$WORK/source.tar.gz" -C "$WORK/source" --strip-components 1
  mv "$WORK/source" "$VENDOR/src/hwp2hwpx"
fi
mkdir -p "$WORK/classes"
find "$VENDOR/src/hwp2hwpx/src/main/java" -name '*.java' -print > "$WORK/sources"
printf '%s\n' "$ROOT/java/Hwp2HwpxCli.java" >> "$WORK/sources"
"$JDK/bin/javac" -encoding UTF-8 -cp "$VENDOR/lib/*" -d "$WORK/classes" @"$WORK/sources"
for dep in "$VENDOR"/lib/*.jar; do
  (cd "$WORK/classes" && "$JDK/bin/jar" xf "$dep")
done
rm -f "$WORK/classes/META-INF/MANIFEST.MF" "$WORK/classes/META-INF/"*.SF "$WORK/classes/META-INF/"*.RSA "$WORK/classes/META-INF/"*.DSA
"$JDK/bin/jar" --create --file "$WORK/hwp2hwpx-cli.jar" --main-class Hwp2HwpxCli -C "$WORK/classes" .
mv "$WORK/hwp2hwpx-cli.jar" "$JAR"
