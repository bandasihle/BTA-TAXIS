// Which build this is. The website uses this default. The Android build replaces the file with
// its own version number, and only the sideload build (installed from the website) checks for
// updates; the Play Store build leaves updates to the Play Store.
export const BUILD = Object.freeze({ versionCode: 0, versionName: 'web', updateCheck: false });
