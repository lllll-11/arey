const express = require('express');
const router = express.Router();
const googleOAuthService = require('../services/googleOAuthService');
const googleCalendarService = require('../services/googleCalendarService');
const spotifyOAuthService = require('../services/spotifyOAuthService');
const spotifyService = require('../services/spotifyService');
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

// ── Spotify Playback API ──

router.get('/spotify/now', async (req, res) => {
  try {
    const data = await spotifyService.getNowPlaying();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/play', async (req, res) => {
  try {
    const { query, uri, contextUri, type } = req.body || {};
    let result;
    if (query) {
      result = await spotifyService.playBySearch(query, type || 'track');
    } else {
      result = await spotifyService.play({ uri, contextUri });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/pause', async (req, res) => {
  try { res.json(await spotifyService.pause()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/next', async (req, res) => {
  try { res.json(await spotifyService.next()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/previous', async (req, res) => {
  try { res.json(await spotifyService.previous()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/volume', async (req, res) => {
  try {
    const { volume } = req.body || {};
    res.json(await spotifyService.setVolume(volume));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/shuffle', async (req, res) => {
  try {
    const { state } = req.body || {};
    res.json(await spotifyService.setShuffle(state));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/repeat', async (req, res) => {
  try {
    const { state } = req.body || {};
    res.json(await spotifyService.setRepeat(state));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/queue', async (req, res) => {
  try {
    const { uri, query } = req.body || {};
    if (query) {
      const results = await spotifyService.search(query, 'track', 1);
      if (!results.tracks?.length) return res.json({ success: false, error: 'No encontré esa canción.' });
      res.json(await spotifyService.addToQueue(results.tracks[0].uri));
    } else {
      res.json(await spotifyService.addToQueue(uri));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/queue', async (req, res) => {
  try { res.json(await spotifyService.getQueue()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/search', async (req, res) => {
  try {
    const { q, type, limit } = req.query;
    res.json(await spotifyService.search(q, type || 'track', Number(limit) || 5));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/devices', async (req, res) => {
  try { res.json(await spotifyService.getDevices()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/transfer', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    res.json(await spotifyService.transferPlayback(deviceId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/top/tracks', async (req, res) => {
  try {
    const { range, limit } = req.query;
    res.json(await spotifyService.getTopTracks(range || 'short_term', Number(limit) || 10));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/top/artists', async (req, res) => {
  try {
    const { range, limit } = req.query;
    res.json(await spotifyService.getTopArtists(range || 'short_term', Number(limit) || 10));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/recent', async (req, res) => {
  try { res.json(await spotifyService.getRecentlyPlayed(Number(req.query.limit) || 10)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/recommendations', async (req, res) => {
  try {
    const { genres, limit } = req.query;
    const seedGenres = genres ? genres.split(',') : [];
    res.json(await spotifyService.getRecommendations([], [], seedGenres, Number(limit) || 10));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/new-releases', async (req, res) => {
  try { res.json(await spotifyService.getNewReleases(Number(req.query.limit) || 10)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/playlists', async (req, res) => {
  try { res.json(await spotifyService.getMyPlaylists(Number(req.query.limit) || 20)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/playlist', async (req, res) => {
  try {
    const { name, description } = req.body || {};
    res.json(await spotifyService.createPlaylist(name, description));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spotify/like', async (req, res) => {
  try {
    const { trackId } = req.body || {};
    res.json(await spotifyService.saveTracks([trackId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/spotify/profile', async (req, res) => {
  try { res.json(await spotifyService.getProfile()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
