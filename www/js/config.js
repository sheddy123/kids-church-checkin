/*
 * Where the register is stored.
 *
 * null  -> "This phone only". Everything is kept on the device. Good for trying
 *          the app, or for a church that checks in on a single phone.
 *
 * To share one live register between several volunteers' phones, create a free
 * Firebase project (see README, "Sharing between phones") and paste its web
 * config here, for example:
 *
 * window.FIREBASE_CONFIG = {
 *   apiKey: "AIza...",
 *   authDomain: "your-church.firebaseapp.com",
 *   projectId: "your-church",
 *   appId: "1:1234567890:web:abcdef"
 * };
 */
window.FIREBASE_CONFIG = null;
