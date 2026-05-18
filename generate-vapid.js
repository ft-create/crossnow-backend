/**
 * Run this ONCE to generate your VAPID keys for push notifications.
 * 
 * node generate-vapid.js
 * 
 * Then add the output to your environment variables:
 *   VAPID_PUBLIC_KEY  = the publicKey value
 *   VAPID_PRIVATE_KEY = the privateKey value
 *   VAPID_EMAIL       = mailto:your@email.com
 */
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nVAPID Keys Generated:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('VAPID_EMAIL=mailto:your@email.com');
console.log('\nAdd these to your Railway/Render environment variables.\n');
