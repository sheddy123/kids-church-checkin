# Kids Church Check-In

A phone app for checking children in to kids church and making sure each child goes home with the right adult. No laptop or printer needed.

## How pickup is kept safe

A pickup code or QR code only proves that someone is *holding the pass*. It doesn't prove who they are, and it doesn't stop the wrong child being handed over. So the app uses three checks, and the Release button stays locked until the volunteer has done them:

1. **Pass.** Scan the QR code on the parent's phone (or type the 4-character code). This opens the family. Passes are new every Sunday.
2. **Face.** The screen shows today's drop-off photo and the saved photo of the adult who is collecting. The volunteer compares faces and ticks "The adult's face matches the photo". A person does the matching; the app does no facial recognition.
3. **Sticker.** The volunteer checks the child's sticker shows the same code and ticks it.

Also built in:

- **Back button.** Android's back button closes whatever is open, then returns to Check in, then leaves the app.
- **Must NOT collect.** Names listed on a family show in a red banner at check-in, at pickup and on leader release.
- **A different adult from drop-off** is flagged. If there's no photo of them, the volunteer is told to fetch a leader.
- **Someone not on the list** can only be released by a leader, who records who collected, how they confirmed it, and enters the **leader PIN**.
- **Drop-off photos delete themselves** once every child on that pass has been collected.

## What's in the folder

```
www/                  The phone app (HTML, CSS, JavaScript; no build step)
  index.html          Page shell
  css/app.css         All styling. Colours are variables at the top.
  js/app.js           Screens and logic
  js/camera.js        In-app camera: photos and QR scanning
  js/backend.js       Storage: this phone only, or shared through Firebase
  js/config.js        Where you paste your Firebase details (optional)
  vendor/, fonts/     Bundled libraries and fonts, so the app works with no signal
android/              The Android app project (made with Capacitor)
capacitor.config.json App name and ID
firestore.rules       Security rules to paste into Firebase
dev/app-server.js     Runs the app in a browser for development
branding/             App name, ID, colour and icon for each church (see below)
scripts/brand.js      Applies branding/branding.json to the app
tests/app.e2e.js      Automated test of every flow (49 checks)

index.html, dev/server.js, dev/mock-claude.js, tests/e2e.py
                      The original web version, published on claude.ai. Unchanged.
```

## Try it in a browser

```bash
npm install
npm run app          # then open http://localhost:5174
```

Use `http://localhost` so the camera works. Over Wi-Fi on a phone (`http://192.168…`) browsers block the live camera, so the app offers the phone's own camera or gallery instead.

## Put it on an Android phone

You need Android Studio (which you have).

```bash
npm run android:apk
```

The app file is then at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to a phone and open it to install, or plug the phone in and run `npm run android:open` to launch it from Android Studio.

After changing anything in `www/`, run `npm run android:apk` again.

**Before giving it to other people**, set your own `appId` in `branding/branding.json` (see below) and build a signed release in Android Studio (Build → Generate Signed App Bundle). The debug file above is for testing.

**iPhone:** the same `www/` folder works. On a Mac with Xcode, run `npm install @capacitor/ios@^6`, `npx cap add ios`, add a camera usage message (`NSCameraUsageDescription`) to `Info.plist`, then `npx cap open ios`. This has not been built or tested yet.

## Rebrand it for another church

Everything a church would want to change is in one file, `branding/branding.json`:

```json
{
  "appName": "Grace Kids",
  "appId": "org.gracechapel.checkin",
  "churchName": "Grace Chapel",
  "color": "#0F766E",
  "icon": "branding/grace-logo.png",
  "iconBackground": "#FFFFFF"
}
```

| Setting | What it changes |
|---|---|
| `appName` | The name under the icon on the phone. |
| `appId` | The app's unique ID. Give every church its own, or installing one replaces the other. |
| `churchName` | The name in the app header (can still be changed in Setup). |
| `color` | The starting theme colour, the splash screen and the icon background. |
| `icon` | The church logo: a square PNG, JPG or SVG, 512px or larger. Leave `""` for the shield. |
| `iconBackground` | Colour behind the logo on the icon. Leave `""` to use `color`. |

Then run:

```bash
npm run brand          # writes the name, ID, colours and every icon size; check branding/preview.png
npm run android:apk    # builds that church's app
```

Inside the app, **Setup → Look and feel** lets the church change the colour (eight presets or any colour) and add a logo to the header at any time, without rebuilding. Whatever colour is picked, the app darkens it if needed so white text on it stays readable.

## Where the data lives

The register is kept **on one admin phone only**. Nothing is sent to a server and the app needs no internet. Android is told not to include it in phone backups.

The other side of that: if the app is uninstalled or the phone is lost or broken, the register is gone. There is no backup.

(`www/js/config.js` and `firestore.rules` are for an optional mode that shares one register between several phones through Firebase. It is written but untested, and not needed for a single admin phone.)

## Run the tests

```bash
npm run test:app
```

This drives the app on a phone-sized screen in the Edge or Chrome already on your computer (`BROWSER=chrome` to choose). It uses the browser's fake camera, takes real photos through the app, and scans a picture of a real pickup pass. Screenshots go to `tests/screenshots/`.

## Data protection

The app is built around the principles that UK GDPR, EU GDPR and Nigeria's NDPA share. **Using the app does not by itself make a church compliant.** The church is the one responsible for the data, and the steps at the end of this section are still theirs to do.

### What the app does

| Principle | In the app |
|---|---|
| Tell people what you keep | A privacy notice the parent reads on the phone. A family cannot be saved until "Parent has been shown the privacy notice" is ticked; the date and volunteer are recorded. The wording is editable in Setup and follows the church's own settings. |
| Consent for photos | Photos are off for each family until "Parent agrees to photos" is ticked. Nothing is pre-ticked. Unticking it later deletes that family's photos. No facial recognition is used. |
| Keep only what you need | First names, age group, a phone number, and allergy notes. No dates of birth, addresses or surnames of children. |
| Don't keep it longer than needed | Attendance records delete themselves after 30 days, 3 months or 1 year. Drop-off photos are deleted at pickup, and any left over are removed the next day. Families who stop coming can be deleted automatically after 12 or 24 months. |
| Right to see their data | Edit family → "See everything we hold on this family" gives a copy to hand over. |
| Right to correct or delete | Edit family, or "Delete family and all their records", which also removes their photos and attendance history. |
| Keep it secure | Data stays on one phone, is excluded from backups, and can be put behind an app passcode. Leader releases need a PIN. |
| Keep a record | Every check-in and release records who did it, when, and who collected. |

### What it stores

| Stored | Contents |
|---|---|
| `families/{id}` | Parent name, phone, other adults allowed to collect, who must not collect, children (name, age group, notes), photo references, when the notice was shown, photo consent, last attended |
| `checkins/{id}` | One record per child per Sunday: code, pass, who dropped off, who collected, which volunteer, any leader release |
| `photos/{id}` | One small photo each |
| `settings/main` | Church name, theme, logo, privacy notice, retention choices, leader PIN (scrambled) |

### Limits you should know about

- **The passcode and leader PIN are deterrents, not encryption.** The real protection is the phone's own screen lock, which also switches on Android's storage encryption. Make sure the admin phone has one.
- **No backup.** Protects privacy, but a lost phone means a lost register.
- **Allergy and medical notes are health data**, which the law treats as more sensitive. Record only what the team needs to keep a child safe.
- **"Must NOT collect" names** are data about people who haven't been told. Keep them factual.

### What the church still has to do

1. Name one person responsible for this data, and put them in Setup → "Who parents can ask about their data".
2. Read and adjust the privacy notice in Setup so it matches what actually happens.
3. Check whether the church must register or pay a fee with the regulator (the ICO in the UK, the NDPC in Nigeria).
4. Set a screen lock on the admin phone, turn on the app passcode, and decide who knows it.
5. Decide what to do if the phone is lost: who is told, and how quickly. A lost phone with children's data on it may need reporting to the regulator within 72 hours.
6. Have the safeguarding or data protection lead confirm the retention periods.
