# Activity POC

Capacitor app that reads today's steps, walking distance and last night's sleep from
Android **Health Connect**. Uses the free, open-source (MPL-2.0)
[`@capgo/capacitor-health`](https://github.com/Cap-go/capacitor-health) plugin.

## Build

Needs Node, a JDK 21 and the Android SDK (set `sdk.dir` in `android/local.properties`).

```bash
npm install
npm run build            # type-check + bundle web app into dist/
npx cap sync android     # copy dist/ and plugins into the Android project
cd android && gradlew.bat assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Install with
`adb install -r app-debug.apk`, or `npx cap run android` with a device attached.

## On the phone

1. Android 14+ has Health Connect built in. On Android 9-13 install "Health Connect" from the Play Store.
2. Make sure a fitness app (Google Fit, Samsung Health, Fitbit, a watch app) writes steps and sleep into Health Connect.
3. Open the app, tap **Connect Health Connect** and allow the data types you want (allow all to see everything).

## Notes

- Sleep can't be aggregated by the plugin, so it is read as sessions from the last 36 hours.
- By default Health Connect only returns the last 30 days. For older data add
  `READ_HEALTH_DATA_HISTORY` and call `requestAuthorization({ requestHistoryAccess: true })`.
- `public/privacypolicy.html` is shown when the user taps the permission rationale. Replace it with a real
  policy before publishing to the Play Store.
- Change `appId` in `capacitor.config.ts` before publishing.

## Stress

Health Connect has no stress-score data type, so stress scores from Samsung Health, Fitbit or Garmin are not
available to any app. The app shows HRV and resting heart rate, the closest signals Health Connect exposes.
Which data appears depends on what your watch or phone apps write into Health Connect.

## Previewing on a computer

`npm run dev`, then open `http://localhost:5173/?demo` to see the screen with fake data (add `&fresh` for the
first-run Connect screen). Demo mode only works in a normal browser, never in the Android app.
