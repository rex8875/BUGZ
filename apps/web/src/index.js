require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const authRoutes = require('./routes/auth');
const shareRoutes = require('./routes/share');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');
const publicReportRoutes = require('./routes/publicReport');

const app = express();

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
  }),
);
app.use(express.static(path.join(__dirname, '../public')));

app.use(authRoutes);
app.use(shareRoutes);
app.use(dashboardRoutes);
app.use(apiRoutes);
app.use(publicReportRoutes);

app.get('/', (req, res) => {
  res.redirect(req.session.discordId ? '/dashboard' : '/auth/discord');
});

const { PORT = 3000 } = process.env;
app.listen(PORT, () => console.log(`Web app listening on :${PORT}`));
