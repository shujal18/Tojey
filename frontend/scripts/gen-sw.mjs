import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tplPath = join(root, 'scripts', 'firebase-messaging-sw.tpl.js');
const outPath = join(root, 'public', 'firebase-messaging-sw.js');

const senderId = process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID || '';

const template = readFileSync(tplPath, 'utf8');
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(outPath, template.replaceAll('__MESSAGING_SENDER_ID__', senderId));
console.log(`[gen-sw] wrote public/firebase-messaging-sw.js (messagingSenderId=${senderId ? senderId.slice(0, 4) + '...' : '(missing - web push will be disabled)'})`);