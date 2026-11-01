#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/ios
# One available iPhone, no device matrix or hidden parallel simulator clones.
device=$(xcrun simctl list devices available --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for k,v in d["devices"].items() if "iOS" in k for x in v if x["name"].startswith("iPhone")))')
root=$(pwd)
(
  cd mobile/ios/NativeMedia
  xcodebuild test -scheme StartripsMedia \
    -destination "platform=iOS Simulator,id=$device" -parallel-testing-enabled NO \
    -maximum-concurrent-test-simulator-destinations 1 \
    -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/StartripsMedia" \
    -resultBundlePath "$root/artifacts/ios/StartripsMedia.xcresult" CODE_SIGNING_ALLOWED=NO
)
xcodebuild test -project mobile/ios/Startrips.xcodeproj -scheme Startrips \
  -destination "platform=iOS Simulator,id=$device" -parallel-testing-enabled NO \
  -maximum-concurrent-test-simulator-destinations 1 \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/Startrips" \
  -resultBundlePath artifacts/ios/Startrips.xcresult CODE_SIGNING_ALLOWED=NO
