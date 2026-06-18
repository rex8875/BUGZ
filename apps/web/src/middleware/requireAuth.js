module.exports = function requireAuth(req, res, next) {
  if (req.session.discordId) return next();
  const returnTo = encodeURIComponent(req.originalUrl);
  res.redirect(`/auth/discord?returnTo=${returnTo}`);
};
