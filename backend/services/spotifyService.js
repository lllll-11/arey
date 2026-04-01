const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const INTEGRATIONS_FILE = path.join(__dirname, '..', 'integrations.json');

// ── Helpers ──

function readIntegrations() {
  try {
    if (!fs.existsSync(INTEGRATIONS_FILE)) return {};
    return JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf-8'));
  } catch { return {}; }
}

function writeIntegrations(data) {
  fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getCredentials() {
  const data = readIntegrations();
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || data?.spotify?.clientId || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || data?.spotify?.clientSecret || '',
  };
}

function getTokens() {
  const data = readIntegrations();
  return {
    accessToken: data?.spotify?.accessToken || '',
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || data?.spotify?.refreshToken || '',
    expiresAt: data?.spotify?.expiresAt || 0,
  };
}

function saveTokens(accessToken, refreshToken, expiresIn) {
  const data = readIntegrations();
  data.spotify = {
    ...(data.spotify || {}),
    accessToken,
    refreshToken: refreshToken || data?.spotify?.refreshToken || '',
    expiresIn,
    expiresAt: Date.now() + (expiresIn - 60) * 1000, // refresh 1 min antes
    updatedAt: new Date().toISOString(),
  };
  writeIntegrations(data);
}

// ── Token Auto-Refresh ──

async function refreshAccessToken() {
  const { clientId, clientSecret } = getCredentials();
  const { refreshToken } = getTokens();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Faltan credenciales de Spotify para refrescar token');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(SPOTIFY_TOKEN_URL, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
  });

  const { access_token, refresh_token, expires_in } = res.data;
  saveTokens(access_token, refresh_token, expires_in);
  return access_token;
}

async function getValidToken() {
  const { accessToken, expiresAt } = getTokens();
  if (accessToken && expiresAt > Date.now()) return accessToken;
  return refreshAccessToken();
}

// ── API Helper ──

async function spotifyApi(method, endpoint, data = null, params = null) {
  const token = await getValidToken();
  try {
    const res = await axios({
      method,
      url: `${SPOTIFY_API}${endpoint}`,
      headers: { Authorization: `Bearer ${token}` },
      data,
      params,
    });
    return res.data;
  } catch (err) {
    // Si es 401, refrescar y reintentar una vez
    if (err.response?.status === 401) {
      const newToken = await refreshAccessToken();
      const res = await axios({
        method,
        url: `${SPOTIFY_API}${endpoint}`,
        headers: { Authorization: `Bearer ${newToken}` },
        data,
        params,
      });
      return res.data;
    }
    throw err;
  }
}

// ── Playback Controls ──

async function play(options = {}) {
  const body = {};
  if (options.uri) body.uris = [options.uri];
  if (options.uris) body.uris = options.uris;
  if (options.contextUri) body.context_uri = options.contextUri;
  if (options.offset != null) body.offset = { position: options.offset };

  try {
    await spotifyApi('PUT', '/me/player/play', Object.keys(body).length ? body : null);
    return { success: true, action: 'play' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo. Abre Spotify en tu cel o compu primero.' };
    }
    throw err;
  }
}

async function pause() {
  try {
    await spotifyApi('PUT', '/me/player/pause');
    return { success: true, action: 'pause' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

async function next() {
  try {
    await spotifyApi('POST', '/me/player/next');
    return { success: true, action: 'next' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

async function previous() {
  try {
    await spotifyApi('POST', '/me/player/previous');
    return { success: true, action: 'previous' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

async function setVolume(volumePercent) {
  const vol = Math.max(0, Math.min(100, Math.round(volumePercent)));
  try {
    await spotifyApi('PUT', '/me/player/volume', null, { volume_percent: vol });
    return { success: true, action: 'volume', volume: vol };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

async function setShuffle(state) {
  try {
    await spotifyApi('PUT', '/me/player/shuffle', null, { state: Boolean(state) });
    return { success: true, action: 'shuffle', state: Boolean(state) };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

async function setRepeat(state) {
  // state: 'track', 'context', 'off'
  const valid = ['track', 'context', 'off'];
  const mode = valid.includes(state) ? state : 'off';
  try {
    await spotifyApi('PUT', '/me/player/repeat', null, { state: mode });
    return { success: true, action: 'repeat', state: mode };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

async function seek(positionMs) {
  try {
    await spotifyApi('PUT', '/me/player/seek', null, { position_ms: Math.max(0, positionMs) });
    return { success: true, action: 'seek' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo.' };
    }
    throw err;
  }
}

// ── Now Playing ──

async function getNowPlaying() {
  try {
    const data = await spotifyApi('GET', '/me/player/currently-playing');
    if (!data || !data.item) {
      return { playing: false, message: 'No hay nada sonando en este momento.' };
    }

    const track = data.item;
    const artists = track.artists?.map(a => a.name).join(', ') || 'Desconocido';
    const album = track.album?.name || '';
    const progress = Math.floor((data.progress_ms || 0) / 1000);
    const duration = Math.floor((track.duration_ms || 0) / 1000);
    const isPlaying = data.is_playing;
    const coverUrl = track.album?.images?.[0]?.url || '';

    return {
      playing: true,
      isPlaying,
      track: track.name,
      artists,
      album,
      progress: `${Math.floor(progress / 60)}:${String(progress % 60).padStart(2, '0')}`,
      duration: `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`,
      coverUrl,
      uri: track.uri,
      message: `${isPlaying ? '▶️' : '⏸️'} ${track.name} - ${artists} (${album}) [${Math.floor(progress / 60)}:${String(progress % 60).padStart(2, '0')}/${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}]`,
    };
  } catch (err) {
    if (err.response?.status === 204 || err.response?.status === 404) {
      return { playing: false, message: 'No hay nada sonando en este momento.' };
    }
    throw err;
  }
}

// ── Queue ──

async function addToQueue(uri) {
  try {
    await spotifyApi('POST', '/me/player/queue', null, { uri });
    return { success: true, action: 'queue' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'No hay dispositivo activo. Abre Spotify primero.' };
    }
    throw err;
  }
}

async function getQueue() {
  try {
    const data = await spotifyApi('GET', '/me/player/queue');
    const current = data.currently_playing;
    const queue = (data.queue || []).slice(0, 10);

    const formatTrack = (t) => `${t.name} - ${t.artists?.map(a => a.name).join(', ') || '?'}`;

    return {
      currentlyPlaying: current ? formatTrack(current) : 'Nada',
      queue: queue.map((t, i) => `${i + 1}. ${formatTrack(t)}`),
      message: current
        ? `Sonando: ${formatTrack(current)}\n\nSiguientes:\n${queue.length ? queue.map((t, i) => `${i + 1}. ${formatTrack(t)}`).join('\n') : 'Cola vacía'}`
        : 'No hay nada en la cola.',
    };
  } catch (err) {
    if (err.response?.status === 204 || err.response?.status === 404) {
      return { currentlyPlaying: null, queue: [], message: 'No hay cola activa.' };
    }
    throw err;
  }
}

// ── Search ──

async function search(query, types = 'track', limit = 5) {
  const data = await spotifyApi('GET', '/search', null, {
    q: query,
    type: types,
    limit,
    market: 'MX',
  });

  const results = {};

  if (data.tracks?.items?.length) {
    results.tracks = data.tracks.items.map((t, i) => ({
      position: i + 1,
      name: t.name,
      artists: t.artists.map(a => a.name).join(', '),
      album: t.album?.name || '',
      uri: t.uri,
      duration: `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, '0')}`,
      popularity: t.popularity,
    }));
  }

  if (data.artists?.items?.length) {
    results.artists = data.artists.items.map((a, i) => ({
      position: i + 1,
      name: a.name,
      genres: a.genres?.slice(0, 3).join(', ') || '',
      followers: a.followers?.total || 0,
      uri: a.uri,
    }));
  }

  if (data.playlists?.items?.length) {
    results.playlists = data.playlists.items.map((p, i) => ({
      position: i + 1,
      name: p.name,
      owner: p.owner?.display_name || '',
      tracks: p.tracks?.total || 0,
      uri: p.uri,
    }));
  }

  if (data.albums?.items?.length) {
    results.albums = data.albums.items.map((a, i) => ({
      position: i + 1,
      name: a.name,
      artists: a.artists?.map(ar => ar.name).join(', ') || '',
      year: a.release_date?.slice(0, 4) || '',
      uri: a.uri,
    }));
  }

  return results;
}

// ── Play by search (search + play first result) ──

async function playBySearch(query, type = 'track') {
  const results = await search(query, type, 1);

  if (type === 'track' && results.tracks?.length) {
    const track = results.tracks[0];
    const playResult = await play({ uri: track.uri });
    return {
      ...playResult,
      track: `${track.name} - ${track.artists}`,
      uri: track.uri,
    };
  }

  if (type === 'playlist' && results.playlists?.length) {
    const playlist = results.playlists[0];
    const playResult = await play({ contextUri: playlist.uri });
    return {
      ...playResult,
      playlist: playlist.name,
      uri: playlist.uri,
    };
  }

  if (type === 'album' && results.albums?.length) {
    const album = results.albums[0];
    const playResult = await play({ contextUri: album.uri });
    return {
      ...playResult,
      album: `${album.name} - ${album.artists}`,
      uri: album.uri,
    };
  }

  if (type === 'artist' && results.artists?.length) {
    const artist = results.artists[0];
    const playResult = await play({ contextUri: artist.uri });
    return {
      ...playResult,
      artist: artist.name,
      uri: artist.uri,
    };
  }

  return { success: false, error: `No encontré "${query}" en Spotify.` };
}

// ── Devices ──

async function getDevices() {
  const data = await spotifyApi('GET', '/me/player/devices');
  return (data.devices || []).map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    active: d.is_active,
    volume: d.volume_percent,
  }));
}

async function transferPlayback(deviceId, startPlaying = true) {
  await spotifyApi('PUT', '/me/player', {
    device_ids: [deviceId],
    play: startPlaying,
  });
  return { success: true, action: 'transfer' };
}

// ── Top / Recommendations ──

async function getTopTracks(timeRange = 'short_term', limit = 10) {
  const data = await spotifyApi('GET', '/me/top/tracks', null, {
    time_range: timeRange,
    limit,
  });
  return (data.items || []).map((t, i) => ({
    position: i + 1,
    name: t.name,
    artists: t.artists.map(a => a.name).join(', '),
    uri: t.uri,
  }));
}

async function getTopArtists(timeRange = 'short_term', limit = 10) {
  const data = await spotifyApi('GET', '/me/top/artists', null, {
    time_range: timeRange,
    limit,
  });
  return (data.items || []).map((a, i) => ({
    position: i + 1,
    name: a.name,
    genres: a.genres?.slice(0, 3).join(', ') || '',
    uri: a.uri,
  }));
}

async function getRecommendations(seedTracks = [], seedArtists = [], seedGenres = [], limit = 10) {
  const params = { limit };
  if (seedTracks.length) params.seed_tracks = seedTracks.slice(0, 5).join(',');
  if (seedArtists.length) params.seed_artists = seedArtists.slice(0, 5).join(',');
  if (seedGenres.length) params.seed_genres = seedGenres.slice(0, 5).join(',');

  // Necesita al menos 1 seed
  if (!params.seed_tracks && !params.seed_artists && !params.seed_genres) {
    // Usar top tracks como seed
    const top = await getTopTracks('short_term', 3);
    if (top.length) {
      params.seed_tracks = top.map(t => t.uri.split(':').pop()).join(',');
    } else {
      params.seed_genres = 'pop,rock,latin';
    }
  }

  const data = await spotifyApi('GET', '/recommendations', null, params);
  return (data.tracks || []).map((t, i) => ({
    position: i + 1,
    name: t.name,
    artists: t.artists.map(a => a.name).join(', '),
    uri: t.uri,
  }));
}

// ── Recently Played ──

async function getRecentlyPlayed(limit = 10) {
  const data = await spotifyApi('GET', '/me/player/recently-played', null, { limit });
  return (data.items || []).map((item, i) => ({
    position: i + 1,
    name: item.track.name,
    artists: item.track.artists.map(a => a.name).join(', '),
    playedAt: item.played_at,
    uri: item.track.uri,
  }));
}

// ── User Profile ──

async function getProfile() {
  const data = await spotifyApi('GET', '/me');
  return {
    name: data.display_name,
    email: data.email,
    country: data.country,
    product: data.product, // free, premium, etc
    followers: data.followers?.total || 0,
    image: data.images?.[0]?.url || '',
  };
}

// ── Liked Songs ──

async function saveTracks(trackIds) {
  await spotifyApi('PUT', '/me/tracks', { ids: trackIds });
  return { success: true, action: 'save' };
}

async function removeSavedTracks(trackIds) {
  await spotifyApi('DELETE', '/me/tracks', { ids: trackIds });
  return { success: true, action: 'remove' };
}

async function checkSavedTracks(trackIds) {
  const data = await spotifyApi('GET', '/me/tracks/contains', null, { ids: trackIds.join(',') });
  return data; // array of booleans
}

// ── Create Playlist ──

async function createPlaylist(name, description = '', isPublic = false) {
  const profile = await getProfile();
  const userId = profile.name; // en realidad necesitamos el ID
  const me = await spotifyApi('GET', '/me');
  const data = await spotifyApi('POST', `/users/${me.id}/playlists`, {
    name,
    description,
    public: isPublic,
  });
  return {
    id: data.id,
    name: data.name,
    uri: data.uri,
    url: data.external_urls?.spotify || '',
  };
}

async function addTracksToPlaylist(playlistId, uris) {
  await spotifyApi('POST', `/playlists/${playlistId}/tracks`, { uris });
  return { success: true };
}

// ── Get User Playlists ──

async function getMyPlaylists(limit = 20) {
  const data = await spotifyApi('GET', '/me/playlists', null, { limit });
  return (data.items || []).map((p, i) => ({
    position: i + 1,
    name: p.name,
    tracks: p.tracks?.total || 0,
    uri: p.uri,
    owner: p.owner?.display_name || '',
  }));
}

// ── Get Artist Info ──

async function getArtist(artistId) {
  const data = await spotifyApi('GET', `/artists/${artistId}`);
  return {
    name: data.name,
    genres: data.genres || [],
    followers: data.followers?.total || 0,
    popularity: data.popularity,
    image: data.images?.[0]?.url || '',
    uri: data.uri,
  };
}

async function getArtistTopTracks(artistId) {
  const data = await spotifyApi('GET', `/artists/${artistId}/top-tracks`, null, { market: 'MX' });
  return (data.tracks || []).map((t, i) => ({
    position: i + 1,
    name: t.name,
    album: t.album?.name || '',
    uri: t.uri,
    popularity: t.popularity,
  }));
}

// ── New Releases ──

async function getNewReleases(limit = 10) {
  const data = await spotifyApi('GET', '/browse/new-releases', null, { limit, country: 'MX' });
  return (data.albums?.items || []).map((a, i) => ({
    position: i + 1,
    name: a.name,
    artists: a.artists.map(ar => ar.name).join(', '),
    releaseDate: a.release_date,
    uri: a.uri,
  }));
}

// ── Featured Playlists ──

async function getFeaturedPlaylists(limit = 10) {
  const data = await spotifyApi('GET', '/browse/featured-playlists', null, {
    limit,
    country: 'MX',
    locale: 'es_MX',
  });
  return {
    message: data.message || '',
    playlists: (data.playlists?.items || []).map((p, i) => ({
      position: i + 1,
      name: p.name,
      description: p.description || '',
      tracks: p.tracks?.total || 0,
      uri: p.uri,
    })),
  };
}

// ── Available Genres ──

async function getAvailableGenres() {
  const data = await spotifyApi('GET', '/recommendations/available-genre-seeds');
  return data.genres || [];
}

// ── Check connection ──

function isConnected() {
  const { accessToken, refreshToken } = getTokens();
  const { clientId, clientSecret } = getCredentials();
  return Boolean(clientId && clientSecret && (accessToken || refreshToken));
}

module.exports = {
  // Connection
  isConnected,
  getValidToken,
  refreshAccessToken,
  // Playback
  play,
  pause,
  next,
  previous,
  setVolume,
  setShuffle,
  setRepeat,
  seek,
  getNowPlaying,
  // Queue
  addToQueue,
  getQueue,
  // Search
  search,
  playBySearch,
  // Devices
  getDevices,
  transferPlayback,
  // User data
  getProfile,
  getTopTracks,
  getTopArtists,
  getRecentlyPlayed,
  getRecommendations,
  // Library
  saveTracks,
  removeSavedTracks,
  checkSavedTracks,
  // Playlists
  createPlaylist,
  addTracksToPlaylist,
  getMyPlaylists,
  // Browse
  getNewReleases,
  getFeaturedPlaylists,
  getAvailableGenres,
  // Artists
  getArtist,
  getArtistTopTracks,
};
