# Soc

The existing Expo learning client lives in `mobile/soc`. Android and iOS retain
native audio playback and local reminders. Its web export is served at `/soc/`;
the account menu has a **学习** entry. All three use `/api/soc` and Startrips
identity. Learning data belongs to the authenticated user, independently of Atlas
membership and guest sharing.

## Server

`SOC_DATA_ROOT` names a private persistent directory. Compose mounts `soc_data`
at `/app/data/soc`; no new database tables or migrations are required.
Each user's directory is the SHA-256 of their Better Auth user ID and contains
the existing `project-data`, `rules.md` and private `llm-config.json` formats.
The file API cannot read the model configuration; `/models` returns only names
and model identifiers. LLM and Qwen speech requests use server-owned credentials.
Supported model endpoints are HTTPS OpenAI, DeepSeek, DashScope and OpenRouter.
Provider connectivity must be checked on the chosen server before selecting it.

To import existing data, first sign in as the intended owner and obtain their
ID from `GET /api/soc/session`. Transfer a private copy of the desktop data
directory to the server, then run as the API container's user:

```sh
node scripts/import-soc-data.mjs /private/staged-copy /app/data/soc USER_ID
```

The import refuses existing targets and links, preserves the source, and installs
the copied directory atomically. The script is an operations tool in the source
archive; mount or copy it into the container for this one command. Credentials
and study data must never be committed. New server-side study writes do not
automatically synchronize with the original desktop data directory.

## Native apps

The app signs in with the existing verified Startrips email and password.
Signed session tokens are kept in SecureStore; model keys never reach the app.
Browser builds use the existing HttpOnly cookie. Device-local lesson pointers,
voice choices and checkpoints are scoped by server and authenticated user.

The optional repository variable `SOCRATOPIA_API_ORIGIN` sets the server address
in CI builds. Otherwise enter the HTTPS address on the app's sign-in screen.
Changing a server requires signing out first. No Tailscale or Expo development
server is needed for an installed release build.

## iOS personal installation

The `soc` GitHub Actions workflow builds a Release IPA on macOS without signing
credentials. Download the `Soc-ios-unsigned` artifact, extract the IPA and sign
it for your own iPhone using your Apple Account and a sideloading tool, or use
Xcode on a Mac. Enable Developer Mode when iOS requests it. No App Store
submission is part of this workflow. Free Personal Team provisioning expires
after seven days; renew the signature to continue using the app. The personal
build removes the unused APNs entitlement while retaining local reminders and
background audio, so it does not require paid push-notification provisioning.

CI verifies compilation and packaging, not real iPhone behavior. On the device,
check a continuous lesson across lock, app switching, a phone interruption and a
network change, including the gap while the next explanation is generated.
An iOS background audio entitlement alone does not promise uninterrupted
arbitrary JavaScript work during silent gaps.

## Android personal installation

The `soc` workflow builds the standalone `Soc-android` APK for ARM64 phones and
x86-64 emulators, then installs and launches it in an Android emulator. The APK
uses the existing personal Android signing key kept in the repository secret
`SOC_ANDROID_KEYSTORE_BASE64`, retains `com.socratopia.mobile`, and increments
the version code so it can update the previous personal APK without uninstalling.
No Expo development server or Tailscale connection is required. Background audio
and local reminders remain native; lock-screen behavior still needs device testing.
The web container serves versioned APK files from the persistent `soc_downloads`
volume at `/soc/downloads/`. Upload only verified CI-built installers there;
never upload signing keys or user data. App deployments preserve this volume.

## Web

`npm ci --prefix mobile/soc` then `npm --prefix mobile/soc run export:web`
produces the `/soc/` assets. Docker performs this alongside the existing Vite
build. Web fonts load with system-font fallback and never block sign-in, including
when their download stalls or fails. The web client keeps the same learning layout, uses browser recording and
HTTPS media URLs, and does not schedule native local notifications. Browser
background generation and continuous playback require separate device testing;
the native apps remain the intended clients for locked-screen lessons.

Code checks and builds run in GitHub CI. The `soc` workflow typechecks the
client, exports web and Android bundles, builds and launches the Android APK,
and archives the iOS device app. Core
CI tests file isolation, revision conflicts, traversal/link refusal, model-key
redaction and authenticated provider routing.
