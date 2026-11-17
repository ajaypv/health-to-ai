# Health to AI

Copy your Android **Health Connect** data and paste it into any AI agent (ChatGPT, Claude, Gemini, anything
that takes text). Steps, sleep, heart rate, HRV, workouts, weight, nutrition and more, in one tap.

No account, no server, no cloud. The data goes from Health Connect to your clipboard and stays on your phone
until you paste it somewhere.

## How it works

1. Open the app, tap **Connect Health Connect** and allow the data you want.
2. Pick **Today**, **7 days** or **30 days**.
3. Tap **Copy for AI**, then choose:
   - **Readable summary**: short text that is cheap for a chat to read (recommended).
   - **Full JSON**: every reading, for tools and scripts.
   - Optionally start with a ready-made question ("act as a careful health coach..."). The text is editable.
4. Tap **Copy** and paste into your AI app, or tap **Share** to send it straight to an installed AI app.

## Places (where you spend your time)

Optional. Tap **Turn on place tracking** in the Places section. The app records your location in the background
(Android shows a notification while it runs), groups it into **visits** of 5 minutes or more, and adds up the time
per place for Today, 7 days or 30 days.

- Everything is worked out on the phone. There is no address lookup and nothing is uploaded.
- Places start as "Unnamed spot". Tap one to name it (Home, Work, Gym...). Later visits nearby use the name.
- Accuracy: the start and end of a visit are within a few minutes. Fixes less precise than 60 m are ignored,
  one jumpy fix does not end a visit, and a brief hop away and back is merged into one visit.
- Keep the app in your recent apps. If you swipe it away or restart the phone, tracking stops until you open it again.
- In **Copy for AI**, tick **Include places** to add names and times. Coordinates are never copied.

## Food and calories (Gemini)

Optional. In the **Food** section tap **Add food**, then either:

- **Photo**: take or choose a picture of your meal (add a note like "2 rotis" if you like). Gemini identifies the food,
  guesses the portion and returns calories, protein, carbs and fat per item.
- **Search the web**: type what you ate ("2 dosa with sambar", a restaurant dish, a packaged food). Gemini searches
  Google and uses the figures it finds, and the sources are listed.

You can edit the numbers before adding the meal to your food log. The log shows today's total, the 7 and 30 day
view, and is included in **Copy for AI**.

Setup: create a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste it when the app
asks. The key is saved only on the phone (never in this repo). The model is chosen automatically from what your key
can use; you can type a model name next to the key to override it.

- Photos and text you add are sent to Google. On the free tier Google may use them to improve its products,
  so check Google's terms, and do not photograph anything private.
- Estimates are approximate, especially portion size. They are not medical or dietary advice.

## Install

Download the APK from the [latest release](../../releases/latest) and open it on your phone
(allow "install unknown apps" for your browser or file manager). Android 8+ (API 26).

- Android 14+ has Health Connect built in. On Android 9 to 13 install "Health Connect" from the Play Store.
- Make sure a fitness app (Samsung Health, Fitbit, Google Fit, a watch app) writes data into Health Connect.
- The release APK is debug-signed, so it is for personal use, not for the Play Store.

## Build it yourself

Needs Node, JDK 21 and the Android SDK (set `sdk.dir` in `android/local.properties`).

```bash
npm install
npm run build            # type-check + bundle the web app into dist/
npx cap sync android     # copy dist/ and plugins into the Android project
cd android && gradlew.bat assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

## Preview on a computer

`npm run dev`, then open `http://localhost:5173/?demo` to see the screen with fake data (add `&fresh` for the
first-run Connect screen). Demo mode only works in a normal browser, never in the Android app.

## Notes

- Uses the free, open-source (MPL-2.0) [`@capgo/capacitor-health`](https://github.com/Cap-go/capacitor-health) plugin.
- Health Connect has no stress-score type, so stress scores from Samsung Health, Fitbit or Garmin are not
  available to any app. The app includes HRV and resting heart rate, the closest signals.
- By default Health Connect only returns the last 30 days. Older data needs `READ_HEALTH_DATA_HISTORY`.
- `public/privacypolicy.html` is shown when the permission rationale is opened. Replace it with a real policy
  and change `appId` in `capacitor.config.ts` before any Play Store release.
- Health data is sensitive. Pasting it into an AI service sends it to that service, so check its privacy terms.
  This is not medical advice.

## License

MIT, see [LICENSE](LICENSE).
