// Where the driver's phone is. In the Android app a native watcher keeps running while the
// phone is locked or another app is open, and Android shows a notification the whole time.
// On the website the browser's watch runs only while the page is open.
import { IS_APP } from './common.js';

const PLUGIN = 'BackgroundGeolocation';
const cap = IS_APP ? window.Capacitor : null;
const hasBridge = typeof cap?.nativeCallback === 'function';

/** True when sharing carries on with the screen locked. */
export const BACKGROUND = hasBridge;

/**
 * Starts watching. Calls onFix({ lat, lng, accuracy, at, simulated }) for each position and
 * onError({ denied, off, message }) when there is none. Returns a function that stops it.
 */
export function watchLocation(onFix, onError) {
  if (hasBridge) {
    let id = null;
    let fellBack = null;
    id = cap.nativeCallback(PLUGIN, 'addWatcher', {
      backgroundTitle: 'Sharing your taxi\'s position',
      backgroundMessage: 'Dankie Driver is sharing your location. Open the app and press Stop to end it.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    }, (loc, err) => {
      if (err) {
        if (err.code === 'UNIMPLEMENTED' && !fellBack) { // an older APK without the plugin
          fellBack = watchInBrowser(onFix, onError);
          return;
        }
        const off = /disabled/i.test(err.message ?? '');
        return onError({ denied: err.code === 'NOT_AUTHORIZED' && !off, off, message: err.message });
      }
      if (loc) onFix({ lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy, at: loc.time, simulated: loc.simulated === true });
    });
    return () => {
      fellBack?.();
      if (id != null) cap.nativePromise(PLUGIN, 'removeWatcher', { id }).catch(() => {});
    };
  }
  return watchInBrowser(onFix, onError);
}

function watchInBrowser(onFix, onError) {
  if (!('geolocation' in navigator)) {
    onError({ off: true, message: 'This phone cannot share its location.' });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: pos.timestamp, simulated: false }),
    (err) => onError({ denied: err.code === err.PERMISSION_DENIED, message: err.message }),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Opens the app's page in Android Settings, where location can be allowed. */
export function openLocationSettings() {
  if (hasBridge) cap.nativePromise(PLUGIN, 'openSettings', {}).catch(() => {});
}
