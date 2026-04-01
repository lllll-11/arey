const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

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

function getStoredGoogleRefreshToken() {
  const data = readIntegrations();
  return data?.google?.refreshToken || '';
}

function setStoredGoogleRefreshToken(refreshToken) {
  const data = readIntegrations();
  data.google = {
    ...(data.google || {}),
    refreshToken,
    updatedAt: new Date().toISOString(),
  };
  writeIntegrations(data);
}

function isGoogleConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    (process.env.GOOGLE_REFRESH_TOKEN || getStoredGoogleRefreshToken())
  );
}

function getCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || getStoredGoogleRefreshToken();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Calendar no configurado. Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REFRESH_TOKEN');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

function getCalendarId() {
  return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

async function listEvents({ timeMin, timeMax, maxResults = 20 } = {}) {
  const calendar = getCalendarClient();

  const response = await calendar.events.list({
    calendarId: getCalendarId(),
    timeMin: timeMin || new Date().toISOString(),
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return response.data.items || [];
}

async function createEvent({ summary, description, start, end, timeZone }) {
  if (!summary || !start || !end) {
    throw new Error('Campos requeridos: summary, start, end');
  }

  const calendar = getCalendarClient();

  const response = await calendar.events.insert({
    calendarId: getCalendarId(),
    requestBody: {
      summary,
      description: description || '',
      start: {
        dateTime: start,
        timeZone: timeZone || process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Mexico_City',
      },
      end: {
        dateTime: end,
        timeZone: timeZone || process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Mexico_City',
      },
    },
  });

  return response.data;
}

async function deleteEvent(eventId) {
  if (!eventId) {
    throw new Error('eventId es requerido');
  }

  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: getCalendarId(),
    eventId,
  });
}

async function updateEvent(eventId, { summary, description, start, end, timeZone }) {
  if (!eventId) {
    throw new Error('eventId es requerido');
  }

  const calendar = getCalendarClient();
  const requestBody = {};

  if (summary) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;
  if (start) {
    requestBody.start = {
      dateTime: start,
      timeZone: timeZone || process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Mexico_City',
    };
  }
  if (end) {
    requestBody.end = {
      dateTime: end,
      timeZone: timeZone || process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Mexico_City',
    };
  }

  const response = await calendar.events.patch({
    calendarId: getCalendarId(),
    eventId,
    requestBody,
  });

  return response.data;
}

module.exports = {
  listEvents,
  createEvent,
  deleteEvent,
  updateEvent,
  isGoogleConfigured,
  setStoredGoogleRefreshToken,
};
