// Helper centralisé pour vérifier l'authentification admin
require('./_env'); // Charger les variables d'environnement
const jwt = require('jsonwebtoken');

function verifyAdminToken(req) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { isAdmin: false, error: 'Token manquant' };
  }

  if (!process.env.JWT_SECRET) {
    console.error('[_verify-admin] JWT_SECRET is not defined!');
    return { isAdmin: false, error: 'JWT_SECRET manquant' };
  }

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.role === 'admin') {
      return { isAdmin: true, decoded };
    }
    
    return { isAdmin: false, error: 'Rôle invalide' };
  } catch (e) {
    return { isAdmin: false, error: 'Token invalide: ' + e.message };
  }
}

module.exports = { verifyAdminToken };
