module.exports = function requireAuthApi(req, res, next) {
  if (req.session.discordId) return next();
  res.status(401).json({ error: 'Not signed in.' });
};
