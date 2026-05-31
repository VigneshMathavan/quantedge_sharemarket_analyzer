// test-totp.js — Verify your TOTP secret matches Authenticator
//
// Usage:
//   node test-totp.js YOUR_BASE32_SECRET
//
// Compare the printed 6-digit code with what your Authenticator app shows
// at the same moment. They must match exactly.

import * as OTPAuth from 'otpauth';

const secret = process.argv[2];
if (!secret) {
    console.error('Usage: node test-totp.js <BASE32_SECRET>');
    process.exit(1);
}

try {
    const totp = new OTPAuth.TOTP({
        issuer: 'Kotak',
        label: 'Neo',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret.replace(/\s/g, '').toUpperCase())
    });
    const code = totp.generate();
    const remaining = 30 - Math.floor((Date.now() / 1000) % 30);
    console.log('');
    console.log('  TOTP code:        ' + code);
    console.log('  Valid for:        ' + remaining + ' seconds');
    console.log('');
    console.log('  Compare with your Authenticator app right now.');
    console.log('  If they match — secret is correct. Paste it in .env.');
    console.log('  If they don\'t match — secret is wrong. Re-register TOTP.');
    console.log('');
} catch (e) {
    console.error('Invalid secret:', e.message);
    console.error('TOTP secret must be base32 (A-Z, 2-7).');
    process.exit(1);
}
