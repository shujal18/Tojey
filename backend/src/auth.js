const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'tojey-secret-key';

const USERS = {
  tom: { username: 'tom', password: 'tom18', displayName: 'Tom' },
  jerry: { username: 'jerry', password: 'jerry22', displayName: 'Jerry' },
};

function authenticate(username, password) {
  const user = USERS[username.toLowerCase()];
  if (user && user.password === password) {
    return { username: user.username, displayName: user.displayName };
  }
  return null;
}

function signToken(user) {
  return jwt.sign(
    { username: user.username, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

module.exports = { authenticate, signToken, verifyToken, authMiddleware, USERS };
