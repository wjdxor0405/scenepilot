# ScenePilot Android app

An Android wrapper (Capacitor) around the same web UI that `src/scenepilot/static` serves. The web code is **not changed**: `build-www.mjs` copies it into `www/` and adds three app-only files from `native/`. The web version can still be submitted on its own.

## Why an app

A browser asks for the microphone and location per web address, and only on HTTPS. In the app the permissions belong to the app: the phone asks **once at first use** and remembers, whatever the server's address is.

What the app changes (all in `native/`, none in the web code):

| File | What it does |
|---|---|
| `api-shim.js` | Adds the server's address in front of `/api/...` calls (set with `SCENEPILOT_API_BASE` when building). |
| `native-speech.js` | Replaces the browser's speech recognition (Android web views do not have it) with Android's own recognizer. Command matching and `?fakespeech` are untouched. |
| `native-tts.js` | Replaces the web view's speech synthesis with Android's own text-to-speech, which reliably reports when it has finished. |
| `native-back.js` | Android's back button closes the menu or the screen on top (Ask a question, Conversation watch, My info); otherwise it puts the app in the background. It never moves the accident steps back and never ends the app. |
| `build-www.mjs` | Copies every file `index.html` loads, makes paths relative, and wires the files above in. |

### The first steps run on the phone (`local-first.js`, proof of concept)

Starting an accident, consent, the two safety questions and the emergency notice are answered on the phone, without a connection and without a round trip per answer. Guidance, photos, questions and the summary still go to the server.

- `local-first.js` wraps fetch. It answers those requests itself, in the shape the server uses, and records them. Whenever the server can be reached it replays the records with the normal API, so the server reaches the same state. The first request that only the server can answer hands the accident over; without a connection that request gets "This step needs an internet connection" and nothing is lost.
- `local-rules.js` holds the texts, decisions and screens. It is generated from the server's Python rules: run `uv run python tools/export_local_rules.py` after changing `emergency.py` or `session.py`. Only the answer parsing (the same regular expressions) and the order of the steps are written in JavaScript.
- `tests/test_local_first.py` checks that the phone gives the same screens as the server for the same answers, that replaying the records leaves the server in the same state, and that `local-rules.js` is up to date.
- Not covered yet: the guidance steps run on the server, so a standard accident needs a connection after the safety questions. Speech recognition usually needs a connection too (use the buttons offline).

`MainActivity.java` keeps the screen on while the app is in front, so hands-free listening and the conversation watch do not stop when the screen would time out.

Everything else (location, microphone permission, camera through the file picker, spoken guidance, `tel:` links such as the 911 button, which open the phone's dialer) is handled by Android's web view.

## Build and run (Galaxy S25 over USB)

One time:

1. Install [Android Studio](https://developer.android.com/studio) with its default SDK.
2. On the phone: Settings → About phone → Software information → tap **Build number** 7 times, then Settings → Developer options → turn on **USB debugging**. Connect the cable and allow the computer.
3. On the PC, in `.env` add `SCENEPILOT_CORS_ORIGINS=https://localhost` (lets the app call the server) and restart the server. The server must be reachable from the phone (same Wi-Fi; allow port 8000 in the Windows firewall), or deployed.

Every time the web code or the server address changes:

```bash
cd android-app
SCENEPILOT_API_BASE=http://<PC address>:8000 npm run sync     # PowerShell: $env:SCENEPILOT_API_BASE="http://<PC address>:8000"; npm run sync
npx cap open android                                           # opens Android Studio: choose the phone, press Run
```

`npm run run:phone` does build, sync and run in one go once `ANDROID_HOME` points at the SDK.

Without `SCENEPILOT_API_BASE` the app talks to `http://10.0.2.2:8000`, which only works in the emulator.

For a release build, point it at the deployed server. It must be `https://`, or the build stops:

```bash
SCENEPILOT_API_BASE=https://<deployed server> npm run sync:release
```

## Notes

- **Cleartext HTTP is allowed in debug builds only** (`app/src/debug/AndroidManifest.xml`), so a debug build can reach a server on the local network. Release builds have no cleartext HTTP. `allowMixedContent` (set in `capacitor.config.js`) is on only when the last build named an `http://` server.
- The app asks for microphone, location and camera at first use. Consent is remembered inside the app like in the browser.
- **Checked:** the build script, the manifest permissions, the CORS switch and the speech adapter against a fake plugin, and installing and opening the app on a Galaxy S25. **Not yet checked on the phone:** Magpie audio playback in the web view, spoken free questions, speech recognition in noise, and whether the microphone and location permissions are asked only once.
