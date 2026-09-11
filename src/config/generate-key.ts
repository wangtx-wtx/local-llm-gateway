// Standalone helper: generate a random 32-byte master key (base64).
import { randomBytes } from 'node:crypto';
console.log(randomBytes(32).toString('base64'));
