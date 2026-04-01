const express = require('express');
const router = express.Router();
const googleOAuthService = require('../services/googleOAuthService');
const googleCalendarService = require('../services/googleCalendarService');
const spotifyOAuthService = require('../services/spotifyOAuthService');
const discordService = require('../services/discordService');

router.get('/google/status', (req, res) => {
  res.json({
    connected: googleCalendarService.isGoogleConfigured(),
    redirectUri: googleOAuthService.getRedirectUri(),
  });
});

router.get('/google/connect', (req, res) => {
  try {
    const authUrl = googleOAuthService.buildGoogleAuthUrl();
    res.json({
      connected: googleCalendarService.isGoogleConfigured(),
      authUrl,
    });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo iniciar OAuth de Google',
      detail: error.message,
    });
  }
});

router.get('/google/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Falta code en callback de Google');
  }

  try {
    const tokens = await googleOAuthService.exchangeCodeForTokens(code);
    if (!tokens.refresh_token && !googleCalendarService.isGoogleConfigured()) {
      return res.status(400).send('No se recibio refresh token. Revoca acceso y repite con prompt=consent.');
    }

    if (tokens.refresh_token) {
      googleCalendarService.setStoredGoogleRefreshToken(tokens.refresh_token);
    }

    return res.send('Google Calendar conectado correctamente. Ya puedes volver a Arey.');
  } catch (error) {
    return res.status(500).send(`Error conectando Google: ${error.message}`);
  }
});

router.get('/spotify/status', (req, res) => {
  res.json({
    connected: spotifyOAuthService.isSpotifyConfigured(),
    redirectUri: spotifyOAuthService.getRedirectUri(),
    missing: spotifyOAuthService.getMissingSpotifyCredentials(),
  });
});

router.get('/spotify/connect', (req, res) => {
  try {
    const authUrl = spotifyOAuthService.getSpotifyAuthUrl();
    res.json({
      connected: spotifyOAuthService.isSpotifyConfigured(),
      authUrl,
    });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo iniciar OAuth de Spotify',
      detail: error.message,
    });
  }
});

router.get('/spotify/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Falta code en callback de Spotify');
  }

  try {
    const tokens = await spotifyOAuthService.exchangeCodeForTokens(code);
    spotifyOAuthService.setStoredSpotifyTokens(tokens);
    return res.send('Spotify conectado correctamente. Ya puedes volver a Arey.');
  } catch (error) {
    return res.status(500).send(`Error conectando Spotify: ${error.message}`);
  }
});

router.get('/discord/status', (req, res) => {
  res.json(discordService.getStatus());
});

router.get('/discord/connect', async (req, res) => {
  try {
    const status = await discordService.connectDiscord(`${req.protocol}://${req.get('host')}`);
    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo conectar Discord',
      detail: error.message,
      missing: discordService.getMissingDiscordCredentials(),
      inviteUrl: discordService.getInviteUrl(),
    });
  }
});

module.exports = router;
