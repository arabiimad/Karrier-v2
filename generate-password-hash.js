// Script pour générer un hash bcrypt pour le mot de passe admin
const bcrypt = require('bcryptjs');

const password = process.argv[2] || 'admin123';
const hash = bcrypt.hashSync(password, 10);

console.log('\n===========================================');
console.log('Hash généré pour le mot de passe:', password);
console.log('===========================================');
console.log(hash);
console.log('===========================================');
console.log('\nCopiez ce hash dans .env.local :');
console.log(`ADMIN_PASSWORD_HASH=${hash}`);
console.log('===========================================\n');
