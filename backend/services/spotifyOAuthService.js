const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const INTEGRATIONS_FILE = path.join(__dirname, '..', 'integrations.json');

function readIntegrations() {
  try {
    if (!fs.existsSync(INTEGRATIONS_FILE)) return {};
    return JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeIntegrations(data) {
  fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getRedirectUri() {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) return `${renderUrl}/api/integrations/spotify/callback`;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}/api/integrations/spotify/callback`;
  return 'http://localhost:3000/api/integrations/spotify/callback';
}

function getCredentials() {
  const data = readIntegrations();
  const clientId = process.env.SPOTIFY_CLIENT_ID || data?.spotify?.clientId || '';
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || data?.spotify?.clientSecret || '';
  return { clientId, clientSecret };
}

function getMissingSpotifyCredentials() {
  const { clientId, clientSecret } = getCredentials();
  const missing = [];
  if (!clientId) missing.push('SPOTIFY_CLIENT_ID');
  if (!clientSecret) missing.push('SPOTIFY_CLIENT_SECRET');
  return missing;
}

function isSpotifyConfigured() {
  const { clientId, clientSecret } = getCredentials();
  const data = readIntegrations();
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN || data?.spotify?.refreshToken;
  return Boolean(clientId && clientSecret && refreshToken);
}

function setStoredSpotifyCredentials({ clientId, clientSecret }) {
  const data = readIntegrations();
  data.spotify = {
    ...(data.spotify || {}),
    clientId: clientId || data?.spotify?.clientId || '',
    clientSecret: clientSecret || data?.spotify?.clientSecret || '',
    updatedAt: new Date().toISOString(),
  };
  writeIntegrations(data);
}

function getSpotifyAuthUrl() {
  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Faltan SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET');
  }

  const scope = process.env.SPOTIFY_SCOPE
    || 'user-read-email user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played user-top-read user-library-read user-library-modify playlist-read-private playlist-modify-public playlist-modify-private streaming';

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    scope,
    show_dialog: 'true',
  });

  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Faltan SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
  }).toString();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(SPOTIFY_TOKEN_URL, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
  });

  return response.data;
}

function setStoredSpotifyTokens(tokens) {
  const data = readIntegrations();
  data.spotify = {
    ...(data.spotify || {}),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || data?.spotify?.refreshToken || '',
    expiresIn: tokens.expires_in,
    updatedAt: new Date().toISOString(),
  };
  writeIntegrations(data);
}

module.exports = {
  getRedirectUri,
  isSpotifyConfigured,
  getMissingSpotifyCredentials,
  getSpotifyAuthUrl,
  exchangeCodeForTokens,
  setStoredSpotifyCredentials,
  setStoredSpotifyTokens,
};
