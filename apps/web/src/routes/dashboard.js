const express = require('express');
const path = require('path');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();
router.use('/dashboard', requireAuth);

router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/servers.html'));
});

router.get('/dashboard/:serverId', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/board.html'));
});

router.get('/dashboard/:serverId/roles', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/roles.html'));
});

router.get('/dashboard/:serverId/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/leaderboard.html'));
});

module.exports = router;
