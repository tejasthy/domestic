#!/usr/bin/env node
/** Prints a fresh VAPID keypair for .env.local. Run once, ever. */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('\nPaste both into .env.local and into your Vercel env vars.');
console.log('Changing these later invalidates every existing subscription.');
