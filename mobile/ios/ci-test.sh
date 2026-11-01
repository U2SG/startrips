#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/ios
# Surface failing assertions on the check itself without downloading simulator videos.
report_failure() {
  local status=$?
  if (( status != 0 )); then
    for bundle in artifacts/ios/*.xcresult; do
      [[ -d "$bundle" ]] || continue
      if xcrun xcresulttool get test-results summary --path "$bundle" > "$bundle.summary.json"; then
        python3 - "$bundle.summary.json" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    for failure in json.load(handle).get("testFailures", []):
        text = f"{failure.get('testName', '')} {failure.get('failureText', '')}".strip()
        if text:
            print("::error::" + text[:1400].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A"))
PY
      fi
    done
  fi
  exit "$status"
}
trap report_failure EXIT
# One available iPhone, no device matrix or hidden parallel simulator clones.
device=$(xcrun simctl list devices available --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for k,v in d["devices"].items() if "iOS" in k for x in v if x["name"].startswith("iPhone")))')
xcrun simctl bootstatus "$device" -b
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
