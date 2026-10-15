/* Prints a random key to use as WPFORMS_KEY (paste it into Railway and into the
   WPForms webhook header X-Ink360-Key). Run: npm run make-key */
'use strict';
console.log(require('node:crypto').randomBytes(24).toString('base64url'));
