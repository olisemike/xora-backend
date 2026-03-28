/* eslint-disable no-console, promise/always-return */
const bcrypt = require('bcryptjs');

const password = 'Mrsblack1$pa$$word';
const saltRounds = 12;

bcrypt.hash(password, saltRounds).then(hash => {
  console.log('Password hash:', hash);
  return hash;
}).catch(err => {
  console.error('Error hashing password:', err);
});
/* eslint-enable no-console, promise/always-return */
