const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { headerFetcher } = require('./header-fetcher');

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// API Key for authentication
const API_KEY = process.env.API_KEY || 'your-secret-api-key-here';

// Load proxies from JSON file if it exists
let residentialProxies = [];
const PROXY_FILE_PATH = path.join(__dirname, 'proxies.json');

function loadProxies() {
  try {
    if (fs.existsSync(PROXY_FILE_PATH)) {
      const data = fs.readFileSync(PROXY_FILE_PATH, 'utf8');
      const parsedData = JSON.parse(data);
      residentialProxies = parsedData.proxies || [];
      console.log(`[INFO] Loaded ${residentialProxies.length} proxies from proxies.json`);
    } else {
      console.log('[WARNING] proxies.json not found, using default proxies');
    }
  } catch (error) {
    console.error('[ERROR] Failed to load proxies:', error.message);
  }
}

// Authentication middleware
function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key'
    });
  }
  
  next();
}

// API endpoint to fetch headers
app.get('/api/headers', authenticateApiKey, async (req, res) => {
  try {
    console.log('[INFO] Received request for headers');
    
    // Get event ID from query or use default
    const eventId = req.query.eventId || '00006142CB7477BC';
    console.log(`[INFO] Using event ID: ${eventId}`);
    
    // Call the headerFetcher function with eventId and proxies
    const result = await headerFetcher(eventId, residentialProxies);
    
    if (result && result.success) {
      res.json({
        success: true,
        headers: result.headers
      });
    } else {
      res.status(500).json({
        success: false,
        error: result ? result.error : 'Unknown error occurred'
      });
    }
  } catch (error) {
    console.error('[ERROR] Error handling request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Load proxies on startup
loadProxies();

// Start the server
app.listen(PORT, () => {
  console.log(`[INFO] Server running on port ${PORT}`);
});