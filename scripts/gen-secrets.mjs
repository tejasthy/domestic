#!/usr/bin/env node
/** Random tokens for the cron endpoint, the HA bridge, and the wall iPad. */
import { randomBytes } from 'node:crypto';

const token = () => randomBytes(32).toString('base64url');

console.log(`CRON_SECRET=${token()}`);
console.log(`HA_API_TOKEN=${token()}`);
console.log(`KIOSK_TOKEN=${token()}`);
console.log(`AI_CONFIG_ENCRYPTION_KEY=${token()}`);
