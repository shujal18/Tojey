/**
 * @format
 */
import { AppRegistry, Alert } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { registerBackgroundHandler } from './src/services/notifications';

registerBackgroundHandler();

/**
 * Global JS error trap.
 * In release builds an uncaught JS exception used to crash the whole app with no
 * explanation ("Tojey keeps stopping"). We intercept it, surface the message once,
 * and keep the app alive so the user can see and report what actually failed.
 */
const errorShown = new Set();
global.ErrorUtils?.setGlobalHandler((error, isFatal) => {
  const raw = (error && (error.message || error.name)) || String(error || 'Unknown error');
  const msg = String(raw);
  console.error(`[Tojey] global error (fatal=${isFatal})`, error);
  if (error && error.message) console.error('[Tojey] stack:', error.stack);
  const key = msg.slice(0, 80);
  if (!errorShown.has(key)) {
    errorShown.add(key);
    if (errorShown.size > 6) errorShown.clear();
    setTimeout(() => {
      try {
        Alert.alert('Tojey hit a problem', msg, [{ text: 'OK' }]);
      } catch (e) {
        console.error('[Tojey] could not surface global error', e);
      }
    }, 400);
  }
});

AppRegistry.registerComponent(appName, () => App);